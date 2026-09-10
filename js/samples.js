/* The Samples page: the pictures behind the board numbers.
 *
 * For ONE evaluation window it draws, as small multiples on identical axes and
 * ONE shared y scale: the INPUT histogram (the previous window's realized
 * order flow, which every model conditions on), the realized TARGET (the next
 * window), and each model's predicted draw - models in board order.
 *
 * Data contract - data/samples.json, written ONLY by the backend's publish step
 * (the same step that writes evaluation.sqlite / export_meta.json / board.json;
 * this site never edits it). Its ABSENCE (404) is the normal state of a repo
 * whose backend has not published samples yet and shows the empty state, never
 * an error. Shape (schema_version 1):
 *
 *   {schema_version, generated_at_utc, export_hash, draws_per_model, datasets:[
 *     {dataset_id, task, summary, content_hash, board_run_id, reference,
 *      views: {overview:{half_width_ticks,bin_ticks}, zoom:{...}},
 *      metrics:[{metric_id, primary_output, unit, direction}],
 *      models:[{model_id, model_name, family, kind, draws, prediction_id}],
 *                                                    // IN BOARD ORDER
 *      windows:[{sample_id, symbol, trading_date, window_index, ref_tick,
 *                tick_size, input: HIST, target: HIST,
 *                predictions: {<model_id>: {"<draw>": HIST, sample_metrics:{}}}}]}]}
 *
 *   HIST = {mass:{bid,ask},                       // shares
 *           overview:{bid:ARR, ask:ARR}, zoom:{bid:ARR, ask:ARR},
 *           outside_view:{overview:{bid,ask}, zoom:{bid,ask}},  // FRACTIONS
 *           metrics:{}}                           // per-draw, may be empty
 *   ARR = {sparse:false, n, v:[n values]} | {sparse:true, n, i:[...], v:[...]}
 *
 * Bin k of a view covers price offsets [-H + k*w, -H + (k+1)*w) ticks from the
 * window's reference (H = half_width_ticks, w = bin_ticks, n = 2H/w + 1);
 * price = ref_tick * tick_size. decodeArr() below is the ONE decoder.
 *
 * Chart rules this page is held to (skill: dataviz):
 *   - two categorical hues in FIXED order, slot 1 = bid, slot 2 = ask, never
 *     reassigned; light/dark steps validated against this site's surfaces
 *     (#fcfcfb / #1a1a19) with scripts/validate_palette.js - all six checks
 *     PASS in both modes. The hexes live in assets/style.css as --series-bid /
 *     --series-ask; nothing here hard-codes a color.
 *   - ONE y axis, shared by every panel of the window (max over input, target
 *     and every shown prediction draw) - the whole point is comparing like with
 *     like; never a second scale.
 *   - thin marks, hairline recessive grid/axes, one legend above the grid, text
 *     in text tokens (never a series color), linked crosshair + tooltip.
 *   - inline SVG built with DOM APIs; one <path> per series per panel, so a
 *     panel carries exactly two marks and 601 bins x ~16 panels stays cheap.
 *
 * Renders into #app; no other page runs this script.
 */

