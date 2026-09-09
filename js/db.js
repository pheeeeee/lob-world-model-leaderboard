/* Loading the published SQLite export into the browser, with sql.js.
 *
 * Data contract — three files under data/, written ONLY by the backend's
 * publish step (a cluster job copies them in and pushes; this site never edits
 * them, and there is no build step):
 *
 *   data/export_meta.json    small JSON stamp of the current export; its
 *                            `export_hash` is used as the cache-buster for the
 *                            database. Its ABSENCE (404) is the normal state of
 *                            a freshly created repo and means "nothing
 *                            published yet" — never an error to throw.
 *   data/evaluation.sqlite   the derived, fully regenerable database; DDL:
 *                            Finance_World_Model/src/evaluation_db/schema.sql
 *   data/board.json          a convenience snapshot for other consumers; this
 *                            site reads the database, not this file.
 *
 * sql.js is loaded from vendor/ (same origin) so the .wasm sibling resolves on
 * GitHub Pages; classic scripts only, so file:// and dumb static hosts work.
 *
 * Exposes: window.loadDb(), window.query(db, sql, params).
 */

/**
 * Fetch the export stamp + database and open it.
 * @returns {Promise<{db: object|null, meta: object|null}>}
 *          `{db: null, meta: null}` when no export has been published yet
 *          (export_meta.json 404s, or is unreachable — e.g. file://).
 */
async function loadDb() {
  let meta = null;
  try {
    const stamp = await fetch("data/export_meta.json", { cache: "no-store" });
    if (!stamp.ok) return { db: null, meta: null };   // 404 = nothing published
    meta = await stamp.json();
  } catch (err) {
    return { db: null, meta: null };                  // offline / file:// / CORS
  }

  // Cache-bust on the export hash: Pages caches data/ aggressively, and every
  // new export changes this value.
  const version = meta && meta.export_hash ? String(meta.export_hash) : "";
  const url = "data/evaluation.sqlite" + (version ? "?v=" + encodeURIComponent(version) : "");
  const response = await fetch(url);
  if (!response.ok) return { db: null, meta: null };
  const buf = await response.arrayBuffer();

  const SQL = await initSqlJs({ locateFile: (f) => "vendor/" + f });
  const db = new SQL.Database(new Uint8Array(buf));
  return { db: db, meta: meta };
}

/**
 * Run one SQL statement and return its rows as plain objects.
 * @param {object} db      an open sql.js Database
 * @param {string} sql     a statement from QUERIES (positional `?` params only)
 * @param {Array}  params  values for the `?` placeholders
 * @returns {Array<Object>}
 */
function query(db, sql, params) {
  if (!db) return [];
  const rows = [];
  const stmt = db.prepare(sql);
  try {
    if (params && params.length) stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return rows;
}

window.loadDb = loadDb;
window.query = query;
