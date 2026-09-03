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
