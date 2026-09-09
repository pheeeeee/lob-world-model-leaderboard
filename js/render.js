/* Pure DOM builders - the markup half of the site.
 *
 * Every function here is a direct port of the corresponding piece of the
 * backend's src/leaderboard_site/render.py, so these sql.js-driven pages render
 * the same visual result the Python one-shot renderer produced: metric chips,
 * stat tiles, the provenance block, the leaderboard table (magnitude bars,
 * "best" chips, rank, model meta, "about this model"), the per-side and
 * per-ticker breakdowns, the datasets table and the run log.
 *
 * These functions are PURE: they take plain objects (assembled in main.js from
 * the database) and return DOM nodes. They never fetch, never query, never
 * touch the document outside the nodes they create. Text goes in through
 * textContent, this port's equivalent of the Python renderer's html.escape.
 *
 * Exposed on window: fmt, shortHash, metricLabel, table, leaderboardTable,
 * sidesTable, perTickerTables, provenanceBlock, datasetsTable, runsTable,
 * runDetail, makeSortable, emptyState, statTiles, metricChips.
 */

var EM_DASH = "—";

/* ------------------------------------------------------------------ atoms -- */

/** Append a child / array of children / text to a node. */
function append(node, children) {
  if (children === null || children === undefined || children === false) return node;
  if (Array.isArray(children)) {
    children.forEach(function (c) { append(node, c); });
    return node;
  }
  node.appendChild(children instanceof Node
    ? children
    : document.createTextNode(String(children)));
  return node;
}

/**
 * Create an element. `attrs.text` sets textContent (escaping); `attrs.dataset`
 * sets data-* keys; every other key becomes an attribute. Null/undefined/false
 * attribute values are skipped so callers can write conditionals inline.
 */
function el(tag, attrs, children) {
  var node = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === "text") node.textContent = String(v);
      else if (k === "dataset") Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; });
      else node.setAttribute(k, String(v));
    });
  }
  return append(node, children);
}

/** <span class="mono">text</span> */
function mono(text, extraClass) {
  return el("span", { "class": "mono" + (extraClass ? " " + extraClass : ""), text: text });
}

/* ------------------------------------------------------------- formatting -- */

/** Significant-digit formatting, printf %g style (the fallback number format). */
function significant(value, digits) {
  if (value === 0) return "0";
  var exp = Math.floor(Math.log10(Math.abs(value)));
  if (exp < -4 || exp >= digits) {
    return value.toExponential(digits - 1)
      .replace(/\.?0+e/, "e")
      .replace(/e([+-])(\d)$/, "e$10$2");
  }
  var s = value.toFixed(Math.max(0, digits - 1 - exp));
  if (s.indexOf(".") >= 0) s = s.replace(/\.?0+$/, "");
  return s;
}

/**
 * Format one metric value for display, by the metric's registered `unit`:
 * "fraction" -> percentage with 1 decimal ("28.4%"); "ticks" -> 2 decimals;
 * anything else -> 4 significant digits. Missing values render as an em dash.
 */
function fmt(value, unit) {
  if (value === null || value === undefined || value === "") return EM_DASH;
  var v = Number(value);
  if (!isFinite(v)) return EM_DASH;
  if (unit === "fraction") return (v * 100).toFixed(1) + "%";
  if (unit === "ticks") return v.toFixed(2);
  return significant(v, 4);
}

/** "sha256:abcdef..." -> the first 12 hex characters. */
function shortHash(h) {
  if (!h) return "";
  var s = String(h);
  return (s.indexOf("sha256:") === 0 ? s.slice(7) : s).slice(0, 12);
}

/**
 * Column label for a metric: "<metric_id> (<unit> - <axis>)".
 * AXIS_HINT is a purely cosmetic annotation carried over from the Python
 * renderer; unknown metrics simply get no suffix, so nothing about WHICH
 * metrics exist is hard-coded - that always comes from the `metrics` table.
 */
var AXIS_HINT = { sided_w1: "shape", norm_total_volume_error: "scale" };
function metricLabel(m) {
  var axis = AXIS_HINT[m.metric_id];
  return m.metric_id + " (" + (m.unit || "") + (axis ? " · " + axis : "") + ")";
}

