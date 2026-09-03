/**
 * Anchor scheduler daemon — anchors the log at configured intervals
 * (primary: 3600 s, mirror: 86400 s) with backoff on failure.
 *
 * - Anchors when size grows OR revocationRoot changes (D-17).
 * - A failed primary blocks mirror anchoring (mirrors only anchor what the
 *   primary has already anchored).
 * - Backoff: 30 s → 5 min (30, 60, 120, 240, 300 seconds).
 * - Alarm: console.error + optional webhook when lag > 2× interval or
 *   divergence detected.
 */

import type { Account, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { LogStore } from "./store.ts";
import {
  anchorHead, anchorAll, checkDivergence, revocationRoot,
} from "./anchorer.ts";
import { loadChains, type ChainTarget } from "./chains.ts";
import type { Clients } from "./anchorer.ts";

/** Per-chain anchoring state in the daemon loop. */
export type DaemonState = {
  lastSuccessAt: number; // unix seconds of last successful anchor (or 0)
  lastAttemptAt: number; // unix seconds of last anchor attempt (success or failure; or 0)
  failureCount: number;   // consecutive failures since last success
};

export type DaemonMetrics = {
  anchor_lag_seconds: Map<number, number>;
  pending_revocations: number;
};

export type DaemonOpts = {
  store: LogStore;
  signer: Account;
  chains?: ChainTarget[];
  clientsFor?: (t: ChainTarget) => Clients;
  anchorIntervalSecondsPrimary?: number;
  anchorIntervalSecondsMirror?: number;
  anchorWebhookUrl?: string;
  now?: () => number; // unix seconds; injected for testing
  sleep?: (ms: number) => Promise<void>; // for testing
};

/** State per chain for the daemon. */
const state = new Map<number, DaemonState>();

/** Metrics exposed to monitoring. */
const metrics: DaemonMetrics = {
  anchor_lag_seconds: new Map(),
  pending_revocations: 0,
};

/**
 * Get the configured interval for a chain role (primary/mirror).
 * Defaults: primary 3600 s, mirror 86400 s.
 */
function getInterval(role: "primary" | "mirror", opts: DaemonOpts): number {
  if (role === "primary") return opts.anchorIntervalSecondsPrimary ?? 3600;
  return opts.anchorIntervalSecondsMirror ?? 86400;
}

/**
 * Calculate the backoff delay in seconds.
 * 30 s → 60 s → 120 s → 240 s → 300 s (5 min cap).
 */
function backoffDelay(failureCount: number): number {
  const delays = [30, 60, 120, 240, 300];
  return delays[Math.min(failureCount, delays.length - 1)];
}

/**
 * Check whether to anchor this chain.
 * Anchors when:
 *   - size grew since last anchor, OR
 *   - revocationRoot changed since last anchor (D-17 revocation-only case).
 * For mirrors: only anchor a triple the primary has already anchored.
 */
function shouldAnchor(
  store: LogStore,
  chain: ChainTarget,
  now: number,
  chainState: DaemonState,
  opts: DaemonOpts,
): boolean {
  const interval = getInterval(chain.role, opts);
  const lastSuccess = chainState.lastSuccessAt;
  const lastAttempt = chainState.lastAttemptAt;
  const failureCount = chainState.failureCount;

  // Check backoff: if we failed, wait before retrying (based on last attempt time).
  if (failureCount > 0) {
    const backoff = backoffDelay(failureCount);
    if (now - lastAttempt < backoff) return false;
  }

  // For the first attempt (lastSuccess === 0), allow immediately.
  // After that, check the interval.
  if (lastSuccess > 0) {
    // Check interval: only attempt an anchor if enough time has passed since last success.
    if (now - lastSuccess < interval) return false;
  }

  // Check if there's anything new to anchor.
  const lastAnchored = store.lastAnchored(chain.id);
  const currentSize = store.size();
  const currentRevRoot = revocationRoot(store);

  // Size must have grown OR revocationRoot must have changed (D-17).
  if (lastAnchored === null) {
    // Never anchored this chain before; anchor if there's a leaf.
    return currentSize > 0;
  }

  const sizeGrew = currentSize > lastAnchored.size;
  const revRootChanged = currentRevRoot !== lastAnchored.revocationRoot;

  if (!(sizeGrew || revRootChanged)) return false;

  // For mirrors: do not anchor ahead of the primary.
  // Only anchor a (size, root) triple the primary has already anchored.
  if (chain.role === "mirror") {
    const primaryChain = opts.chains?.find((c) => c.role === "primary");
    if (primaryChain) {
      const primaryLastAnchored = store.lastAnchored(primaryChain.id);
      // The mirror cannot anchor if the primary has never anchored.
      if (!primaryLastAnchored) return false;
      // The mirror can only anchor at most what the primary has anchored.
      if (currentSize > primaryLastAnchored.size) return false;
    }
  }

  return true;
}

/**
 * Perform one tick of the daemon loop for a single chain.
 * Returns true if an anchor was attempted (success or failure).
 */
export async function tick(
  store: LogStore,
  chain: ChainTarget,
  signer: Account,
  now: number,
  chainState: DaemonState,
  opts: DaemonOpts = {},
): Promise<boolean> {
  if (!shouldAnchor(store, chain, now, chainState, opts)) {
    return false;
  }

  // Record the attempt time.
  chainState.lastAttemptAt = now;

  try {
    const result = await anchorHead(store, chain, signer, opts.clientsFor?.(chain));
    if (result !== null) {
      // Anchor succeeded.
      chainState.lastSuccessAt = now;
      chainState.failureCount = 0;
      metrics.anchor_lag_seconds.set(chain.id, 0);
      return true;
    } else {
      // No new anchor needed (NothingToAnchor case).
      // Treat as a success to reset the failure counter.
      chainState.lastSuccessAt = now;
      chainState.failureCount = 0;
      metrics.anchor_lag_seconds.set(chain.id, 0);
      return false;
    }
  } catch (e) {
    // Anchor failed.
    chainState.failureCount += 1;
    const msg = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({
      severity: "error",
      component: "anchorer",
      chain_id: chain.id,
      error: msg,
      failure_count: chainState.failureCount,
      timestamp: new Date().toISOString(),
    }));
    return false;
  }
}

