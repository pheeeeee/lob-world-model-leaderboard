/* Page wiring: load the published database, assemble the board, render.
 *
 * One script serves all three pages; `document.body.dataset.page` selects the
 * renderer ('index' | 'runs' | 'datasets'). Everything is read from
 * data/evaluation.sqlite through js/queries.js - no metric, model or dataset id
 * is written into the site. When the backend has not pushed an export yet
 * (data/export_meta.json 404s), every page shows the empty state instead of
 * breaking.
 *
 * The assembly here mirrors the backend's src/leaderboard_site/build.py: the
 * board views already implement "latest run wins", so this file only pivots the
 * long rows into rows = models / columns = metrics, resolves each test bundle's
 * provenance and raw sources, and ranks by the first metric in `metrics` order.
 */

/* ----------------------------------------------------------------- utils -- */

function parseJson(text, fallback) {
  if (text === null || text === undefined || text === "") return fallback;
  try {
    var v = JSON.parse(text);
    return (v === null || v === undefined) ? fallback : v;
  } catch (err) {
    return fallback;
  }
}

/**
 * The "about this model" text under a board row - the same join the Python
 * builder does: notes + pinned defaults + training set + selection rule.
 */
function modelDescription(entry) {
  if (!entry) return "";
  var parts = [];
  if (entry.notes) parts.push(String(entry.notes).trim());
  if (entry.defaults) parts.push("Pinned defaults: " + entry.defaults + ".");
  if (entry.train_dataset) parts.push("Trained on " + entry.train_dataset + ".");
  if (entry.selection_rule) parts.push("Selection: " + entry.selection_rule + ".");
  return parts.join(" ");
}

function indexBy(rows, key) {
  var out = {};
  rows.forEach(function (r) { out[r[key]] = r; });
  return out;
}

function numberOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

/* -------------------------------------------------------------- assembly -- */