/* ---------------------------------------------------------------- tables --- */

/** One <th>. spec: string, or {label, num, nosort, title, style}. */
function headerCell(spec) {
  var s = (typeof spec === "string") ? { label: spec } : (spec || {});
  var cls = (s.num ? "num " : "") + (s.nosort ? "nosort" : "");
  return el("th", {
    "class": cls.trim() || null,
    title: s.title || null,
    style: s.style || null,
    text: s.label
  });
}

/** One <td>. spec: {num, v (the data-v sort key), cls, style}. */
function cell(spec, children) {
  var s = spec || {};
  var cls = (s.num ? "num " : "") + (s.cls || "");
  return el("td", {
    "class": cls.trim() || null,
    style: s.style || null,
    dataset: (s.v === undefined ? undefined : { v: s.v === null ? "" : String(s.v) })
  }, children);
}

/**
 * A sortable table inside a card. `head` = array of header specs,
 * `rows` = array of arrays of <td> nodes (or of ready-made <tr> nodes).
 */
function table(head, rows) {
  var tbl = el("table", { "data-sortable": "" }, [
    el("thead", null, el("tr", null, head.map(headerCell))),
    el("tbody", null, rows.map(function (r) {
      return (r instanceof Node) ? r : el("tr", null, r);
    }))
  ]);
  makeSortable(tbl);
  return el("div", { "class": "tablecard" }, tbl);
}

/** Click-to-sort on every non-.nosort header. Ported from render.py's _JS. */
function makeSortable(tbl) {
  var ths = tbl.querySelectorAll("thead th");
  ths.forEach(function (th, col) {
    if (th.classList.contains("nosort")) return;
    th.addEventListener("click", function () {
      var tbody = tbl.querySelector("tbody");
      var rows = Array.prototype.slice.call(tbody.rows);
      var dir = th.dataset.dir === "asc" ? -1 : 1;
      ths.forEach(function (h) {
        delete h.dataset.dir;
        var a = h.querySelector(".arrow");
        if (a) a.remove();
      });
      th.dataset.dir = dir === 1 ? "asc" : "desc";
      th.appendChild(el("span", {
        "class": "arrow", text: dir === 1 ? " ↑" : " ↓"
      }));
      rows.sort(function (a, b) {
        var x = a.cells[col] ? a.cells[col].dataset.v : undefined;
        var y = b.cells[col] ? b.cells[col].dataset.v : undefined;
        var nx = parseFloat(x), ny = parseFloat(y);
        if (!isNaN(nx) && !isNaN(ny)) return (nx - ny) * dir;
        if (x === undefined || x === "") return 1;
        if (y === undefined || y === "") return -1;
        return String(x).localeCompare(String(y)) * dir;
      });
      rows.forEach(function (r) { tbody.appendChild(r); });
    });
  });
  return tbl;
}

/* ------------------------------------------------------------ page pieces -- */

/** "<metric> v<version> - lower is better" chips under the masthead. */
function metricChips(metrics) {
  return el("div", { "class": "chips" }, metrics.map(function (m) {
    return el("span", { "class": "chip" }, [
      el("b", { text: m.metric_id }),
      " v" + (m.semantic_version || "?") + " · " +
        String(m.direction || "").replace(/_/g, " ")
    ]);
  }));
}

/** The headline tiles. `tiles` = [{k, v, d}, ...]. */
function statTiles(tiles) {
  return el("div", { "class": "tiles" }, tiles.map(function (t) {
    return el("div", { "class": "tile" }, [
      el("div", { "class": "k", text: t.k }),
      el("div", { "class": "v", text: t.v }),
      el("div", { "class": "d", text: t.d })
    ]);
  }));
}

/** The no-data state: shown whenever the backend has not pushed an export. */
function emptyState(msg, detail) {
  return el("div", { "class": "empty" }, [
    el("h3", { text: "No data published yet" }),
    el("p", { text: msg }),
    detail ? el("p", null, detail) : null
  ]);
}

/**
 * "Test-set source" - where a board's evaluation windows come from. Every value
 * is copied from the frozen bundle's manifest (dataset_provenance) and from the
 * registry entries of its raw sources (datasets); nothing here is inferred.
 */
