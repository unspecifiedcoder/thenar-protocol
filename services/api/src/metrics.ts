/**
 * Prometheus metrics for the API service (PLAN §20, T-031).
 *
 * Registry with metrics: `log_size`, `anchor_lag_seconds{chain}`,
 * `ingest_queue`, `verification_queue`, `claims_total{check,result}`,
 * `revocations_total`, `api_errors_total{code}`.
 *
 * The log daemon (services/log) exports a `collect()` hook that the
 * registry calls to bridge daemon metrics into gauges.
 */

import { Registry, Counter, Gauge } from "prom-client";

export const metricsRegistry = new Registry();

// --------- log_size: number of leaves in the log
export const logSizeGauge = new Gauge({
  name: "log_size",
  help: "Total number of leaves in the log",
  registers: [metricsRegistry],
});

// --------- anchor_lag_seconds: seconds since last anchor per chain
export const anchorLagGauge = new Gauge({
  name: "anchor_lag_seconds",
  help: "Seconds since last successful anchor per chain",
  labelNames: ["chain"],
  registers: [metricsRegistry],
});

// --------- ingest_queue: pending episodes not yet logged
export const ingestQueueGauge = new Gauge({
  name: "ingest_queue",
  help: "Number of episodes pending ingest into the log",
  registers: [metricsRegistry],
});

// --------- verification_queue: pending claims not yet logged
export const verificationQueueGauge = new Gauge({
  name: "verification_queue",
  help: "Number of verification claims pending logging",
  registers: [metricsRegistry],
});

// --------- claims_total: total claims by check and result
export const claimsTotalCounter = new Counter({
  name: "claims_total",
  help: "Total verification claims logged per check and result",
  labelNames: ["check", "result"],
  registers: [metricsRegistry],
});

// --------- revocations_total: total revocations logged
export const revocationsTotalCounter = new Counter({
  name: "revocations_total",
  help: "Total revocations logged",
  registers: [metricsRegistry],
});

// --------- api_errors_total: API errors by HTTP status code
export const apiErrorsTotalCounter = new Counter({
  name: "api_errors_total",
  help: "Total API errors by HTTP status code",
  labelNames: ["code"],
  registers: [metricsRegistry],
});

/**
 * Register a collector function that will be called to gather metrics.
 * The log daemon uses this to bridge its internal metrics into gauges.
 */
export function registerCollector(collectFn: () => void) {
  metricsRegistry.registerCollector(collectFn);
}