/** Read every table/view the pages need and shape it for js/render.js. */
function assemble(db) {
  var metrics = query(db, QUERIES.metrics).map(function (m) {
    m.outputs = parseJson(m.outputs_json, []);
    return m;
  });
  var boardRuns = query(db, QUERIES.boardRuns);
  var boardRows = query(db, QUERIES.board);
  var statRows = query(db, QUERIES.boardStatistics);
  var tickerRows = query(db, QUERIES.boardPerTicker);
  var datasetRows = query(db, QUERIES.datasets);
  var provRows = query(db, QUERIES.datasetProvenance);
  var modelRows = query(db, QUERIES.models);
  var runRows = query(db, QUERIES.runs);

  var datasetById = indexBy(datasetRows, "dataset_id");
  var provById = indexBy(provRows, "dataset_id");
  var modelById = indexBy(modelRows, "model_id");

  // registry entries of the raw datasets a bundle was built from
  var sourcesOf = function (entry) {
    return parseJson(entry && entry.source_dataset_ids_json, []).map(function (sid) {
      var e = datasetById[sid];
      return {
        dataset_id: String(sid),
        registered: !!e,
        kind: (e && e.kind) || "",
        path: (e && e.path) || "",
        source: (e && e.source) || "",
        date: (e && e.date) || "",
        symbols: (e && e.symbols) || "",
        summary: (e && e.summary) || ""
      };
    });
  };

  var datasets = boardRuns.map(function (br) {
    var did = br.test_dataset_id;
    var entry = datasetById[did] || {};
    var prov = provById[did];

    // rows = models (the board view already restricts to the current run)
    var cellsById = {}, cells = [];
    boardRows.forEach(function (r) {
      if (r.test_dataset_id !== did) return;
      var c = cellsById[r.model_id];
      if (!c) {
        var reg = modelById[r.model_id];
        c = cellsById[r.model_id] = {
          model_id: r.model_id,
          model_name: String(r.model_name),
          description: modelDescription(reg),
          kind: (reg && reg.kind) || "?",
          family: (reg && reg.model_family) || String(r.model_name),
          status: (reg && reg.status) || "?",
          n_samples: r.n_test_samples,
          n_draws: r.n_generation_draws,
          row_status: r.row_status,
          prediction_id: r.prediction_id,
          evaluation_run_id: r.evaluation_run_id,
          values: {},
          side_values: {}
        };
        metrics.forEach(function (m) { c.values[m.metric_id] = null; });
        cells.push(c);
      }
      c.values[r.metric_id] = numberOrNull(r.value);
    });

    // every statistic of this dataset's current run, per model (per-side table)
    statRows.forEach(function (s) {
      if (s.test_dataset_id !== did || s.status !== "ok") return;
      var c = cellsById[s.model_id];
      if (c) c.side_values[s.statistic] = numberOrNull(s.value);
    });

    // rank by the first metric (headline metric first in `metrics` order)
    var first = metrics.length ? metrics[0] : null;
    if (first) {
      var reverse = first.direction === "higher_is_better";
      cells.sort(function (a, b) {
        var av = a.values[first.metric_id], bv = b.values[first.metric_id];
        var an = (av === null || av === undefined), bn = (bv === null || bv === undefined);
        if (an !== bn) return an ? 1 : -1;
        var x = an ? 0 : av, y = bn ? 0 : bv;
        return reverse ? (y - x) : (x - y);
      });
    }

    // per-symbol means; only meaningful for multi-symbol datasets
    var symbols = {}, perTicker = {};
    var statOf = {};
    metrics.forEach(function (m) { statOf[m.primary_output] = m.metric_id; });
    tickerRows.forEach(function (t) {
      if (t.test_dataset_id !== did) return;
      symbols[t.symbol] = true;
      if (statOf[t.statistic] !== t.metric_id) return;   // headline statistic only
      var byModel = perTicker[t.metric_id] || (perTicker[t.metric_id] = {});
      var bySymbol = byModel[t.model_id] || (byModel[t.model_id] = {});
      bySymbol[t.symbol] = numberOrNull(t.mean_value);
    });
    var tickers = Object.keys(symbols).sort();

    return {
      dataset_id: did,
      summary: entry.summary || "",
      content_hash: entry.content_hash || "",
      sample_count: entry.sample_count,
      added: entry.added || "",
      run_id: br.evaluation_run_id,
      run_date: br.run_created_at_utc,
      study_id: br.study_id,
      models: cells,
      tickers: tickers.length > 1 ? tickers : [],
      per_ticker: perTicker,
      provenance: prov ? {
        bundle_path: entry.path || "",
        task: prov.task || "",
        note: prov.note || "",
        source: prov.source || "",
        flow_engine: prov.flow_engine || "",
        builder_script: prov.builder_script || "",
        created_at_utc: prov.created_at_utc || "",
        split_name: prov.split_name || "",
        split_note: prov.split_note || "",
        condition_ref_grammar: prov.condition_ref_grammar || "",
        price_tick: prov.price_tick || "",
        flow_volume: prov.flow_volume || "",
        input_schemas: parseJson(prov.input_schemas_json, []),
        pinned_files: prov.pinned_count
          ? { kind: prov.pinned_kind || "", count: prov.pinned_count,
              example: parseJson(prov.pinned_example_json, {}) }
          : null
      } : {},
      sources: sourcesOf(entry)
    };
  });

  var onBoard = {};
  datasets.forEach(function (d) { onBoard[d.dataset_id] = true; });
  var registry = datasetRows.map(function (e) {
    return {
      dataset_id: e.dataset_id,
      kind: e.kind || "",
      role: e.role || "",
      path: e.path || "",
      content_hash: e.content_hash || "",
      sample_count: e.sample_count,
      added: e.added || "",
      summary: e.summary || "",
      source_dataset_ids: parseJson(e.source_dataset_ids_json, []),
      source: sourcesOf(e).map(function (s) { return s.source; })
        .filter(Boolean).join("; "),
      on_board: !!onBoard[e.dataset_id]
    };
  });

  return {
    metrics: metrics, datasets: datasets, registry: registry, runs: runRows,
    provById: provById, datasetById: datasetById, sourcesOf: sourcesOf
  };
}

/* ------------------------------------------------------------ page: index -- */