function provenanceBlock(ds) {
  var pv = ds.provenance || {};
  var sources = ds.sources || [];
  var rows = [];
  var add = function (label, value) {
    if (value !== null && value !== undefined && value !== "") rows.push([label, value]);
  };

  if (pv.task) add("Task", [mono(pv.task), pv.note ? " " + EM_DASH + " " + pv.note : null]);

  if (sources.length) {
    add("Raw source data", sources.map(function (src) {
      var bits = [el("b", { text: src.dataset_id })];
      [src.kind, src.date, src.symbols].forEach(function (x) {
        if (x) { bits.push(" · "); bits.push(x); }
      });
      var line = el("div", { style: "margin-bottom:6px" }, bits);
      if (src.source) append(line, [el("br"), src.source]);
      if (src.path) append(line, [el("br"), mono(src.path, "hash")]);
      if (!src.registered) {
        append(line, [" ", el("span", {
          "class": "pill", text: "not in registry/datasets.yml"
        })]);
      }
      return line;
    }));
  }

  add("Bundle built from", pv.source);
  if (pv.flow_engine) add("Flow engine", mono(pv.flow_engine));

  var units = [pv.price_tick, pv.flow_volume].filter(Boolean);
  if (units.length) add("Units", units.join(" · "));

  if (pv.split_note || pv.split_name) {
    add("Split", [
      pv.split_name ? mono(pv.split_name) : null,
      (pv.split_name && pv.split_note) ? " " + EM_DASH + " " : null,
      pv.split_note || null
    ]);
  }
  if (pv.condition_ref_grammar) {
    var schemas = pv.input_schemas || [];
    add("Conditioning ref", [
      mono(pv.condition_ref_grammar),
      schemas.length ? " · serves " + schemas.join(", ") : null
    ]);
  }
  if (pv.builder_script) {
    add("Builder", [
      mono(pv.builder_script),
      pv.created_at_utc ? " · frozen " + String(pv.created_at_utc).slice(0, 10) : null
    ]);
  }
  var pinned = pv.pinned_files;
  if (pinned && pinned.count) {
    var ex = pinned.example || {};
    var name = ex.file || ex.path || "";
    add("Pinned inputs", [
      pinned.count + " " + String(pinned.kind || "").replace(/_/g, " ") +
        " with sha256 recorded in the bundle manifest",
      name ? " " + EM_DASH + " e.g. " : null,
      name ? mono(String(name) + " " + shortHash(String(ex.sha256 || "")) + "…", "hash") : null
    ]);
  }
  if (pv.bundle_path) {
    add("Frozen bundle", [
      mono(pv.bundle_path), " · ",
      (ds.sample_count || EM_DASH) + " windows · content hash ",
      mono(shortHash(ds.content_hash), "hash"),
      " · immutable (SUCCESS + SHA256SUMS)"
    ]);
  }
  if (!rows.length) return null;

  return el("details", { "class": "prov", open: "" }, [
    el("summary", null, [
      "Test-set source",
      el("span", { "class": "hint", text: "where these evaluation windows come from" })
    ]),
    el("dl", null, rows.map(function (r) {
      return [el("dt", { text: r[0] }), el("dd", null, r[1])];
    }))
  ]);
}

