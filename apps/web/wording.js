/* wording.js — T-021 badge engine fixed wording, verbatim port of
 * `packages/protocol/src/wording.ts` for the browser.
 *
 * PLAN §1 table verbatim; substitutions only. Every surface must show
 * badges with this wording exactly; forbidden words never appear.
 * `verify.test.mjs` asserts string equality against `wording.ts` so the two
 * cannot drift apart.
 */

/**
 * Forbidden words that must never appear on any surface, except inside
 * "Checked by {operator} — {n} checks run: {list}. Heuristic; see details."
 */
export const FORBIDDEN_WORDS = ["authentic", "genuine", "real", "proven real", "verified", "independent"];

/**
 * L0 / Committed badge wording.
 * Substitutions: {block}, {chain}, {live|revoked at block {onset}}, {size}
 */
export function l0Wording(block, chain, consentStatus, size) {
  const consentPart = consentStatus === "live"
    ? "live"
    : `revoked at block ${consentStatus.revoked_at_block}`;
  return `Committed — existed by block ${block} on ${chain}; log unchanged since; consent ${consentPart} as of anchor (size ${size}).`;
}

/**
 * L1 / Signed badge wording.
 * Substitutions: {org}
 */
export function l1Wording(org) {
  return `Signed — ${org} signed this record before it was logged; unchanged since.`;
}

/**
 * L2 / Attested badge wording.
 * Substitutions: {manufacturer}, {model}
 */
export function l2Wording(manufacturer, model) {
  return `Attested — signing key held in hardware attested by ${manufacturer} (${model}); this proves which device signed, not what its sensors saw.`;
}

/**
 * L3 / Checked badge wording.
 * Substitutions: {operator}, {n}, {list}
 */
export function l3Wording(operator, n, list) {
  return `Checked by ${operator} — ${n} checks run: ${list}. Heuristic; see details.`;
}

/**
 * Pending wording (not a badge, but shown when not anchored).
 */
export function pendingWording() {
  return "Pending — received, not yet anchored.";
}

/**
 * Check failed wording (appended whenever any claim is `fail`).
 * Substitutions: {name}, {summary}
 */
export function checkFailedWording(name, summary) {
  return `Check ${name} failed: ${summary}.`;
}

/* ------------------------------------------------------------------ *
 * PLAN §1.1 — the source axis (D-30), orthogonal to levels.
 *
 * Not yet in `packages/protocol/src/wording.ts` (T-040 lands it there);
 * this is a direct, verbatim port of the §1.1 table and the
 * attested-physical template, added here per T-026's supervisor scope
 * addition so `/verify` never renders a declared `source` as unqualified
 * "physical". Guard (I-16, §27 trap #23): the word "physical" must never
 * appear on this page without "declared" or "attested" on the same line —
 * every branch below satisfies that by construction.
 * ------------------------------------------------------------------ */

const SOURCE_TEXT = {
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
export function sourceWording(source) {
  const text = SOURCE_TEXT[source];
  if (!text) throw new Error(`unknown source "${source}"`);
  return `Source — declared by the signer: ${text}. Not attested.`;
}

/**
 * `Source — attested physical capture: controller key attested by
 * {manufacturer} ({model}); simulation-signature check passed.`
 */
export function attestedPhysicalWording(manufacturer, model) {
  return `Source — attested physical capture: controller key attested by ${manufacturer} (${model}); simulation-signature check passed.`;
}

/**
 * The attested-physical rule, implemented exactly as PLAN §1.1 states it —
 * every clause is required, so a report missing any of them (which is
 * every report today; no episode carries `attestation`/`checks` shaped
 * this way yet) simply never satisfies it. `latestCheckResult(check)` looks
 * up the most recent claim of that check name among `claims` and returns
 * its `result`, or `undefined` if none exists.
 */
export function isAttestedPhysical({ source, attestation, claims, hasVideoChannel }) {
  if (source !== "teleop_real" && source !== "autonomous_real") return false;
  if (!attestation || attestation.level !== 2 || attestation.subject !== "robot_controller") return false;
  const latest = (check) => {
    const matches = (claims || []).filter((c) => c.check === check);
    if (matches.length === 0) return undefined;
    // "latest" — the claim with the highest issued_at, or last in array if unordered.
    return matches.reduce((a, b) => ((b.issued_at ?? 0) >= (a.issued_at ?? 0) ? b : a)).result;
  };
  if (latest("sim_signature.v1") !== "pass") return false;
  if (hasVideoChannel && latest("sensor_consistency.v1") !== "pass") return false;
  return true;
}

/**
 * Renders the correct source line for one episode: the attested template
 * if (and only if) `isAttestedPhysical` holds, else the declared template.
 * `attestation` (when the attested branch fires) supplies
 * `{manufacturer, model}`.
 */
export function episodeSourceWording(episode) {
  const attested = isAttestedPhysical({
    source: episode.source,
    attestation: episode.attestation,
    claims: episode.claims,
    hasVideoChannel: episode.hasVideoChannel,
  });
  if (attested) {
    return attestedPhysicalWording(episode.attestation.manufacturer, episode.attestation.model);
  }
  return sourceWording(episode.source);
}

/**
 * Corpus-level rollup: `Sources — {list}; {n} of {m} episodes declared
 * physical, {k} attested.` `episodes` is `[{source, attested}]`.
 */
export function corpusSourcesWording(episodes) {
  const list = [...new Set(episodes.map((e) => e.source))].sort().join(", ");
  const m = episodes.length;
  const physicalSources = new Set(["teleop_real", "autonomous_real"]);
  const n = episodes.filter((e) => physicalSources.has(e.source)).length;
  const k = episodes.filter((e) => e.attested).length;
  return `Sources — ${list}; ${n} of ${m} episodes declared physical, ${k} attested.`;
}