function renderIndex(app, data) {
  var metrics = data.metrics;
  var nModels = data.datasets.reduce(function (n, d) {
    return Math.max(n, d.models.length);
  }, 0);
  var nWindows = data.datasets.reduce(function (n, d) {
    return n + (d.models.length ? (d.models[0].n_samples || 0) : 0);
  }, 0);

  app.appendChild(metricChips(metrics));
  app.appendChild(statTiles([
    { k: "Models on board", v: nModels, d: "registry/models.yml" },
    { k: "Eval windows", v: nWindows, d: "per frozen dataset" },
    { k: "Metrics", v: metrics.length, d: "registry/metrics.yml" },
    { k: "Completed runs", v: data.runs.length, d: "evaluation_results/" }
  ]));

  if (!data.datasets.length) {
    app.appendChild(emptyState(
      "The export contains no scored runs yet, so there is no board to show."));
  }

  var allLower = metrics.length && metrics.every(function (m) {
    return m.direction === "lower_is_better";
  });
  var rankNote = allLower
    ? "Lower is better on every current metric; bars show magnitude within each column."
    : "Each column is ranked by its registered direction; bars show magnitude within each column.";

  data.datasets.forEach(function (ds) {
    var section = el("section", null, [
      el("h2", null, ["Board — ", mono(ds.dataset_id)]),
      ds.summary ? el("p", { "class": "sectionnote", text: ds.summary }) : null,
      el("p", { "class": "sectionnote" }, [
        "Scored by run ", mono(ds.run_id), " (" + ds.run_date + "), study ",
        mono(ds.study_id), ". Dataset content hash ",
        el("span", { "class": "mono hash", text: shortHash(ds.content_hash) }),
        ". " + rankNote + " Click a column header to sort."
      ]),
      provenanceBlock(ds),
      leaderboardTable(ds, metrics)
    ]);

    var sides = sidesTable(ds, metrics);
    if (sides) {
      append(section, [
        el("h2", { style: "margin-top:26px", text: "Per-side breakdown" }),
        el("p", { "class": "sectionnote",
          text: "The same scores split into bid and ask components." }),
        sides
      ]);
    }
    var tickers = perTickerTables(ds, metrics);
    if (tickers) {
      append(section, [
        el("h2", { style: "margin-top:26px", text: "Per-ticker breakdown" }),
        el("p", { "class": "sectionnote",
          text: "Mean per-sample value per symbol from the current run (best per " +
                "row in bold). Click a metric to expand." }),
        tickers
      ]);
    }
    app.appendChild(section);
  });

  var testSets = data.registry.filter(function (d) { return d.role === "test"; });
  app.appendChild(el("section", null, [
    el("h2", { text: "Evaluation datasets" }),
    el("p", { "class": "sectionnote" }, [
      "Test datasets are immutable, content-hashed bundles; changing the " +
      "evaluation set means publishing a new bundle under a new id — old " +
      "scores keep pointing at the exact bytes they were computed on. ",
      el("a", { href: "datasets.html", text: "Every registered dataset →" })
    ]),
    datasetsTable(testSets)
  ]));

  app.appendChild(el("section", null, [
    el("h2", { text: "Evaluation runs" }),
    el("p", { "class": "sectionnote" }, [
      "Every completed scoring run, newest first. The boards above always show " +
      "each dataset’s latest run; older runs remain on disk, " +
      "checksum-verified. ",
      el("a", { href: "runs.html", text: "Open a run to see its results →" })
    ]),
    runsTable(data.runs)
  ]));
}

/* ------------------------------------------------------------- page: runs -- */

function renderRuns(app, data, db) {
  var section = el("section", null, [
    el("h2", { text: "Evaluation runs" }),
    el("p", { "class": "sectionnote",
      text: "Every completed scoring run, newest first. Select a run to see the " +
            "rows it scored, the metric versions it used, and the provenance " +
            "recorded in its manifest." })
  ]);
  var detail = el("div", { id: "run-detail" });

  if (!data.runs.length) {
    section.appendChild(emptyState("The export contains no evaluation runs."));
    app.appendChild(section);
    return;
  }

  var selected = null;
  var show = function (run, tr) {
    if (selected) selected.removeAttribute("aria-selected");
    selected = tr;
    tr.setAttribute("aria-selected", "true");
    detail.textContent = "";
    detail.appendChild(runDetail(
      run,
      query(db, QUERIES.runMetrics, [run.evaluation_run_id]),
      query(db, QUERIES.results, [run.evaluation_run_id]),
      data.metrics));
  };

  var tableCard = runsTable(data.runs, show);
  section.appendChild(tableCard);
  section.appendChild(detail);
  app.appendChild(section);

  // open the newest run so the page is never half empty
  var firstRow = tableCard.querySelector("tbody tr");
  if (firstRow) show(data.runs[0], firstRow);
}