/** The board: rows = models (already ranked), columns = metrics. */
function leaderboardTable(ds, metrics) {
  var best = {}, worst = {};
  metrics.forEach(function (m) {
    var defined = ds.models
      .map(function (c) { return c.values[m.metric_id]; })
      .filter(function (v) { return v !== null && v !== undefined; });
    if (defined.length) {
      best[m.metric_id] = m.direction === "higher_is_better"
        ? Math.max.apply(null, defined)
        : Math.min.apply(null, defined);
      worst[m.metric_id] = Math.max.apply(null, defined.map(Math.abs)) || 1.0;
    } else {
      best[m.metric_id] = null;
      worst[m.metric_id] = 1.0;
    }
  });

  var head = [{ label: "#", num: true, nosort: true, style: "width:3rem" }, "Model"]
    .concat(metrics.map(function (m) {
      return { label: metricLabel(m), num: true, title: m.summary || "" };
    }))
    .concat([{ label: "Windows", num: true }, { label: "Draws", num: true }]);

  var rows = ds.models.map(function (c, i) {
    var rank = i + 1;
    var tds = [
      cell({ num: true, cls: "rank", v: rank }, String(rank)),
      cell({ v: c.model_name }, [
        el("span", { "class": "modelname", text: c.model_name }),
        el("div", { "class": "modelmeta mono", text: c.model_id }),
        el("div", { "class": "modelmeta", text: c.kind + " · family " + c.family }),
        c.description
          ? el("details", { "class": "desc" }, [
              el("summary", { text: "about this model" }),
              el("p", { text: c.description })
            ])
          : null
      ])
    ];
    metrics.forEach(function (m) {
      var v = c.values[m.metric_id];
      if (v === null || v === undefined) {
        tds.push(cell({ num: true, v: "" }, EM_DASH));
        return;
      }
      var isBest = best[m.metric_id] !== null && v === best[m.metric_id];
      var width = Math.max(4, Math.round(100 * Math.abs(v) / worst[m.metric_id]));
      tds.push(cell({ num: true, v: v }, el("div", { "class": "cellbar" }, [
        el("span", { "class": "bartrack" },
          el("span", { "class": "barfill", style: "width:" + width + "%" })),
        el("span", { style: isBest ? "font-weight:650" : null, text: fmt(v, m.unit) }),
        isBest ? el("span", { "class": "best-chip", text: "best" }) : null
      ])));
    });
    tds.push(cell({ num: true, v: c.n_samples }, String(c.n_samples)));
    tds.push(cell({ num: true, v: c.n_draws }, String(c.n_draws)));
    return tds;
  });
  return table(head, rows);
}

/** Per-side breakdown: the metrics' *_bid / *_ask statistics, per model. */
function sidesTable(ds, metrics) {
  var stats = [];
  metrics.forEach(function (m) {
    (m.outputs || []).forEach(function (out) {
      if (/_(bid|ask)$/.test(out)) stats.push({ statistic: out, unit: m.unit });
    });
  });
  if (!stats.length) return null;

  var head = ["Model"].concat(stats.map(function (s) {
    return { label: s.statistic, num: true };
  }));
  var rows = ds.models.map(function (c) {
    var tds = [cell({ v: c.model_name },
      el("span", { "class": "modelname", text: c.model_name }))];
    stats.forEach(function (s) {
      var v = c.side_values[s.statistic];
      tds.push(cell({ num: true, v: (v === null || v === undefined) ? "" : v },
        fmt(v, s.unit)));
    });
    return tds;
  });
  return table(head, rows);
}

/**
 * One collapsible sortable table per metric: rows = symbols, columns = models
 * in board order, cell = that symbol's mean per-sample value. Row-best is bold.
 * Returns null for single-symbol datasets (nothing to compare across).
 */
function perTickerTables(ds, metrics) {
  if (!ds.tickers || ds.tickers.length < 2) return null;
  var order = ds.models.map(function (c) { return c.model_id; });
  var nameOf = {};
  ds.models.forEach(function (c) { nameOf[c.model_id] = c.model_name; });

  var parts = [];
  metrics.forEach(function (m) {
    var byModel = (ds.per_ticker || {})[m.metric_id];
    if (!byModel) return;
    var cols = order.filter(function (mid) { return mid in byModel; });
    if (!cols.length) return;

    var head = ["Ticker"].concat(cols.map(function (mid) {
      return { label: nameOf[mid] || mid, num: true };
    }));
    var rows = ds.tickers.map(function (sym) {
      var vals = cols.map(function (mid) {
        var v = byModel[mid][sym];
        return (v === null || v === undefined) ? null : v;
      });
      var defined = vals.filter(function (v) { return v !== null; });
      var best = defined.length
        ? (m.direction === "higher_is_better"
            ? Math.max.apply(null, defined)
            : Math.min.apply(null, defined))
        : null;
      var tds = [cell({ v: sym }, el("span", { "class": "modelname", text: sym }))];
      vals.forEach(function (v) {
        tds.push(cell({
          num: true,
          v: v === null ? "" : v,
          style: (v !== null && v === best) ? "font-weight:650" : null
        }, fmt(v, m.unit)));
      });
      return tds;
    });
    parts.push(el("details", { "class": "desc" }, [
      el("summary", {
        text: metricLabel(m) + " " + EM_DASH + " per ticker (" +
          ds.tickers.length + " symbols)"
      }),
      table(head, rows)
    ]));
  });
  return parts.length ? el("div", null, parts) : null;
}