(function () {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";
  var SAMPLES_URL = "data/samples.json";
  var STORE_KEY = "lob-leaderboard.samples.v1";
  var MINUS = "−";                       // U+2212, not a hyphen
  var DOT = " · ";

  /* Panel geometry, in viewBox units. The <svg> is width:100% / height:auto, so
   * the viewBox is the layout: fixed here, scaled by the grid. The bottom band
   * holds BOTH label rows (ticks, then dollars) - never clipped. */
  var VB = { w: 360, h: 214, ml: 46, mr: 10, mt: 10, mb: 34 };
  VB.pw = VB.w - VB.ml - VB.mr;
  VB.ph = VB.h - VB.mt - VB.mb;
  VB.y0 = VB.mt + VB.ph;                      // baseline y

  var MOVE_EVT = ("PointerEvent" in window) ? "pointermove" : "mousemove";
  var LEAVE_EVT = ("PointerEvent" in window) ? "pointerleave" : "mouseleave";

  /* ------------------------------------------------------------- decoding -- */

  /**
   * THE decoder for the ARR encoding - every histogram read on this page goes
   * through it. Returns a dense Float64Array of length n (missing = 0).
   */
  function decodeArr(arr) {
    var n = arr && arr.n ? (arr.n | 0) : 0;
    var out = new Float64Array(n);
    if (!arr) return out;
    var v = arr.v || [];
    if (arr.sparse) {
      var idx = arr.i || [];
      for (var k = 0; k < idx.length; k++) {
        var at = idx[k] | 0;
        if (at >= 0 && at < n) out[at] = Number(v[k]) || 0;
      }
    } else {
      for (var j = 0; j < n && j < v.length; j++) out[j] = Number(v[j]) || 0;
    }
    return out;
  }

  /* ----------------------------------------------------------- formatting -- */

  function thousands(value) {
    var n = Math.round(Number(value) || 0);
    var s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (n < 0 ? MINUS : "") + s;
  }

  /** Significant-digit formatting (the score chips' fallback format). */
  function sig(value, digits) {
    var v = Number(value);
    if (!isFinite(v)) return "—";
    if (v === 0) return "0";
    var exp = Math.floor(Math.log10(Math.abs(v)));
    if (exp < -4 || exp >= digits) return v.toExponential(digits - 1);
    var s = v.toFixed(Math.max(0, digits - 1 - exp));
    if (s.indexOf(".") >= 0) s = s.replace(/\.?0+$/, "");
    return s;
  }

  function pct(fraction, digits) {
    return (Number(fraction) * 100).toFixed(digits === undefined ? 1 : digits) + "%";
  }

  /** A price offset in ticks, signed with a real minus sign. */
  function ticksLabel(offset) {
    var sign = offset > 0 ? "+" : (offset < 0 ? MINUS : "");
    return sign + Math.abs(offset);
  }

  /** The same offset in dollars: offset * tick_size. */
  function dollarsLabel(offset, tickSize) {
    var sign = offset > 0 ? "+" : (offset < 0 ? MINUS : "");
    return sign + "$" + Math.abs(offset * tickSize).toFixed(2);
  }

  /* --------------------------------------------------------------- scales -- */

  /** Nice 1/2/2.5/5/10 tick values from 0 up to max, ~count intervals. */
  function linearTicks(max, count) {
    if (!(max > 0)) return [0];
    var raw = max / Math.max(1, count);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    var out = [];
    for (var t = 0; t <= max + step * 0.001; t += step) out.push(t);
    return out;
  }

  /** Decade ladder for the log1p scale; labelled in shares, like the linear one. */
  function log1pTicks(max) {
    if (!(max > 0)) return [0];
    var out = [0];
    for (var d = 1; d <= max; d *= 10) out.push(d);
    if (out.length > 6) out = [0].concat(out.slice(out.length - 5));
    var last = out[out.length - 1];
    if (max / Math.max(last, 1) >= 3) out.push(Math.round(max));
    return out;
  }

  /* ---------------------------------------------------------- svg helpers -- */

  function svg(tag, attrs, children) {
    var node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "text") node.textContent = String(v);
        else node.setAttribute(k, String(v));
      });
    }
    if (children) children.forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function num(x) { return Math.round(x * 100) / 100; }

  /**
   * ONE <path> for one series: a step outline per run of consecutive non-zero
   * bins, closed on the baseline. Empty stretches emit nothing, so the two
   * series never paint over the axis and a lone bin still reads as a needle.
   */
  function stepPath(vals, n, x0, dx, yOf) {
    var parts = [];
    var k = 0;
    while (k < n) {
      if (!(vals[k] > 0)) { k++; continue; }
      var start = k;
      while (k < n && vals[k] > 0) k++;
      var seg = ["M", num(x0 + start * dx), num(VB.y0)];
      for (var j = start; j < k; j++) {
        var y = num(yOf(vals[j]));
        seg.push("L", num(x0 + j * dx), y, "L", num(x0 + (j + 1) * dx), y);
      }
      seg.push("L", num(x0 + k * dx), num(VB.y0), "Z");
      parts.push(seg.join(" "));
    }
    return parts.join(" ");
  }

  /* -------------------------------------------------------------- storage -- */

  function loadStored() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      var v = raw ? JSON.parse(raw) : null;
      return (v && typeof v === "object") ? v : {};
    } catch (err) {
      return {};
    }
  }

  function saveStored(state) {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (err) { /* private mode / disabled storage: selection just won't persist */ }
  }

  /* ---------------------------------------------------------- page state --- */

  var DATA = null;            // the parsed samples.json
  var STATE = { dataset_id: null, sample_id: null, draw: 0, view: "overview", scale: "linear" };
  var PANELS = [];            // live panel controllers, for linked hover
  var HOVER = -1;             // shared hovered bin index, -1 = none

  function datasetOf(id) {
    var found = null;
    DATA.datasets.forEach(function (d) { if (d.dataset_id === id) found = d; });
    return found || DATA.datasets[0] || null;
  }

  function windowOf(ds, sampleId) {
    var found = null;
    ds.windows.forEach(function (w) { if (w.sample_id === sampleId) found = w; });
    return found || ds.windows[0] || null;
  }

  /** Every draw index any model of this dataset actually has, ascending. */
  function drawsOf(ds) {
    var seen = {};
    ds.models.forEach(function (m) {
      (m.draws || []).forEach(function (d) { seen[d] = true; });
    });
    return Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
  }

  /* -------------------------------------------------------------- scoring -- */

  /**
   * The scores to print under a model panel: that DRAW's own metrics when the
   * export carries them, otherwise the per-window statistics over all draws
   * (flagged, never silently substituted).
   */
  function scoresFor(pred, draw) {
    var rec = pred ? pred[String(draw)] : null;
    var own = rec && rec.metrics;
    if (own && Object.keys(own).length) return { values: own, allDraws: false };
    var all = (pred && pred.sample_metrics) || null;
    if (all && Object.keys(all).length) return { values: all, allDraws: true };
    return { values: null, allDraws: false };
  }

  /* ------------------------------------------------------------- controls -- */

  function selectControl(id, label, options, value, onChange) {
    var sel = el("select", { id: id, "class": "samp-select" });
    options.forEach(function (opt) {
      if (opt.group) {
        var g = el("optgroup", { label: opt.group });
        opt.items.forEach(function (it) {
          g.appendChild(el("option", { value: it.value, text: it.label,
            selected: it.value === value ? "selected" : null }));
        });
        sel.appendChild(g);
      } else {
        sel.appendChild(el("option", { value: opt.value, text: opt.label,
          selected: opt.value === value ? "selected" : null }));
      }
    });
    sel.value = value;
    sel.addEventListener("change", function () { onChange(sel.value); });
    return el("div", { "class": "samp-control" }, [
      el("label", { "for": id, "class": "samp-label", text: label }), sel
    ]);
  }

  function toggleControl(label, options, value, onChange) {
    var group = el("div", { "class": "samp-toggle", role: "group",
      "aria-label": label });
    options.forEach(function (opt) {
      var btn = el("button", {
        type: "button", "class": "samp-toggle-btn",
        "aria-pressed": opt.value === value ? "true" : "false",
        dataset: { value: opt.value }, text: opt.label
      });
      btn.addEventListener("click", function () { onChange(opt.value); });
      group.appendChild(btn);
    });
    return el("div", { "class": "samp-control" }, [
      el("span", { "class": "samp-label", text: label }), group
    ]);
  }

  function buildControls(ds, win) {
    var draws = drawsOf(ds);

    var datasetOpts = DATA.datasets.map(function (d) {
      return { value: d.dataset_id, label: d.dataset_id };
    });

    // Windows grouped and ordered by symbol, then by window index.
    var bySymbol = {}, symbols = [];
    ds.windows.forEach(function (w) {
      if (!bySymbol[w.symbol]) { bySymbol[w.symbol] = []; symbols.push(w.symbol); }
      bySymbol[w.symbol].push(w);
    });
    symbols.sort();
    var windowOpts = symbols.map(function (sym) {
      return {
        group: sym,
        items: bySymbol[sym]
          .slice()
          .sort(function (a, b) { return a.window_index - b.window_index; })
          .map(function (w) {
            return {
              value: w.sample_id,
              label: w.symbol + DOT + "window " + w.window_index + DOT + w.trading_date
            };
          })
      };
    });

    var row = el("div", { "class": "samp-controls", role: "group",
      "aria-label": "Sample selection" }, [
      selectControl("samp-dataset", "Dataset", datasetOpts, ds.dataset_id, function (v) {
        var next = datasetOf(v);
        STATE.dataset_id = next.dataset_id;
        STATE.sample_id = next.windows.length ? next.windows[0].sample_id : null;
        var nd = drawsOf(next);
        if (nd.indexOf(STATE.draw) < 0) STATE.draw = nd.length ? nd[0] : 0;
        commit();
      }),
      selectControl("samp-window", "Window", windowOpts, win.sample_id, function (v) {
        STATE.sample_id = v;
        commit();
      }),
      draws.length > 1
        ? selectControl("samp-draw", "Draw", draws.map(function (d) {
            return { value: String(d), label: "draw " + d };
          }), String(STATE.draw), function (v) { STATE.draw = Number(v); commit(); })
        : el("div", { "class": "samp-control" }, [
            el("span", { "class": "samp-label", text: "Draw" }),
            el("span", { "class": "samp-static", text: "draw " + (draws[0] || 0) })
          ]),
      toggleControl("View", [
        { value: "overview", label: "Overview ±5000 ticks" },
        { value: "zoom", label: "Zoom ±300 ticks" }
      ], STATE.view, function (v) { STATE.view = v; commit(); }),
      toggleControl("Scale", [
        { value: "linear", label: "linear" },
        { value: "log1p", label: "log1p" }
      ], STATE.scale, function (v) { STATE.scale = v; commit(); })
    ]);
    return row;
  }

  /* --------------------------------------------------------------- legend -- */

  function legendRow(scale) {
    return el("div", { "class": "samp-legend" }, [
      el("span", { "class": "samp-key" }, [
        el("span", { "class": "samp-swatch bid" }), "bid"
      ]),
      el("span", { "class": "samp-key" }, [
        el("span", { "class": "samp-swatch ask" }), "ask"
      ]),
      el("span", { "class": "samp-legend-note", text:
        "y: volume in shares" + (scale === "log1p" ? ", log1p scale" : "") +
        ", one scale shared by every panel below" })
    ]);
  }

  /* ---------------------------------------------------------------- panel -- */

  /**
   * One small multiple. `rec` is a histogram record (or null for a model with
   * no draw for this window). Returns the panel element; registers a controller
   * in PANELS so hovering any panel highlights the same bin in all of them.
   */
  function panel(spec, view, scale, yMax, win) {
    var art = el("article", {
      "class": "samp-panel" + (spec.rec ? "" : " is-empty"),
      dataset: { panel: spec.role, ymax: String(yMax) }
    });

    var head = el("header", { "class": "samp-head" }, [
      el("span", { "class": "samp-title", text: spec.title }),
      spec.id ? el("span", { "class": "samp-id mono", title: spec.id, text: spec.id }) : null
    ]);
    art.appendChild(head);

    if (!spec.rec) {
      art.appendChild(el("p", { "class": "samp-noprediction", text: spec.note ||
        "no prediction for this window" }));
      return art;
    }

    var n = view.n, w = view.bin_ticks, H = view.half_width_ticks;
    var dx = VB.pw / n;
    var bid = decodeArr(spec.rec[view.key].bid);
    var ask = decodeArr(spec.rec[view.key].ask);

    var span = (scale === "log1p") ? Math.log1p(yMax) : yMax;
    var yOf = function (v) {
      if (!(span > 0)) return VB.y0;
      var t = (scale === "log1p") ? Math.log1p(v) : v;
      return VB.y0 - (t / span) * VB.ph;
    };
    var xOfOffset = function (offset) { return VB.ml + ((offset + H) / (n * w)) * VB.pw; };

    var kids = [];

    // gridlines + y ticks (recessive hairlines, labels in the muted token)
    var yTicks = (scale === "log1p") ? log1pTicks(yMax) : linearTicks(yMax, 4);
    yTicks.forEach(function (t) {
      var y = num(yOf(t));
      if (t > 0) {
        kids.push(svg("line", { "class": "samp-gridline",
          x1: VB.ml, x2: VB.ml + VB.pw, y1: y, y2: y }));
      }
      kids.push(svg("text", { "class": "samp-tick samp-tick-y",
        x: VB.ml - 6, y: y + 3, "text-anchor": "end", text: thousands(t) }));
    });

    // hovered-bin band + crosshair (moved, never rebuilt, on hover)
    var band = svg("rect", { "class": "samp-band", x: 0, y: VB.mt, width: 0, height: VB.ph });
    var cross = svg("line", { "class": "samp-cross", x1: 0, x2: 0, y1: VB.mt, y2: VB.y0,
      visibility: "hidden" });
    kids.push(band, cross);

    // the reference (offset 0): a thin vertical rule
    kids.push(svg("line", { "class": "samp-ref",
      x1: num(xOfOffset(0)), x2: num(xOfOffset(0)), y1: VB.mt, y2: VB.y0 }));

    // the marks: exactly one <path> per series, bid first, fixed hues
    kids.push(svg("path", { "class": "samp-mark bid", d: stepPath(bid, n, VB.ml, dx, yOf) }));
    kids.push(svg("path", { "class": "samp-mark ask", d: stepPath(ask, n, VB.ml, dx, yOf) }));

    // baseline, over the marks so it stays crisp
    kids.push(svg("line", { "class": "samp-baseline",
      x1: VB.ml, x2: VB.ml + VB.pw, y1: VB.y0, y2: VB.y0 }));

    // x ticks in ticks, with the dollar value at the two ends
    [-H, -H / 2, 0, H / 2, H].forEach(function (offset, i) {
      kids.push(svg("text", {
        "class": "samp-tick", x: num(xOfOffset(offset)), y: VB.y0 + 12,
        "text-anchor": i === 0 ? "start" : (i === 4 ? "end" : "middle"),
        text: ticksLabel(offset)
      }));
    });
    kids.push(svg("text", { "class": "samp-tick", x: VB.ml, y: VB.y0 + 24,
      "text-anchor": "start", text: dollarsLabel(-H, win.tick_size) }));
    kids.push(svg("text", { "class": "samp-tick", x: VB.ml + VB.pw, y: VB.y0 + 24,
      "text-anchor": "end", text: dollarsLabel(H, win.tick_size) }));
    kids.push(svg("text", { "class": "samp-tick samp-axis-name",
      x: num(xOfOffset(0)), y: VB.y0 + 24, "text-anchor": "middle",
      text: "offset (ticks)" }));

    // the hit layer, last so it takes the pointer
    var hit = svg("rect", { "class": "samp-hit", x: VB.ml, y: VB.mt,
      width: VB.pw, height: VB.ph });
    kids.push(hit);

    var plot = svg("svg", {
      viewBox: "0 0 " + VB.w + " " + VB.h, role: "img", tabindex: "0",
      "aria-label": spec.title + ": bid and ask volume by price offset from the " +
        "reference; arrow keys step the readout"
    }, kids);
    art.appendChild(plot);

    var tip = el("div", { "class": "samp-tip", hidden: "hidden" });
    art.appendChild(tip);

    // footer: mass, the mass that falls OUTSIDE this view, and the scores
    var foot = el("div", { "class": "samp-foot" }, [
      el("div", { "class": "samp-mass", text:
        "mass bid " + thousands(spec.rec.mass.bid) +
        DOT + "ask " + thousands(spec.rec.mass.ask) + " shares" })
    ]);
    var out = (spec.rec.outside_view || {})[view.key] || { bid: 0, ask: 0 };
    if (Number(out.bid) > 0 || Number(out.ask) > 0) {
      foot.appendChild(el("div", { "class": "samp-outside", text:
        "outside view: bid " + pct(out.bid) + DOT + "ask " + pct(out.ask) }));
    }
    if (spec.chips) foot.appendChild(spec.chips);
    art.appendChild(foot);

    /* -------- linked hover: this panel's half of the shared readout -------- */

    function binAt(clientX) {
      var box = plot.getBoundingClientRect();
      if (!box.width) return -1;
      var vx = ((clientX - box.left) / box.width) * VB.w;
      var k = Math.floor((vx - VB.ml) / dx);
      return (k < 0 || k >= n) ? -1 : k;
    }

    function show(k) {
      if (k < 0 || k >= n) {
        band.setAttribute("width", 0);
        cross.setAttribute("visibility", "hidden");
        tip.setAttribute("hidden", "hidden");
        return;
      }
      var x = VB.ml + k * dx;
      band.setAttribute("x", num(x));
      band.setAttribute("width", num(Math.max(dx, 1.6)));
      cross.setAttribute("x1", num(x + dx / 2));
      cross.setAttribute("x2", num(x + dx / 2));
      cross.setAttribute("visibility", "visible");

      var lo = -H + k * w, hi = lo + w - 1;
      var ticksText = (w === 1) ? ticksLabel(lo) + " ticks"
        : ticksLabel(lo) + "…" + ticksLabel(hi) + " ticks";
      var dollarsText = (w === 1) ? dollarsLabel(lo, win.tick_size)
        : dollarsLabel(lo, win.tick_size) + "…" + dollarsLabel(hi, win.tick_size);

      tip.textContent = "";
      append(tip, [
        el("div", { "class": "samp-tip-x", text: ticksText }),
        el("div", { "class": "samp-tip-x samp-tip-x2", text: dollarsText }),
        el("div", { "class": "samp-tip-row" }, [
          el("span", { "class": "samp-tipkey bid" }),
          el("b", { text: thousands(bid[k]) }),
          el("span", { "class": "samp-tiplabel", text: "bid" })
        ]),
        el("div", { "class": "samp-tip-row" }, [
          el("span", { "class": "samp-tipkey ask" }),
          el("b", { text: thousands(ask[k]) }),
          el("span", { "class": "samp-tiplabel", text: "ask" })
        ])
      ]);
      var at = Math.min(88, Math.max(12, ((x + dx / 2) / VB.w) * 100));
      tip.setAttribute("style", "left:" + at.toFixed(2) + "%");
      tip.removeAttribute("hidden");
    }

    hit.addEventListener(MOVE_EVT, function (ev) { setHover(binAt(ev.clientX)); });
    plot.addEventListener(LEAVE_EVT, function () { setHover(-1); });
    plot.addEventListener("keydown", function (ev) {
      var step = ev.shiftKey ? 10 : 1;
      var k = HOVER < 0 ? Math.floor(n / 2) : HOVER;
      if (ev.key === "ArrowRight") k += step;
      else if (ev.key === "ArrowLeft") k -= step;
      else if (ev.key === "Home") k = 0;
      else if (ev.key === "End") k = n - 1;
      else if (ev.key === "Escape") { setHover(-1); return; }
      else return;
      ev.preventDefault();
      setHover(Math.min(n - 1, Math.max(0, k)));
    });
    plot.addEventListener("focus", function () {
      if (HOVER < 0) setHover(Math.floor(n / 2));
    });

    PANELS.push({ show: show, n: n });
    return art;
  }

  /** Move the shared readout: the SAME bin lights up in every panel at once. */
  function setHover(k) {
    HOVER = k;
    PANELS.forEach(function (p) { p.show(k < p.n ? k : -1); });
  }

  /* ----------------------------------------------------------- score chips -- */

  function chipsFor(scores, isBest) {
    if (!scores.values) return null;
    var v = scores.values;
    var box = el("div", { "class": "samp-chips" });
    if (v.sided_w1 !== undefined && v.sided_w1 !== null) {
      box.appendChild(el("span", { "class": "chip" }, [
        el("b", { text: Number(v.sided_w1).toFixed(1) }), " ticks W1",
        isBest ? el("span", { "class": "best-chip", text: "best" }) : null
      ]));
    }
    if (v.ntve !== undefined && v.ntve !== null) {
      box.appendChild(el("span", { "class": "chip" }, [
        el("b", { text: pct(v.ntve) }), " NTVE"
      ]));
    }
    if (v.log1p_flow_mse !== undefined && v.log1p_flow_mse !== null) {
      box.appendChild(el("span", { "class": "chip" }, [
        el("b", { text: sig(v.log1p_flow_mse, 3) }), " log1p MSE"
      ]));
    }
    if (scores.allDraws) {
      box.appendChild(el("span", { "class": "samp-hint", text: "(all draws)" }));
    }
    return box.childNodes.length ? box : null;
  }

  /* ------------------------------------------------------------------ grid -- */

  function renderGrid(host, ds, win) {
    PANELS = [];
    HOVER = -1;

    var cfg = ds.views[STATE.view] || ds.views.overview;
    var view = {
      key: STATE.view,
      half_width_ticks: cfg.half_width_ticks,
      bin_ticks: cfg.bin_ticks,
      n: (2 * cfg.half_width_ticks) / cfg.bin_ticks + 1
    };

    // Which record each model panel shows (null = no draw for this window).
    var models = ds.models.map(function (m) {
      var pred = win.predictions[m.model_id] || null;
      var rec = pred ? (pred[String(STATE.draw)] || null) : null;
      return { model: m, pred: pred, rec: rec, scores: scoresFor(pred, STATE.draw) };
    });

    // ONE y scale for the whole window: max over input, target and every shown
    // prediction draw, in the current view. Comparing like with like is the point.
    var yMax = 0;
    var scan = function (rec) {
      if (!rec) return;
      ["bid", "ask"].forEach(function (side) {
        var a = decodeArr(rec[view.key][side]);
        for (var i = 0; i < a.length; i++) if (a[i] > yMax) yMax = a[i];
      });
    };
    scan(win.input);
    scan(win.target);
    models.forEach(function (m) { scan(m.rec); });

    // The board's own rule, per window: lowest sided_w1 wins the "best" chip.
    var bestId = null, bestW1 = Infinity;
    models.forEach(function (m) {
      var v = m.scores.values && m.scores.values.sided_w1;
      if (v !== undefined && v !== null && Number(v) < bestW1) {
        bestW1 = Number(v);
        bestId = m.model.model_id;
      }
    });

    var grid = el("div", { "class": "samp-grid", id: "samples-grid" });
    grid.appendChild(panel({ role: "input", title: "Input (previous window)",
      rec: win.input }, view, STATE.scale, yMax, win));
    grid.appendChild(panel({ role: "target", title: "Realized (next window)",
      rec: win.target }, view, STATE.scale, yMax, win));
    models.forEach(function (m) {
      grid.appendChild(panel({
        role: "model",
        title: m.model.model_name,
        id: m.model.model_id,
        rec: m.rec,
        note: "no draw " + STATE.draw + " for this window (this model has " +
          ((m.model.draws || []).map(function (d) { return "draw " + d; }).join(", ") ||
            "no draws") + ")",
        chips: chipsFor(m.scores, m.model.model_id === bestId)
      }, view, STATE.scale, yMax, win));
    });
    host.appendChild(grid);
  }

  /* ------------------------------------------------------------------ note -- */

  function howToRead(ds) {
    var ov = ds.views.overview, zm = ds.views.zoom;
    return el("details", { "class": "prov", open: "" }, [
      el("summary", null, [
        "How to read this",
        el("span", { "class": "hint", text: "what each panel is, and what the axes mean" })
      ]),
      el("dl", null, [
        el("dt", { text: "Input" }),
        el("dd", { text:
          "The previous window's REALIZED order-flow histogram - the only thing " +
          "every model on this board conditions on. Same window, same bytes, for " +
          "every model." }),
        el("dt", { text: "Realized" }),
        el("dd", { text:
          "The next window's realized flow: the target each prediction is scored " +
          "against. It is not shown to the models." }),
        el("dt", { text: "Models" }),
        el("dd", { text:
          "One panel per model, in board order (best mean sided_w1 first), each " +
          "showing the selected draw of that model's prediction for this window." }),
        el("dt", { text: "Reference (offset 0)" }),
        el("dd", null, [ds.reference, ". Price = ", mono("ref_tick × tick_size"),
          "; the x axis is the offset from that reference, in ticks, with the " +
          "dollar value at each end."]),
        el("dt", { text: "Views" }),
        el("dd", { text:
          "Overview: ±" + ov.half_width_ticks + " ticks in " + ov.bin_ticks +
          "-tick bins. Zoom: ±" + zm.half_width_ticks + " ticks in " +
          zm.bin_ticks + "-tick bins. Mass that falls outside the view is never " +
          "hidden - each panel's footer reports it as a share of that side's mass." }),
        el("dt", { text: "Y axis" }),
        el("dd", { text:
          "Volume in shares. Every panel of a window uses ONE scale (the max over " +
          "the input, the target and every prediction shown), so panels are " +
          "directly comparable; log1p plots log1p(volume) with the ticks still " +
          "labelled in shares." }),
        el("dt", { text: "Scores" }),
        el("dd", { text:
          "The per-window values behind the board averages: W1 in ticks, NTVE as a " +
          "percentage, log1p MSE. Lower is better on all three. A chip marked " +
          "“(all draws)” is this window's statistic over the model's draws, " +
          "shown when the export carries no per-draw value." }),
        el("dt", { text: "Hover" }),
        el("dd", { text:
          "Pointing at a bin highlights the SAME bin in every panel at once and " +
          "reads out its bid and ask volume. Keyboard: focus a panel and use the " +
          "arrow keys (Shift for 10 bins), Escape to clear." })
      ])
    ]);
  }

  /* ------------------------------------------------------------------ boot -- */

  function commit() {
    saveStored(STATE);
    render();
  }

  function render() {
    var app = document.getElementById("app");
    var ds = datasetOf(STATE.dataset_id);
    var win = windowOf(ds, STATE.sample_id);
    STATE.dataset_id = ds.dataset_id;
    STATE.sample_id = win.sample_id;

    app.textContent = "";
    var section = el("section", null, [
      el("h2", null, ["Sample windows — ", mono(ds.dataset_id)]),
      el("p", { "class": "sectionnote" }, [
        "The input every model conditions on, the realized next window, and each " +
        "model's prediction — same axes, one shared y scale. Scored by run ",
        mono(ds.board_run_id), ", dataset content hash ",
        el("span", { "class": "mono hash", text: shortHash(ds.content_hash) }), "."
      ]),
      buildControls(ds, win),
      el("p", { "class": "samp-caption" }, [
        el("b", { text: win.symbol }),
        DOT + "window " + win.window_index + DOT + win.trading_date + DOT +
          "reference $" + (win.ref_tick * win.tick_size).toFixed(2) + " (tick ",
        mono(String(win.ref_tick)), ")"
      ]),
      legendRow(STATE.scale)
    ]);
    app.appendChild(section);
    renderGrid(section, ds, win);
    section.appendChild(howToRead(ds));
  }

  /** The "samples <hash12> - generated <date>" chip in the masthead. */
  function renderChip() {
    var slot = document.getElementById("export-chip");
    if (!slot) return;
    var when = String(DATA.generated_at_utc || "").replace("T", " ").slice(0, 16);
    slot.textContent = "";
    slot.appendChild(el("span", { "class": "chip" }, [
      "samples ", el("b", { text: shortHash(DATA.export_hash) || "?" }),
      when ? " · generated " + when : null,
      DATA.draws_per_model ? " · " + DATA.draws_per_model + " draws/model" : null
    ]));
  }

  async function main() {
    var app = document.getElementById("app");
    var payload = null;
    try {
      var res = await fetch(SAMPLES_URL, { cache: "no-store" });
      if (res.ok) payload = await res.json();
    } catch (err) {
      payload = null;                     // offline / file:// / CORS
    }

    // A dataset with no windows has nothing to draw: drop it rather than break,
    // so a thin export degrades to the empty state like every other page.
    if (payload && payload.datasets) {
      payload.datasets = payload.datasets.filter(function (d) {
        return d && d.windows && d.windows.length && d.models && d.views;
      });
    }

    if (!payload || !payload.datasets || !payload.datasets.length) {
      app.textContent = "";
      app.appendChild(emptyState(
        "The backend has not published data/samples.json yet, so there are no " +
        "sample windows to draw. It arrives with the next publish step, " +
        "alongside the board export.",
        el("span", { "class": "mono", text: "python -m evaluation_db publish" })));
      return;
    }

    DATA = payload;
    var stored = loadStored();
    var ds = datasetOf(stored.dataset_id || null);
    var draws = drawsOf(ds);
    STATE = {
      dataset_id: ds.dataset_id,
      sample_id: windowOf(ds, stored.sample_id || null).sample_id,
      draw: draws.indexOf(Number(stored.draw)) >= 0 ? Number(stored.draw)
        : (draws.length ? draws[0] : 0),
      view: (stored.view === "zoom" || stored.view === "overview") ? stored.view : "overview",
      scale: (stored.scale === "log1p" || stored.scale === "linear") ? stored.scale : "linear"
    };

    renderChip();
    render();
  }

  document.addEventListener("DOMContentLoaded", function () { main(); });
})();
