/**
 * Chain targets the anchorer writes to.
 *
 * `GraspLog` is deployed byte-identical on a primary chain and one or more
 * mirrors (D-9); this file is what tells the service which chains those are.
 * The format is `.env.contracts` — `CHAIN_<id>_<FIELD>=value` lines, produced
 * by the deploy scripts (T-009) — never a hard-coded chain object, so the
 * service and the deploy tooling agree on one source of addresses.
 */
import { existsSync, readFileSync } from "node:fs";
import type { Hex } from "viem";

export type ChainRole = "primary" | "mirror";

export type ChainTarget = {
  id: number;
  name: string;
  rpc: string;
  log: Hex;
  confirmations: number;
  role: ChainRole;
};

const KNOWN_NAMES: Record<number, string> = {
  43113: "Avalanche Fuji",
  11155111: "Ethereum Sepolia",
};

/** Parse a `KEY=value` file, one assignment per line; `#` comments and blank lines are skipped. */
export function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i === -1) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const CHAIN_KEY = /^CHAIN_(\d+)_([A-Z_]+)$/;

/**
 * Load every `CHAIN_<id>_*` target from `path` (default `.env.contracts`).
 * Only `ROLE`, `LOG` and `RPC` are read here — `VERIFIER`, `REGISTRY` and
 * `FROM_BLOCK` exist for other consumers (deploy scripts, `chains.js`
 * generation, T-009) and are ignored by the anchorer.
 *
 * Returns the primary chain first, then mirrors ordered by chain id, so
 * `anchorAll` can anchor the primary before any mirror without re-sorting.
 */
export function loadChains(path = ".env.contracts"): ChainTarget[] {
  const env = parseEnvFile(path);
  const ids = new Set<number>();
  for (const key of Object.keys(env)) {
    const m = CHAIN_KEY.exec(key);
    if (m) ids.add(Number(m[1]));
  }

  const targets: ChainTarget[] = [];
  for (const id of ids) {
    const role = env[`CHAIN_${id}_ROLE`];
    const log = env[`CHAIN_${id}_LOG`];
    const rpc = env[`CHAIN_${id}_RPC`];
    if (role !== "primary" && role !== "mirror") {
      throw new Error(`CHAIN_${id}_ROLE must be "primary" or "mirror" in ${path}, got ${JSON.stringify(role)}`);
    }
    if (!log) throw new Error(`CHAIN_${id}_LOG missing from ${path}`);
    if (!rpc) throw new Error(`CHAIN_${id}_RPC missing from ${path}`);
    targets.push({
      id,
      name: env[`CHAIN_${id}_NAME`] ?? KNOWN_NAMES[id] ?? `chain ${id}`,
      rpc,
      log: log as Hex,
      confirmations: Number(env[`CHAIN_${id}_CONFIRMATIONS`] ?? "1"),
      role,
    });
  }

  const primaries = targets.filter((t) => t.role === "primary");
  if (targets.length > 0 && primaries.length !== 1) {
    throw new Error(`${path} must declare exactly one primary chain; found ${primaries.length}`);
  }
  const mirrors = targets.filter((t) => t.role === "mirror").sort((a, b) => a.id - b.id);
  return [...primaries, ...mirrors];
}