/**
 * The registry dataset table. `opts.showKind` adds Kind/Role columns - the
 * datasets page lists raw sources too, the board page lists only test bundles.
 */
function datasetsTable(entries, opts) {
  var options = opts || {};
  var head = ["Dataset"];
  if (options.showKind) head.push("Kind", "Role");
  head.push({ label: "Windows", num: true }, "Frozen",
    { label: "Content hash", nosort: true },
    { label: "Source data", nosort: true },
    { label: "What it is", nosort: true });

  var rows = entries.map(function (d) {
    var tds = [cell({ cls: "mono", v: d.dataset_id }, [
      d.dataset_id,
      d.on_board ? el("span", { "class": "best-chip", text: "on board" }) : null
    ])];
    if (options.showKind) {
      tds.push(cell({ v: d.kind || "" }, d.kind || EM_DASH));
      tds.push(cell({ v: d.role || "" },
        d.role ? el("span", { "class": "pill", text: d.role }) : EM_DASH));
    }
    tds.push(cell({ num: true, v: d.sample_count || "" },
      d.sample_count ? String(d.sample_count) : EM_DASH));
    tds.push(cell({ cls: "mono hash", v: d.added || "" }, d.added || EM_DASH));
    tds.push(cell({ cls: "mono hash" }, shortHash(d.content_hash)));
    tds.push(cell({ style: "max-width:30ch" }, [
      (d.source_dataset_ids || []).map(function (x) {
        return el("div", { "class": "mono", style: "font-size:.82rem", text: x });
      }),
      d.source ? el("div", { "class": "hash", text: d.source }) : null
    ]));
    tds.push(cell({ style: "max-width:46ch" }, d.summary || ""));
    return tds;
  });
  return table(head, rows);
}

/**
 * The run log. When `onSelect` is given the rows become clickable (runs.html
 * uses that to open a run's detail panel).
 */
function runsTable(runs, onSelect) {
  var head = ["Run", "Created", "Study",
    { label: "Models", num: true }, { label: "Metrics", num: true },
    "Status", { label: "Content hash", nosort: true }];

  var rows = runs.map(function (r) {
    var tds = [
      cell({ cls: "mono", v: r.evaluation_run_id }, r.evaluation_run_id),
      cell({ cls: "mono", v: r.created_at_utc }, r.created_at_utc),
      cell({ cls: "mono", v: r.study_id }, r.study_id),
      cell({ num: true, v: r.n_inputs }, String(r.n_inputs)),
      cell({ num: true, v: r.n_metrics }, String(r.n_metrics)),
      cell({ v: r.status }, el("span", {
        "class": "pill" + (r.status === "ok" || r.status === "completed" ? " ok" : ""),
        text: r.status
      })),
      cell({ cls: "mono hash" }, shortHash(r.content_hash))
    ];
    var tr = el("tr", null, tds);
    if (onSelect) {
      tr.className = "clickable";
      tr.tabIndex = 0;
      tr.setAttribute("role", "button");
      tr.setAttribute("title", "show this run's results");
      tr.addEventListener("click", function () { onSelect(r, tr); });
      tr.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onSelect(r, tr); }
      });
    }
    return tr;
  });
  return table(head, rows);
}

/**
 * One run, expanded: its provenance fields (study, git commit, command, ...),
 * the metric versions/parameters it ran, and its scored rows pivoted to
 * model x metric.
 */