/**
 * Main daemon loop. Runs indefinitely, ticking all chains at their intervals.
 * For testing, inject `now()` and `sleep()`.
 */
export async function runDaemon(opts: DaemonOpts): Promise<void> {
  const nowFn = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const sleepFn = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const chains = opts.chains ?? loadChains();
  const store = opts.store;

  // Initialize state for each chain.
  for (const chain of chains) {
    if (!state.has(chain.id)) {
      state.set(chain.id, { lastSuccessAt: 0, lastAttemptAt: 0, failureCount: 0 });
    }
  }

  let lastDivergenceCheck = 0;
  const DIVERGENCE_CHECK_INTERVAL = 300; // Check every 5 minutes.

  while (true) {
    const now = nowFn();

    // Update metrics: compute lag per chain.
    for (const chain of chains) {
      const interval = getInterval(chain.role, opts);
      const chainState = state.get(chain.id)!;
      const lastSuccess = chainState.lastSuccessAt || 0;
      const lag = now - lastSuccess;
      metrics.anchor_lag_seconds.set(chain.id, lag);

      // Alarm if lag > 2× interval.
      if (lag > interval * 2) {
        console.error(JSON.stringify({
          severity: "error",
          component: "daemon",
          event: "anchor_lag_alarm",
          chain_id: chain.id,
          chain_name: chain.name,
          lag_seconds: lag,
          interval_seconds: interval,
          threshold_seconds: interval * 2,
          timestamp: new Date().toISOString(),
        }));

        // Optional webhook.
        if (opts.anchorWebhookUrl) {
          try {
            await fetch(opts.anchorWebhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                event: "anchor_lag_alarm",
                chain_id: chain.id,
                chain_name: chain.name,
                lag_seconds: lag,
                interval_seconds: interval,
              }),
            });
          } catch {
            // Webhook failed; don't let it crash the daemon.
          }
        }
      }
    }

    // Periodically check for divergence across chains.
    if (now - lastDivergenceCheck >= DIVERGENCE_CHECK_INTERVAL) {
      lastDivergenceCheck = now;
      try {
        const divergences = await checkDivergence(store, chains);
        if (divergences.length > 0) {
          for (const d of divergences) {
            console.error(JSON.stringify({
              severity: "error",
              component: "daemon",
              event: "divergence_detected",
              chain_id: d.chainId,
              detail: d.detail,
              timestamp: new Date().toISOString(),
            }));
          }

          // Optional webhook.
          if (opts.anchorWebhookUrl) {
            try {
              await fetch(opts.anchorWebhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  event: "divergence_detected",
                  divergences: divergences.map((d) => ({ chain_id: d.chainId, detail: d.detail })),
                }),
              });
            } catch {
              // Webhook failed; don't let it crash the daemon.
            }
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(JSON.stringify({
          severity: "error",
          component: "daemon",
          event: "divergence_check_failed",
          error: msg,
          timestamp: new Date().toISOString(),
        }));
      }
    }

    // Update pending revocations metric.
    metrics.pending_revocations = store.revocations().length;

    // Tick all chains. Primary should anchor before mirrors get a chance
    // (anchorAll handles this).
    const primary = chains.find((c) => c.role === "primary");
    if (primary) {
      const chainState = state.get(primary.id)!;
      await tick(store, primary, opts.signer, now, chainState, opts);
    }

    // Tick mirrors.
    const mirrors = chains.filter((c) => c.role === "mirror");
    for (const mirror of mirrors) {
      const chainState = state.get(mirror.id)!;
      await tick(store, mirror, opts.signer, now, chainState, opts);
    }

    // Sleep before the next tick. Tick every second.
    await sleepFn(1000);
  }
}

