/**
 * T-017 — `config/checks.json` loader.
 *
 * T-020 (claim issuance, worker, `CheckConfig`) does not exist yet (this
 * task's supervisor adjustment). `CheckConfig`'s shape here is exactly
 * what TASK-020.md's `Interfaces` block declares, so no shape migration is
 * needed once T-020 lands and takes over `config/checks.json`'s ownership:
 * `{ enabled, blocking, emit_fail }`, plus an optional per-check
 * `thresholds` object (`dedup.v1` carries `T_exact`/`T_near` there, PLAN
 * Sec10.9 "configuration" row, gated by FD-1 — `TASKS/CONFLICTS.md`).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "../../../packages/protocol/src/canonical.ts";

export type CheckConfig = {
  enabled: boolean;
  blocking: boolean;
  emit_fail: boolean;
  thresholds?: JsonObject;
};

export type ChecksConfig = Record<string, CheckConfig>;

/** `<repo root>/config/checks.json` — three levels up from `services/verify/src/`. */
const DEFAULT_CONFIG_PATH = fileURLToPath(new URL("../../../config/checks.json", import.meta.url));

export function loadChecksConfig(path: string = DEFAULT_CONFIG_PATH): ChecksConfig {
  const text = readFileSync(path, "utf8");
  return JSON.parse(text) as ChecksConfig;
}

/** Throws if `check` is not listed in `config/checks.json` — an unknown check must not silently run with defaults. */
export function getCheckConfig(check: string, path: string = DEFAULT_CONFIG_PATH): CheckConfig {
  const all = loadChecksConfig(path);
  const cfg = all[check];
  if (!cfg) throw new Error(`checks config: unknown check "${check}"`);
  return cfg;
}
