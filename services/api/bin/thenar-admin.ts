/**
 * Local-only admin CLI (PLAN §12 org endpoints, §25 Security, T-024):
 * creates organisations, issues org API keys and registers verifier
 * signing keys directly through `registry.ts` — no HTTP route exposes any
 * of this, on purpose (org creation and key issuance are operator actions,
 * not something any org can do to itself).
 *
 * Every subcommand needs `--token <value>` equal to the `ADMIN_TOKEN`
 * environment variable. A CLI arg alone proves nothing on its own — the
 * operator has to know the configured value, not merely have inherited
 * whatever the shell's environment happens to hold.
 *
 *   ADMIN_TOKEN=… pnpm admin create-org <name> <supplier|buyer|verifier> --token <token>
 *   ADMIN_TOKEN=… pnpm admin issue-key <orgId> <supplier|buyer|verifier|operator> --token <token>
 *   ADMIN_TOKEN=… pnpm admin register-verifier <orgId> <pubkeyHex> <ed25519|p256|secp256k1> --token <token>
 *
 * The store path comes from `THENAR_LOG_DB` (`services/log`, T-014), same
 * as `pnpm log` — this CLI writes to the same database the API reads.
 *
 * `tokenMatches` and `runAdminCommand` are exported and free of `process`
 * side effects (no `argv`, no `exit`) so `registry.test.ts` can exercise
 * every CLI flow by calling them directly, rather than spawning a
 * subprocess.
 */
import { timingSafeEqual } from "node:crypto";
import type { Hex } from "viem";
import { LogStore } from "../../log/src/store.ts";
import { Registry, type OrgKind, type Alg } from "../src/registry.ts";
import type { Role } from "../src/auth.ts";

export const ORG_KINDS: OrgKind[] = ["supplier", "buyer", "verifier"];
export const ROLES: Role[] = ["supplier", "buyer", "verifier", "operator"];
export const ALGS: Alg[] = ["ed25519", "p256", "secp256k1"];

/** Constant-time: `presented` must be given and byte-equal to `configured`. */
export function tokenMatches(configured: string | undefined, presented: string | undefined): boolean {
  if (!configured || !presented) return false;
  const a = Buffer.from(configured, "utf8");
  const b = Buffer.from(presented, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Runs one subcommand against `registry`; throws `Error` with a usage/validation message on bad input. Returns the JSON-able result to print. */
export function runAdminCommand(cmd: string | undefined, pos: string[], registry: Registry): unknown {
  if (cmd === "create-org") {
    const [name, kind] = pos;
    if (!name || !kind) throw new Error("usage: create-org <name> <supplier|buyer|verifier>");
    if (!ORG_KINDS.includes(kind as OrgKind)) throw new Error(`kind must be one of ${ORG_KINDS.join(", ")}`);
    return registry.createOrg(name, kind as OrgKind);
  }
  if (cmd === "issue-key") {
    const [orgId, role] = pos;
    if (!orgId || !role) throw new Error("usage: issue-key <orgId> <supplier|buyer|verifier|operator>");
    if (!ROLES.includes(role as Role)) throw new Error(`role must be one of ${ROLES.join(", ")}`);
    return registry.issueApiKey(orgId, role as Role);
  }
  if (cmd === "register-verifier") {
    const [orgId, pubkeyHex, alg] = pos;
    if (!orgId || !pubkeyHex || !alg) throw new Error("usage: register-verifier <orgId> <pubkeyHex> <ed25519|p256|secp256k1>");
    if (!ALGS.includes(alg as Alg)) throw new Error(`alg must be one of ${ALGS.join(", ")}`);
    return registry.registerKey(orgId, { alg: alg as Alg, pubkey: pubkeyHex.toLowerCase() as Hex });
  }
  throw new Error("usage: create-org <name> <kind> | issue-key <orgId> <role> | register-verifier <orgId> <pubkeyHex> <alg>");
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Positional args after the subcommand, with `--token <value>` stripped out. */
function positionals(): string[] {
  const rest = process.argv.slice(3);
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--token") { i++; continue; }
    out.push(rest[i]);
  }
  return out;
}

function main() {
  const configured = process.env.ADMIN_TOKEN;
  if (!configured) {
    console.error("ADMIN_TOKEN is not set in the environment — refusing to run (local-only, PLAN §25 Security).");
    process.exit(1);
  }
  if (!tokenMatches(configured, flag("token"))) {
    console.error("missing or wrong --token");
    process.exit(1);
  }

  const dbPath = process.env.THENAR_LOG_DB ?? ".data/log.db";
  const store = new LogStore(dbPath);
  const registry = new Registry(store);
  try {
    console.log(JSON.stringify(runAdminCommand(process.argv[2], positionals(), registry)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  } finally {
    store.close();
  }
}

// Only run when invoked directly (`pnpm admin …`), not when imported by tests.
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  main();
}