/**
 * Expose metrics for monitoring (T-031 wires Prometheus later).
 */
export function getMetrics(): DaemonMetrics {
  return metrics;
}

/**
 * Get the per-chain state (for testing).
 */
export function getState(): Map<number, DaemonState> {
  return state;
}

// Entry point: pnpm log:daemon
async function main() {
  const DB = process.env.THENAR_LOG_DB ?? ".data/log.db";
  const ENV_CONTRACTS = process.env.THENAR_ENV_CONTRACTS ?? ".env.contracts";
  const ANCHOR_RELAYER_KEY = process.env.ANCHOR_RELAYER_KEY;

  if (!ANCHOR_RELAYER_KEY) {
    throw new Error("ANCHOR_RELAYER_KEY must be set in environment");
  }

  const signer = privateKeyToAccount(ANCHOR_RELAYER_KEY as Hex);
  const store = new LogStore(DB);

  console.log(`Daemon starting: store=${DB}, relayer=${signer.address}`);

  await runDaemon({
    store,
    signer,
    chains: loadChains(ENV_CONTRACTS),
    anchorIntervalSecondsPrimary: Number(process.env.ANCHOR_INTERVAL_SECONDS_PRIMARY ?? "3600"),
    anchorIntervalSecondsMirror: Number(process.env.ANCHOR_INTERVAL_SECONDS_MIRROR ?? "86400"),
    anchorWebhookUrl: process.env.ANCHOR_WEBHOOK_URL,
  });
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(JSON.stringify({
      severity: "error",
      component: "daemon",
      event: "fatal_error",
      error: e instanceof Error ? e.message : String(e),
      timestamp: new Date().toISOString(),
    }));
    process.exit(1);
  });
}
