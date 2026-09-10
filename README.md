# LOB World-Model Leaderboard — website

The public leaderboard for the limit-order-book (LOB) world-model benchmark:
next-window order-flow prediction, scored on frozen, content-hashed evaluation
bundles by immutable evaluation runs.

It is a **plain static site** — no build step, no npm, no framework. Three HTML
pages load [sql.js](https://sql.js.org) from `vendor/`, read one SQLite file in
the browser, and render the boards client-side; the fourth, `samples.html`, reads
one JSON file and draws the histograms behind those numbers as inline SVG. No
framework, no chart library, no external request beyond the optional Google
Fonts stylesheet.

| Page | What it shows |
| --- | --- |
| `index.html` | One board section per test dataset (the current run for that dataset), each opening with a "Test-set source" provenance block, plus the per-side and per-ticker breakdowns, the evaluation-datasets table and the run-log summary. |
| `samples.html` | The pictures behind the numbers: per evaluation window, the INPUT order-flow histogram every model conditions on, the realized TARGET, and each model's predicted draw — small multiples on identical axes and one shared y scale, with that window's scores under each model. |
| `runs.html` | The full run log. Select a run to see the rows it scored (model × metric), the metric versions and parameter hashes it used, and the provenance recorded in its manifest (study, git commit, command). |
| `datasets.html` | Every entry in the dataset registry — raw source archives and the derived bundles built from them — and the full provenance block of each `role='test'` bundle. |

Nothing about *which* metrics, models or datasets exist is written into this
repo: columns come from the `metrics` table, board sections from the
`board_runs` view, rows from `board`. Adding a metric or a model to the backend
registry makes it appear here on the next export, with no change to this site.

## Data contract

Four files under `data/`, **written only by the backend's publish step**
(`python -m evaluation_db publish`, run on the cluster, which copies them in and
pushes). The site is strictly a reader — it never writes them, and no page
mutates any of them.

| File | Role |
| --- | --- |
| `data/evaluation.sqlite` | The whole benchmark: a derived, fully regenerable database rebuilt from scratch on every export (never migrated). |
| `data/export_meta.json` | The export stamp. Its `export_hash` is the cache-buster the site appends to the database URL, and its `exported_at_utc` fills the masthead chip. |
| `data/board.json` | A convenience snapshot for other consumers; this site reads the database, not this file. |
| `data/samples.json` | The sample windows `samples.html` draws: per test dataset, a set of evaluation windows with the input histogram, the realized target, every model's prediction draws and that window's scores. Regenerated with the board on every export. |

The database's exact DDL — the source of truth for every table, view and column
the site queries — lives in the backend repo at
`src/evaluation_db/schema.sql`. All SQL used here is collected in
`js/queries.js` and is written against that schema and nothing else. The
`board_runs` / `board` / `board_statistics` / `board_per_ticker` views already
implement the board rule (**per test dataset, the latest run wins**); older runs
stay in `runs` / `results` as history.

Until the first export is pushed, `data/` holds only `.gitkeep` and every page
shows a "No data published yet" state rather than breaking.

The source of truth for the numbers themselves is not this repo at all: it is
the immutable artifacts in the backend (`evaluation_results/` + `registry/*.yml`).
This site is a derived view of them.

## Local preview

`fetch()` will not read `file://` URLs, so serve the directory over HTTP:

```bash
python -m http.server 8000
# then open http://localhost:8000
```

To preview with real data, drop an exported `evaluation.sqlite` and its
`export_meta.json` into `data/` first — but do not commit hand-made copies:
those files belong to the publish step, which is the only writer.

## GitHub Pages

Settings → Pages → Source: **GitHub Actions**. The workflow in
`.github/workflows/pages.yml` uploads the repository root as-is (there is no build
step) and deploys it on every push to `main`; it can also be started by hand from the
Actions tab ("Run workflow"). Source **Deploy from a branch** (`main` / `/ (root)`)
works too — `.nojekyll` is present so Jekyll leaves `vendor/`, `assets/` and `data/`
alone — but then the workflow is redundant.

A new export arrives like this: the cluster job writes the three files into
`data/`, commits and pushes to `main`; Pages redeploys within about a minute and
the site serves the new database. Because the database URL carries
`?v=<export_hash>`, browsers pick up the new bytes immediately instead of a
cached copy.

## Connecting the backend (one-time, done by the repo owner)

The backend repo (`Finance_World_Model`) lives on a compute cluster that cannot host a
web service, so it *pushes* exports into this repo. Once:

1. Create this repo on GitHub, empty and public, named `lob-world-model-leaderboard`.
2. On the cluster, make a deploy key and add its public half to this repo with
   **write access** (Settings → Deploy keys):
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/lob_leaderboard_deploy -N ""
   cat ~/.ssh/lob_leaderboard_deploy.pub
   ```
3. In the cluster checkout of this repo:
   ```bash
   git config core.sshCommand "ssh -i ~/.ssh/lob_leaderboard_deploy -o IdentitiesOnly=yes"
   git remote add origin git@github.com:<user>/lob-world-model-leaderboard.git
   git push -u origin main
   ```
4. Enable Pages (section above). From then on every
   `python -m evaluation_db publish --site-checkout <this checkout>` on the cluster
   commits `data/` and pushes; publish is a no-op when the export hash is unchanged.

## Layout

```
index.html          boards + datasets table + run-log summary
samples.html        per-window small multiples: input, target, every model's draw
runs.html           full run log, with a per-run detail panel
datasets.html       every registered dataset + test-set provenance
assets/style.css    design tokens, table/provenance rules, samples-page chart rules
assets/favicon.svg  monochrome bar-chart glyph
js/queries.js       every SQL string, in one object
js/db.js            loadDb() / query() — fetch + sql.js
js/render.js        pure DOM builders (no fetching, no queries)
js/main.js          page wiring for the three sql.js pages: load, assemble, render
js/samples.js       the Samples page: reads data/samples.json, draws the charts
vendor/             pinned sql.js runtime (see below)
data/               written by the backend publish step only
```

Scripts are classic `<script>` tags, not ES modules, so the pages work on any
static host without MIME-type surprises. `js/render.js` is a port of the
backend's `src/leaderboard_site/render.py`, which renders the same board from
the same artifacts as a single self-contained HTML file; the two are meant to
look identical.

## The Samples page

`samples.html` turns the board's numbers into pictures. For one evaluation window
it draws, as small multiples: the **input** (the previous window's realized
order-flow histogram — the only thing every model conditions on), the **realized**
next window (the target the predictions are scored against), and one panel per
model in board order, each showing the selected draw. Controls above the grid pick
the dataset, the window (grouped by symbol), the draw, the view and the scale, and
the selection is remembered in `localStorage`.

It reads `data/samples.json` and nothing else — no sql.js, no database — so it
loads on its own and shows the standard empty state when that file has not been
published yet. Its schema (`schema_version 1`) is documented at the top of
`js/samples.js`, including the sparse/dense array encoding and the bin→price-offset
rule; `decodeArr()` there is the single decoder every panel goes through.

Rules the charts are held to, so panels stay comparable:

- **One y scale per window.** The max over the input, the target and every
  prediction shown; every panel of a window uses it. Comparing like with like is
  the point of the page — never a per-panel or second axis.
- **Two categorical hues in fixed order** — slot 1 = bid, slot 2 = ask, never
  reassigned. They live in `assets/style.css` as `--series-bid` / `--series-ask`
  with their own validated dark steps, and pass all six palette checks (lightness
  band, chroma floor, CVD separation, normal-vision floor, contrast) against this
  site's surfaces in both modes. Text never wears a series color.
- **Mass outside the view is reported, never hidden** — each panel's footer prints
  the fraction of each side's mass that falls outside the plotted range.
- **Linked hover.** Pointing at a bin highlights the same bin in every panel at
  once; keyboard focus plus the arrow keys give the same readout.
- Inline SVG built with DOM APIs, one `<path>` per series per panel, so 601 bins
  across a dozen-odd panels stays cheap and no data ever reaches `innerHTML`.

## Vendored dependency

`vendor/sql-wasm.js` and `vendor/sql-wasm.wasm` are **sql.js 1.13.0**, taken
verbatim from cdnjs and committed here on purpose: the WebAssembly binary must
be served from the same origin as the page for the `locateFile` path to resolve
on GitHub Pages, and pinning it means the site cannot break when a CDN changes.
sql.js is MIT-licensed. To refresh the pin:

```bash
curl -fsSL -o vendor/sql-wasm.js   https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/sql-wasm.js
curl -fsSL -o vendor/sql-wasm.wasm https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/sql-wasm.wasm
```

The only other external request is the optional Google Fonts stylesheet
(Source Sans 3 / IBM Plex Mono); every rule declares a real system fallback
stack, so the site is fully legible when it is blocked.

## License

MIT — see `LICENSE`.
