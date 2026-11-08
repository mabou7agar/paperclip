/** Content-free, immutable account attribution. Cache writes are already included in input tokens. */
export interface ConnectionUsageObservation {
  at: Date;
  tokens: number | null;
  apiCostCents: string | null;
}
