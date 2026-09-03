export const VERDICT_REASONS = [
  'no_text_layer', 'broken_text_layer_structural', 'broken_text_layer_statistical',
  'overlaid_text_on_image', 'low_resolution_scan', 'encrypted',
  'reading_order_unstable', 'column_split_ambiguous', 'table_grid_residual_high',
  'borderless_table_suspected', 'object_coverage_low',
] as const;
export type VerdictReason = (typeof VERDICT_REASONS)[number];
export type RouteReason = VerdictReason;
export const ROUTE_REASONS = VERDICT_REASONS;
