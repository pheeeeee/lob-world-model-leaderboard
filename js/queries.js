/* Every SQL string the site runs, in one place.
 *
 * Data contract: these queries read `data/evaluation.sqlite`, a DERIVED,
 * fully regenerable database written only by the backend's publish step
 * (`python -m evaluation_db publish`). Its exact DDL — the source of truth for
 * every table, view and column named below — is
 * Finance_World_Model/src/evaluation_db/schema.sql. The site never writes.
 *
 * Rules followed here:
 *   - query ONLY through the schema's tables and views;
 *   - no metric id, model id or dataset id is hard-coded as *content* (the one
 *     literal, 'sided_w1' in the metrics ORDER BY, is the board's documented
 *     ranking convention: headline metric first if it exists, else alphabetical,
 *     and it degrades to plain alphabetical when that metric is absent);
 *   - positional `?` parameters only.
 *
 * Also loadable from node (`require('./js/queries.js')`) so the SQL can be
 * validated against schema.sql without a browser.
 */
const QUERIES = {
  // Board COLUMNS. Order = the headline metric first (if registered), then
  // alphabetical; `outputs_json` names every statistic the metric emits.
  metrics: `
    SELECT metric_id, primary_output, semantic_version, direction, unit,
           summary, prediction_scope, primary_aggregation, outputs_json
      FROM metrics
     ORDER BY (metric_id <> 'sided_w1'), metric_id`,

  // Board SECTIONS: one row per test dataset = its current (latest) run.
  boardRuns: `
    SELECT test_dataset_id, evaluation_run_id, run_created_at_utc, study_id
      FROM board_runs
     ORDER BY test_dataset_id`,

  // The board itself: one row per (dataset, model, metric); pivoted client-side
  // into rows = models, columns = metrics.
  board: `
    SELECT test_dataset_id, evaluation_run_id, run_created_at_utc, study_id,
           model_id, model_name, prediction_id, checkpoint,
           n_test_samples, n_generation_draws, row_status,
           metric_id, value, direction, unit, primary_output
      FROM board
     ORDER BY test_dataset_id, model_id, metric_id`,

  // Every statistic of the current runs (primary + *_bid / *_ask + counts);
  // feeds the per-side breakdown.
  boardStatistics: `
    SELECT test_dataset_id, evaluation_run_id, model_id, metric_id,
           metric_version, statistic, value, unit, n, status
      FROM board_statistics
     ORDER BY test_dataset_id, model_id, metric_id, statistic`,

  // Per-symbol means of the current runs; feeds the per-ticker tables.
  boardPerTicker: `
    SELECT test_dataset_id, evaluation_run_id, model_id, metric_id, statistic,
           symbol, mean_value, n_samples, n_draws
      FROM board_per_ticker
     ORDER BY test_dataset_id, metric_id, symbol, model_id`,

  // EVERY registry dataset — raw sources and derived bundles alike, so a test
  // set's provenance chain resolves inside the database.
  datasets: `
    SELECT dataset_id, kind, role, path, task, sample_count, content_hash,
           added, source, date, symbols, summary, source_dataset_ids_json
      FROM datasets
     ORDER BY (role IS NOT 'test'), dataset_id`,

  // The frozen bundle manifests' provenance blocks (test bundles only).
  datasetProvenance: `
    SELECT dataset_id, task, source, flow_engine, note, builder_script,
           created_at_utc, split_name, split_note, condition_ref_grammar,
           price_tick, flow_volume, input_schemas_json,
           pinned_kind, pinned_count, pinned_example_json
      FROM dataset_provenance
     ORDER BY dataset_id`,

  // Registry entries behind the "about this model" text under each board row.
  models: `
    SELECT model_id, model_family, kind, stage, train_dataset, seed, checkpoint,
           checkpoint_sha256, config_hash, selection_rule, status, notes,
           defaults, promoted
      FROM models
     ORDER BY model_id`,

  // Full run log, newest first.
  runs: `
    SELECT evaluation_run_id, study_id, date_partition, created_at_utc, status,
           n_inputs, n_metrics, content_hash, git_commit, git_dirty, path,
           command, pipeline_schema_version
      FROM runs
     ORDER BY created_at_utc DESC, evaluation_run_id DESC`,

  // Which metric version + parameter set one run used. Param: evaluation_run_id.
  runMetrics: `
    SELECT metric_id, semantic_version, parameters_hash
      FROM run_metrics
     WHERE evaluation_run_id = ?
     ORDER BY metric_id`,

  // One run's scored rows (model x metric). Param: evaluation_run_id.
  results: `
    SELECT model_id, model_name, test_dataset_id, test_dataset_sha256,
           prediction_id, checkpoint, checkpoint_sha256, n_test_samples,
           n_generation_draws, row_status, metric_id, value
      FROM results
     WHERE evaluation_run_id = ?
     ORDER BY test_dataset_id, model_id, metric_id`,

  // Single-row provenance of the export the site is currently serving.
  exportMeta: `
    SELECT schema_version, export_hash, exported_at_utc, backend_git_commit,
           backend_git_dirty, n_runs, n_models, n_datasets, n_metrics
      FROM export_meta
     LIMIT 1`
};

if (typeof module !== "undefined") { module.exports = QUERIES; }
