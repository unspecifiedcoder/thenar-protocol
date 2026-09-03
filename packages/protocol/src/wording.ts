/**
 * T-021 — Badge engine fixed wording
 * PLAN §1 table verbatim; substitutions only.
 * Every surface must show badges with this wording exactly; forbidden words never appear.
 */
import type { Source } from "./schemas";

/**
 * Forbidden words that must never appear on any surface, except inside
 * "Checked by {operator} — {n} checks run: {list}. Heuristic; see details."
 */
export const FORBIDDEN_WORDS = ["authentic", "genuine", "real", "proven real", "verified", "independent"];

/**
 * L0 / Committed badge wording.
 * Substitutions: {block}, {chain}, {live|revoked at block {onset}}, {size}
 */
export function l0Wording(block: string, chain: string, consentStatus: "live" | { revoked_at_block: string }, size: string): string {
  const consentPart = consentStatus === "live"
    ? "live"
    : `revoked at block ${consentStatus.revoked_at_block}`;
  return `Committed — existed by block ${block} on ${chain}; log unchanged since; consent ${consentPart} as of anchor (size ${size}).`;
}

/**
 * L1 / Signed badge wording.
 * Substitutions: {org}
 */
export function l1Wording(org: string): string {
  return `Signed — ${org} signed this record before it was logged; unchanged since.`;
}

/**
 * L2 / Attested badge wording.
 * Substitutions: {manufacturer}, {model}
 */
export function l2Wording(manufacturer: string, model: string): string {
  return `Attested — signing key held in hardware attested by ${manufacturer} (${model}); this proves which device signed, not what its sensors saw.`;
}

/**
 * L3 / Checked badge wording.
 * Substitutions: {operator}, {n}, {list}
 */
export function l3Wording(operator: string, n: number, list: string): string {
  return `Checked by ${operator} — ${n} checks run: ${list}. Heuristic; see details.`;
}

/**
 * Pending wording (not a badge, but shown when not anchored).
 */
export function pendingWording(): string {
  return "Pending — received, not yet anchored.";
}

/**
 * Check failed wording (appended whenever any claim is `fail`).
 * Substitutions: {name}, {summary}
 */
export function checkFailedWording(name: string, summary: string): string {
  return `Check ${name} failed: ${summary}.`;
}

/* ------------------------------------------------------------------ *
 * PLAN §1.1 — the source axis (D-30), orthogonal to levels.
 *
 * Verbatim port of `apps/web/wording.js`'s source-axis section (T-026's
 * supervisor scope addition, landed ahead of this task); `verify.test.mjs`
 * asserts string equality between the two so they cannot drift apart.
 * Guard (I-16, §27 trap #23): the word "physical" must never appear on any
 * surface without "declared" or "attested" on the same line — every branch
 * below satisfies that by construction.
 * ------------------------------------------------------------------ */

const SOURCE_TEXT: Record<Source, string> = {
  sim: "simulation",
  teleop_sim: "human-driven simulation",
  teleop_real: "human-driven physical robot",
  autonomous_real: "autonomous physical robot",
  mixed: "mixed",
};

/**
 * `Source — declared by the signer: {text}. Not attested.` — the default
 * rendering for every `source` value, always used unless
 * `isAttestedPhysical` (below) holds.
 */
export function sourceWording(source: Source): string {
  const text = SOURCE_TEXT[source];
  if (!text) throw new Error(`unknown source "${source}"`);
  return `Source — declared by the signer: ${text}. Not attested.`;
}

/**
 * `Source — attested physical capture: controller key attested by
 * {manufacturer} ({model}); simulation-signature check passed.`
 */
export function attestedPhysicalWording(manufacturer: string, model: string): string {
  return `Source — attested physical capture: controller key attested by ${manufacturer} (${model}); simulation-signature check passed.`;
}

export type SourceAttestationSubject = "signer_device" | "robot_controller";

export interface SourceAttestation {
  level: number;
  subject: SourceAttestationSubject;
  manufacturer?: string;
  model?: string;
}

export interface SourceClaim {
  check: string;
  result: "pass" | "fail" | "inconclusive";
  issued_at?: number;
}

export interface AttestedPhysicalInput {
  source: Source;
  attestation?: SourceAttestation | null;
  claims?: SourceClaim[];
  hasVideoChannel?: boolean;
}

/**
 * The attested-physical rule, implemented exactly as PLAN §1.1 states it —
 * every clause is required, so an episode missing any of them simply never
 * satisfies it. Looks up the most recent claim of a check name among
 * `claims` (highest `issued_at`) and compares its `result`.
 */
export function isAttestedPhysical({ source, attestation, claims, hasVideoChannel }: AttestedPhysicalInput): boolean {
  if (source !== "teleop_real" && source !== "autonomous_real") return false;
  if (!attestation || attestation.level !== 2 || attestation.subject !== "robot_controller") return false;
  const latest = (check: string): string | undefined => {
    const matches = (claims || []).filter((c) => c.check === check);
    if (matches.length === 0) return undefined;
    // "latest" — the claim with the highest issued_at, or last in array if unordered.
    return matches.reduce((a, b) => ((b.issued_at ?? 0) >= (a.issued_at ?? 0) ? b : a)).result;
  };
  if (latest("sim_signature.v1") !== "pass") return false;
  if (hasVideoChannel && latest("sensor_consistency.v1") !== "pass") return false;
  return true;
}

export interface EpisodeSourceInput {
  source: Source;
  attestation?: SourceAttestation | null;
  claims?: SourceClaim[];
  hasVideoChannel?: boolean;
}

/**
 * Renders the correct source line for one episode: the attested template
 * if (and only if) `isAttestedPhysical` holds, else the declared template.
 * `attestation` (when the attested branch fires) supplies
 * `{manufacturer, model}`.
 */
export function episodeSourceWording(episode: EpisodeSourceInput): string {
  const attested = isAttestedPhysical({
    source: episode.source,
    attestation: episode.attestation,
    claims: episode.claims,
    hasVideoChannel: episode.hasVideoChannel,
  });
  if (attested) {
    return attestedPhysicalWording(episode.attestation!.manufacturer as string, episode.attestation!.model as string);
  }
  return sourceWording(episode.source);
}

export interface CorpusSourceEpisode {
  source: Source;
  attested: boolean;
}

/**
 * Corpus-level rollup: `Sources — {list}; {n} of {m} episodes declared
 * physical, {k} attested.` `episodes` is `[{source, attested}]`.
 */
export function corpusSourcesWording(episodes: CorpusSourceEpisode[]): string {
  const list = [...new Set(episodes.map((e) => e.source))].sort().join(", ");
  const m = episodes.length;
  const physicalSources = new Set(["teleop_real", "autonomous_real"]);
  const n = episodes.filter((e) => physicalSources.has(e.source)).length;
  const k = episodes.filter((e) => e.attested).length;
  return `Sources — ${list}; ${n} of ${m} episodes declared physical, ${k} attested.`;
}