/* --------------------------------------------------------- page: datasets -- */

function renderDatasets(app, data) {
  app.appendChild(el("section", null, [
    el("h2", { text: "Registered datasets" }),
    el("p", { "class": "sectionnote",
      text: "Every entry in registry/datasets.yml: the raw source archives and " +
            "the derived, content-hashed bundles built from them. Rows marked " +
            "“test” are the frozen evaluation sets the boards score on." }),
    data.registry.length
      ? datasetsTable(data.registry, { showKind: true })
      : emptyState("The export contains no registered datasets.")
  ]));

  var tests = data.registry.filter(function (d) { return d.role === "test"; });
  if (!tests.length) return;

  var section = el("section", null, [
    el("h2", { text: "Test-set provenance" }),
    el("p", { "class": "sectionnote",
      text: "Where each evaluation bundle comes from, copied from the bundle " +
            "manifest and the registry entries of its raw sources. Nothing " +
            "here is inferred." })
  ]);
  tests.forEach(function (d) {
    var entry = data.datasetById[d.dataset_id] || {};
    var prov = data.provById[d.dataset_id];
    var ds = {
      dataset_id: d.dataset_id,
      content_hash: d.content_hash,
      sample_count: d.sample_count,
      sources: data.sourcesOf(entry),
      provenance: prov ? {
        bundle_path: entry.path || "",
        task: prov.task || "",
        note: prov.note || "",
        source: prov.source || "",
        flow_engine: prov.flow_engine || "",
        builder_script: prov.builder_script || "",
        created_at_utc: prov.created_at_utc || "",
        split_name: prov.split_name || "",
        split_note: prov.split_note || "",
        condition_ref_grammar: prov.condition_ref_grammar || "",
        price_tick: prov.price_tick || "",
        flow_volume: prov.flow_volume || "",
        input_schemas: parseJson(prov.input_schemas_json, []),
        pinned_files: prov.pinned_count
          ? { kind: prov.pinned_kind || "", count: prov.pinned_count,
              example: parseJson(prov.pinned_example_json, {}) }
          : null
      } : {}
    };
    var block = provenanceBlock(ds);
    append(section, [
      el("h3", { style: "margin-top:22px" }, [mono(d.dataset_id),
        d.on_board ? el("span", { "class": "best-chip", text: "on board" }) : null]),
      block || el("p", { "class": "sectionnote",
        text: "No provenance block recorded for this bundle." })
    ]);
  });
  app.appendChild(section);
}

/* ------------------------------------------------------------------ boot -- */

/** The "export <hash12> - exported <date>" chip in every masthead. */
function renderExportChip(meta) {
  var slot = document.getElementById("export-chip");
  if (!slot || !meta) return;
  var hash = shortHash(meta.export_hash);
  var when = String(meta.exported_at_utc || "").replace("T", " ").slice(0, 16);
  slot.textContent = "";
  slot.appendChild(el("span", { "class": "chip" }, [
    "export ", el("b", { text: hash || "?" }),
    when ? " · exported " + when : null
  ]));
}

async function main() {
  var app = document.getElementById("app");
  var page = document.body.dataset.page;
  var loaded;
  try {
    loaded = await loadDb();
  } catch (err) {
    app.textContent = "";
    app.appendChild(emptyState(
      "The published database could not be loaded.", String(err)));
    return;
  }

  if (!loaded.db) {
    app.textContent = "";
    app.appendChild(emptyState(
      "The backend has not pushed an export yet, so there is nothing to show. " +
      "Data arrives when the cluster runs the publish step and pushes " +
      "data/evaluation.sqlite, data/board.json and data/export_meta.json.",
      el("span", { "class": "mono", text: "python -m evaluation_db publish" })));
    return;
  }

  // The JSON stamp is authoritative for cache-busting; the database carries the
  // same row, so fall back to it if the stamp is thin.
  var metaRows = query(loaded.db, QUERIES.exportMeta);
  renderExportChip(loaded.meta && loaded.meta.export_hash
    ? loaded.meta
    : (metaRows.length ? metaRows[0] : null));

  var data = assemble(loaded.db);
  app.textContent = "";
  if (page === "runs") renderRuns(app, data, loaded.db);
  else if (page === "datasets") renderDatasets(app, data);
  else renderIndex(app, data);
}

document.addEventListener("DOMContentLoaded", function () { main(); });
