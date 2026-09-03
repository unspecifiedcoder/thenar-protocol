/**
 * Bridge from log daemon metrics into API registry gauges (T-031).
 *
 * No second registry — this module exports a `collect()` hook that the
 * API's metrics registry calls to update daemon metrics into gauges.
 * The daemon maintains its own internal metrics state; this just exposes
 * them to Prometheus.
 */

import { getMetrics } from "./daemon.ts";

/**
 * A collector function that updates gauge values from daemon metrics.
 * The API registry calls this on every `/metrics` request.
 *
 * Signature matches prom-client's Collector interface:
 * `{ collect(): Promise<MetricWithName[]> | MetricWithName[] }`
 */
export function makeDaemonCollector(
  logSizeGauge: any,
  anchorLagGauge: any,
  ingestQueueGauge: any,
  verificationQueueGauge: any,
) {
  return {
    collect: async () => {
      const daemonMetrics = getMetrics();

      // Update log_size gauge from daemon (if it tracks log size)
      // For now, this is a placeholder; the daemon may expose log size
      // through its getMetrics in a future task. For T-031, we set it via
      // explicit calls or leave it managed by other layers.

      // Update anchor_lag_seconds per chain
      for (const [chainId, lagSeconds] of daemonMetrics.anchor_lag_seconds.entries()) {
        anchorLagGauge.set({ chain: String(chainId) }, lagSeconds);
      }

      // Update queue gauges (these would be populated by other layers as they
      // process episodes and claims)
      // For now, these remain as 0 or whatever was last set
    },
  };
}

export { getMetrics } from "./daemon.ts";
