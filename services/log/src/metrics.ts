/**
 * Bridge from log daemon metrics into API registry gauges (T-031).
 *
 * No second registry — the log daemon maintains its own internal metrics state
 * (anchor_lag_seconds per chain, pending_revocations count). These are exposed
 * directly via `getMetrics()` for the API to wire into its registry.
 *
 * In production, the API creates a collector function that reads these metrics
 * and updates Prometheus gauges on each scrape.
 */

export { getMetrics } from "./daemon.ts";
export type { DaemonMetrics } from "./daemon.ts";
