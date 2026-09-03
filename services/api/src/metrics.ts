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
 * Create a collector that bridges daemon metrics into Prometheus gauges.
 * Call this when starting the daemon to wire metrics into the registry.
 */
export function createDaemonCollector(getDaemonMetrics: () => any) {
  return () => {
    try {
      const daemonMetrics = getDaemonMetrics();

      // Update anchor_lag_seconds per chain
      if (daemonMetrics && daemonMetrics.anchor_lag_seconds) {
        for (const [chainId, lagSeconds] of daemonMetrics.anchor_lag_seconds.entries()) {
          anchorLagGauge.set({ chain: String(chainId) }, lagSeconds);
        }
      }

      // Note: other gauges (log_size, ingest_queue, verification_queue) are
      // managed by the API layer as it processes requests. The daemon only
      // exposes anchor_lag_seconds and pending_revocations count.
    } catch {
      // Silently ignore errors in metric collection
    }
  };
}