function runDetail(run, runMetricRows, resultRows, metrics) {
  var facts = [
    ["Run", mono(run.evaluation_run_id)],
    ["Study", mono(run.study_id)],
    ["Created", run.created_at_utc],
    ["Status", el("span", {
      "class": "pill" + (run.status === "ok" || run.status === "completed" ? " ok" : ""),
      text: run.status
    })],
    ["Artifacts", mono("evaluation_results/" + run.path)],
    ["Content hash", mono(shortHash(run.content_hash), "hash")],
    ["Git commit", run.git_commit
      ? [mono(shortHash(run.git_commit), "hash"),
         run.git_dirty ? [" ", el("span", { "class": "pill", text: "dirty tree" })] : null]
      : null],
    ["Command", run.command ? mono(run.command) : null],
    ["Pipeline schema", run.pipeline_schema_version || null]
  ].filter(function (r) { return r[1] !== null && r[1] !== undefined; });

  var card = el("div", { "class": "detailcard" }, [
    el("h3", null, ["Run " + EM_DASH + " ", mono(run.evaluation_run_id)]),
    el("details", { "class": "prov", open: "" }, [
      el("summary", null, [
        "Run provenance",
        el("span", { "class": "hint", text: "recorded in the run manifest" })
      ]),
      el("dl", null, facts.map(function (f) {
        return [el("dt", { text: f[0] }), el("dd", null, f[1])];
      }))
    ])
  ]);

  if (runMetricRows.length) {
    append(card, el("h4", { text: "Metric versions used" }));
    append(card, table(
      ["Metric", "Semantic version", { label: "Parameters hash", nosort: true }],
      runMetricRows.map(function (m) {
        return [
          cell({ cls: "mono", v: m.metric_id }, m.metric_id),
          cell({ cls: "mono", v: m.semantic_version }, m.semantic_version),
          cell({ cls: "mono hash" }, shortHash(m.parameters_hash))
        ];
      })));
  }

  // Pivot the run's results: one row per (dataset, model), one column per metric.
  // Column order follows the `metrics` table, with any unregistered metric the
  // run happened to score appended after it.
  var unitOf = {}, order = [];
  metrics.forEach(function (m) { unitOf[m.metric_id] = m.unit; order.push(m.metric_id); });
  resultRows.forEach(function (r) {
    if (order.indexOf(r.metric_id) < 0) order.push(r.metric_id);
  });
  var byRow = {};
  resultRows.forEach(function (r) {
    var key = r.test_dataset_id + " " + r.model_id;
    if (!byRow[key]) {
      byRow[key] = {
        test_dataset_id: r.test_dataset_id, model_id: r.model_id,
        model_name: r.model_name, n_test_samples: r.n_test_samples,
        n_generation_draws: r.n_generation_draws, row_status: r.row_status,
        values: {}
      };
    }
    byRow[key].values[r.metric_id] = r.value;
  });
  var pivoted = Object.keys(byRow).sort().map(function (k) { return byRow[k]; });

  if (pivoted.length) {
    append(card, el("h4", { text: "Scored rows" }));
    var head = ["Test dataset", "Model"]
      .concat(order.map(function (mid) { return { label: mid, num: true }; }))
      .concat([{ label: "Windows", num: true }, { label: "Draws", num: true }, "Status"]);
    append(card, table(head, pivoted.map(function (p) {
      var tds = [
        cell({ cls: "mono", v: p.test_dataset_id }, p.test_dataset_id),
        cell({ v: p.model_name }, [
          el("span", { "class": "modelname", text: p.model_name }),
          el("div", { "class": "modelmeta mono", text: p.model_id })
        ])
      ];
      order.forEach(function (mid) {
        var v = p.values[mid];
        tds.push(cell({ num: true, v: (v === null || v === undefined) ? "" : v },
          fmt(v, unitOf[mid])));
      });
      tds.push(cell({ num: true, v: p.n_test_samples }, String(p.n_test_samples)));
      tds.push(cell({ num: true, v: p.n_generation_draws }, String(p.n_generation_draws)));
      tds.push(cell({ v: p.row_status }, el("span", {
        "class": "pill" + (p.row_status === "ok" ? " ok" : ""), text: p.row_status
      })));
      return tds;
    })));
  }
  return card;
}

window.append = append;
window.el = el;
window.mono = mono;
window.fmt = fmt;
window.shortHash = shortHash;
window.metricLabel = metricLabel;
window.table = table;
window.makeSortable = makeSortable;
window.metricChips = metricChips;
window.statTiles = statTiles;
window.emptyState = emptyState;
window.provenanceBlock = provenanceBlock;
window.leaderboardTable = leaderboardTable;
window.sidesTable = sidesTable;
window.perTickerTables = perTickerTables;
window.datasetsTable = datasetsTable;
window.runsTable = runsTable;
window.runDetail = runDetail;
