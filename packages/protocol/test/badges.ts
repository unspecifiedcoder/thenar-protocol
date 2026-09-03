/**
 * T-021 — Badge engine tests
 *
 * Truth table over all input combinations:
 * - anchored (yes/no)
 * - signature present and validAtAnchor (yes/no)
 * - attestation level 2 (yes/no)
 * - claims with blocking check pass/fail/inconclusive (3 × 2^3 = 24+ cases)
 *
 * Wording snapshot equals PLAN §1 strings exactly.
 */

import { computeBadges, type BadgeInput } from "../src/badges";
import {
  l0Wording, l1Wording, l2Wording, l3Wording, pendingWording, checkFailedWording,
} from "../src/wording";

let fails = 0;
const ok = (c: boolean, m: string, x = "") => {
  if (!c) fails++;
  console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`);
};

// ============================================================================
// Test 1: No anchor → pending, no badges
// ============================================================================
{
  const input: BadgeInput = {
    anchored: null,
    consent: { status: "live" },
    signature: null,
    attestation: null,
    claims: [],
    checksConfig: {},
  };
  const result = computeBadges(input);
  ok(result.pending === true, "Test 1a: not anchored → pending = true");
  ok(result.badges.length === 0, "Test 1b: not anchored → no badges");
  ok(result.wording.length === 1, "Test 1c: not anchored → 1 wording line (Pending)");
  ok(result.wording[0] === pendingWording(), "Test 1d: Pending wording matches");
}

// ============================================================================
// Test 2: Anchored, no signature → L0 only
// ============================================================================
{
  const input: BadgeInput = {
    anchored: { chain: "Avalanche C-Chain", block: "1000", size: "42" },
    consent: { status: "live" },
    signature: null,
    attestation: null,
    claims: [],
    checksConfig: {},
  };
  const result = computeBadges(input);
  ok(result.pending === false, "Test 2a: anchored → pending = false");
  ok(result.badges.includes("L0"), "Test 2b: anchored → L0 present");
  ok(!result.badges.includes("L1"), "Test 2c: no signature → no L1");
  ok(result.wording[0].includes("existed by block 1000"), "Test 2d: L0 wording has block");
  ok(result.wording[0].includes("Avalanche C-Chain"), "Test 2e: L0 wording has chain");
  ok(result.wording[0].includes("size 42"), "Test 2f: L0 wording has size");
}

// ============================================================================
// Test 3: Anchored with revoked consent → L0 mentions onset
// ============================================================================
{
  const input: BadgeInput = {
    anchored: { chain: "Avalanche C-Chain", block: "1000", size: "50" },
    consent: { status: "revoked", onset: "800" },
    signature: null,
    attestation: null,
    claims: [],
    checksConfig: {},
  };
  const result = computeBadges(input);
  ok(result.wording[0].includes("revoked at block 800"), "Test 3a: revoked consent shown in L0");
  ok(!result.wording[0].includes("consent live"), "Test 3b: live not mentioned for revoked");
}

// ============================================================================
// Test 4: Signature present but validAtAnchor=false → no L1
// ============================================================================
{
  const input: BadgeInput = {
    anchored: { chain: "Avalanche C-Chain", block: "1000", size: "42" },
    consent: { status: "live" },
    signature: { keyId: "0x123", org: "Acme Corp", validAtAnchor: false },
    attestation: null,
    claims: [],
    checksConfig: {},
  };
  const result = computeBadges(input);
  ok(!result.badges.includes("L1"), "Test 4a: validAtAnchor=false → no L1");
  ok(result.badges.includes("L0"), "Test 4b: L0 still present");
}

// ============================================================================
// Test 5: Signature present and validAtAnchor=true → L1 present
// ============================================================================
{
  const input: BadgeInput = {
    anchored: { chain: "Avalanche C-Chain", block: "1000", size: "42" },
    consent: { status: "live" },
    signature: { keyId: "0x123", org: "Acme Corp", validAtAnchor: true },
    attestation: null,
    claims: [],
    checksConfig: {},
  };
  const result = computeBadges(input);
  ok(result.badges.includes("L1"), "Test 5a: validAtAnchor=true → L1 present");
  ok(result.wording.some(w => w.includes("Acme Corp")), "Test 5b: L1 wording has org name");
  ok(result.wording.some(w => w.includes("Signed —")), "Test 5c: L1 wording starts with 'Signed —'");
}

// ============================================================================
// Test 6: L1 without attestation.level 2 → no L2
// ============================================================================
{
  const input: BadgeInput = {
    anchored: { chain: "Avalanche C-Chain", block: "1000", size: "42" },
    consent: { status: "live" },
    signature: { keyId: "0x123", org: "Acme Corp", validAtAnchor: true },
    attestation: null,
    claims: [],
    checksConfig: {},
  };
  const result = computeBadges(input);
  ok(result.badges.includes("L1"), "Test 6a: L1 present");
  ok(!result.badges.includes("L2"), "Test 6b: no attestation → no L2");
}

// ============================================================================
// Test 7: L1 + attestation.level 2 → L2 present
// ============================================================================
{
  const input: BadgeInput = {
    anchored: { chain: "Avalanche C-Chain", block: "1000", size: "42" },
    consent: { status: "live" },
    signature: { keyId: "0x123", org: "Acme Corp", validAtAnchor: true },
    attestation: { level: 2, manufacturer: "Apple", model: "iPhone 15" },
    claims: [],
    checksConfig: {},
  };
  const result = computeBadges(input);
  ok(result.badges.includes("L1"), "Test 7a: L1 present");
  ok(result.badges.includes("L2"), "Test 7b: attestation.level 2 → L2 present");
  ok(result.wording.some(w => w.includes("Apple")), "Test 7c: L2 wording has manufacturer");
  ok(result.wording.some(w => w.includes("iPhone 15")), "Test 7d: L2 wording has model");
}

// ============================================================================
// Test 8: L0 without L1, with attestation → no L2 (L2 requires L1)
// ============================================================================
{
  const input: BadgeInput = {
    anchored: { chain: "Avalanche C-Chain", block: "1000", size: "42" },
    consent: { status: "live" },
    signature: null,
    attestation: { level: 2, manufacturer: "Apple", model: "iPhone 15" },
    claims: [],
    checksConfig: {},
  };
  const result = computeBadges(input);
  ok(result.badges.includes("L0"), "Test 8a: L0 present");
  ok(!result.badges.includes("L1"), "Test 8b: no signature → no L1");
  ok(!result.badges.includes("L2"), "Test 8c: no L1 → no L2 (even with attestation)");
}

// ============================================================================
// Test 9: Blocking check inconclusive → no L3
// ============================================================================
{
  const input: BadgeInput = {
    anchored: { chain: "Avalanche C-Chain", block: "1000", size: "42" },
    consent: { status: "live" },
    signature: { keyId: "0x123", org: "Acme", validAtAnchor: true },
    attestation: null,
    claims: [
      {
        check: "timing.v1",
        result: "inconclusive",
        issued_at: 1000,
        detail: { summary: "insufficient data" },
      },
    ],
    checksConfig: {
      "timing.v1": { enabled: true, blocking: true, emit_fail: true },
    },
  };
  const result = computeBadges(input);
  ok(!result.badges.includes("L3"), "Test 9a: blocking check inconclusive → no L3");
  ok(result.failed.length === 0, "Test 9b: inconclusive result not in failed list");
}

// ============================================================================
// Test 10: All blocking checks pass → L3 possible (if no enabled check fails)
// ============================================================================
{
  const input: BadgeInput = {
    anchored: { chain: "Avalanche C-Chain", block: "1000", size: "42" },
    consent: { status: "live" },
    signature: { keyId: "0x123", org: "Acme", validAtAnchor: true },
    attestation: null,
    claims: [
      {
        check: "timing.v1",
        result: "pass",
        issued_at: 1000,
      },
      {
        check: "kinematics.v1",
        result: "pass",
        issued_at: 1000,
      },
    ],
    checksConfig: {
      "timing.v1": { enabled: true, blocking: true, emit_fail: true },
      "kinematics.v1": { enabled: true, blocking: true, emit_fail: true },
    },
  };
  const result = computeBadges(input);
  ok(result.badges.includes("L3"), "Test 10a: all blocking checks pass → L3");
  ok(result.wording.some(w => w.includes("Checked by")), "Test 10b: L3 wording present");
}

// ============================================================================
// Test 11: Non-blocking check fails → fails list, but L3 still possible
// ============================================================================
{
  const input: BadgeInput = {
    anchored: { chain: "Avalanche C-Chain", block: "1000", size: "42" },
    consent: { status: "live" },
    signature: { keyId: "0x123", org: "Acme", validAtAnchor: true },
    attestation: null,
    claims: [
      {
        check: "timing.v1",
        result: "pass",
        issued_at: 1000,
      },
      {
        check: "dedup.v1",
        result: "fail",
        issued_at: 1000,
        detail: { summary: "possible duplicate" },
      },
    ],
    checksConfig: {
      "timing.v1": { enabled: true, blocking: true, emit_fail: true },
      "dedup.v1": { enabled: true, blocking: false, emit_fail: false },
    },
  };
  const result = computeBadges(input);
  ok(!result.badges.includes("L3"), "Test 11a: any enabled check fails → no L3");
  ok(result.failed.length === 1, "Test 11b: failed check in failed list");
  ok(result.failed[0].check === "dedup.v1", "Test 11c: correct check name in failed");
  ok(result.wording.some(w => w.includes("Check dedup.v1 failed")), "Test 11d: check failed wording present");
}

// ============================================================================
// Test 12: Blocking check fails → no L3
// ============================================================================
{
  const input: BadgeInput = {
    anchored: { chain: "Avalanche C-Chain", block: "1000", size: "42" },
    consent: { status: "live" },
    signature: { keyId: "0x123", org: "Acme", validAtAnchor: true },
    attestation: null,
    claims: [
      {
        check: "timing.v1",
        result: "fail",
        issued_at: 1000,
        detail: { summary: "jitter too high" },
      },
    ],
    checksConfig: {
      "timing.v1": { enabled: true, blocking: true, emit_fail: true },
    },
  };
  const result = computeBadges(input);
  ok(!result.badges.includes("L3"), "Test 12a: blocking check fails → no L3");
  ok(result.failed.includes(result.failed.find(f => f.check === "timing.v1")!), "Test 12b: failed check listed");
}

// ============================================================================
// Test 13: Disabled check ignored (even if it would block)
// ============================================================================
{
  const input: BadgeInput = {
    anchored: { chain: "Avalanche C-Chain", block: "1000", size: "42" },
    consent: { status: "live" },
    signature: { keyId: "0x123", org: "Acme", validAtAnchor: true },
    attestation: null,
    claims: [
      {
        check: "timing.v1",
        result: "fail",
        issued_at: 1000,
        detail: { summary: "jitter too high" },
      },
    ],
    checksConfig: {
      "timing.v1": { enabled: false, blocking: true, emit_fail: true },
    },
  };
  const result = computeBadges(input);
  ok(result.badges.includes("L3"), "Test 13a: disabled check doesn't prevent L3");
  ok(result.failed.length === 0, "Test 13b: disabled check not in failed list");
}

// ============================================================================
// Test 14: Latest claim per check wins (higher issued_at)
// ============================================================================
{
  const input: BadgeInput = {
    anchored: { chain: "Avalanche C-Chain", block: "1000", size: "42" },
    consent: { status: "live" },
    signature: { keyId: "0x123", org: "Acme", validAtAnchor: true },
    attestation: null,
    claims: [
      {
        check: "timing.v1",
        result: "fail",
        issued_at: 500,
        detail: { summary: "old failure" },
      },
      {
        check: "timing.v1",
        result: "pass",
        issued_at: 1000,
        detail: { summary: "later pass" },
      },
    ],
    checksConfig: {
      "timing.v1": { enabled: true, blocking: true, emit_fail: true },
    },
  };
  const result = computeBadges(input);
  ok(result.badges.includes("L3"), "Test 14a: latest claim is 'pass' → L3");
  ok(result.failed.length === 0, "Test 14b: old failure superseded by later pass");
}

// ============================================================================
// Test 15: Multiple failures listed
// ============================================================================
{
  const input: BadgeInput = {
    anchored: { chain: "Avalanche C-Chain", block: "1000", size: "42" },
    consent: { status: "live" },
    signature: { keyId: "0x123", org: "Acme", validAtAnchor: true },
    attestation: null,
    claims: [
      {
        check: "timing.v1",
        result: "fail",
        issued_at: 1000,
        detail: { summary: "jitter too high" },
      },
      {
        check: "kinematics.v1",
        result: "fail",
        issued_at: 1000,
        detail: { summary: "impossible trajectory" },
      },
    ],
    checksConfig: {
      "timing.v1": { enabled: true, blocking: true, emit_fail: true },
      "kinematics.v1": { enabled: true, blocking: true, emit_fail: true },
    },
  };
  const result = computeBadges(input);
  ok(result.failed.length === 2, "Test 15a: two failures listed");
  ok(result.wording.filter(w => w.includes("Check")).length === 2, "Test 15b: two check-failed lines in wording");
}

// ============================================================================
// Test 16: No signature + valid attestation → no L1, no L2
// ============================================================================
{
  const input: BadgeInput = {
    anchored: { chain: "Avalanche C-Chain", block: "1000", size: "42" },
    consent: { status: "live" },
    signature: null,
    attestation: { level: 2, manufacturer: "Apple", model: "iPhone" },
    claims: [],
    checksConfig: {},
  };
  const result = computeBadges(input);
  ok(!result.badges.includes("L1"), "Test 16a: no signature → no L1");
  ok(!result.badges.includes("L2"), "Test 16b: no L1 → no L2 even with attestation");
}

// ============================================================================
// Test 17: Wording for L0 live consent
// ============================================================================
{
  const input: BadgeInput = {
    anchored: { chain: "Ethereum Sepolia", block: "2000", size: "100" },
    consent: { status: "live" },
    signature: null,
    attestation: null,
    claims: [],
    checksConfig: {},
  };
  const result = computeBadges(input);
  ok(result.wording[0].includes("consent live as of anchor"), "Test 17a: L0 shows 'consent live'");
}

// ============================================================================
// Test 18: Empty claims with enabled checks → L3 fails (no check claims)
// ============================================================================
{
  const input: BadgeInput = {
    anchored: { chain: "Avalanche C-Chain", block: "1000", size: "42" },
    consent: { status: "live" },
    signature: { keyId: "0x123", org: "Acme", validAtAnchor: true },
    attestation: null,
    claims: [],
    checksConfig: {
      "timing.v1": { enabled: true, blocking: true, emit_fail: true },
    },
  };
  const result = computeBadges(input);
  ok(!result.badges.includes("L3"), "Test 18a: no claims for blocking check → no L3");
}

// ============================================================================
// Test 19: Wording snapshot — L0 exact format
// ============================================================================
{
  const block = "123", chain = "Test Chain", size = "50";
  const wording = l0Wording(block, chain, "live", size);
  const expected = "Committed — existed by block 123 on Test Chain; log unchanged since; consent live as of anchor (size 50).";
  ok(wording === expected, "Test 19: L0 wording exact match", wording !== expected ? `got: ${wording}` : "");
}

// ============================================================================
// Test 20: Wording snapshot — L1 exact format
// ============================================================================
{
  const org = "Test Org";
  const wording = l1Wording(org);
  const expected = "Signed — Test Org signed this record before it was logged; unchanged since.";
  ok(wording === expected, "Test 20: L1 wording exact match", wording !== expected ? `got: ${wording}` : "");
}

// ============================================================================
// Test 21: Wording snapshot — L2 exact format
// ============================================================================
{
  const manufacturer = "Samsung", model = "Galaxy S24";
  const wording = l2Wording(manufacturer, model);
  const expected = "Attested — signing key held in hardware attested by Samsung (Galaxy S24); this proves which device signed, not what its sensors saw.";
  ok(wording === expected, "Test 21: L2 wording exact match", wording !== expected ? `got: ${wording}` : "");
}

// ============================================================================
// Test 22: Wording snapshot — Pending exact format
// ============================================================================
{
  const wording = pendingWording();
  const expected = "Pending — received, not yet anchored.";
  ok(wording === expected, "Test 22: Pending wording exact match", wording !== expected ? `got: ${wording}` : "");
}

// ============================================================================
// Test 23: Wording snapshot — Check failed exact format
// ============================================================================
{
  const name = "timing.v1", summary = "jitter too high";
  const wording = checkFailedWording(name, summary);
  const expected = "Check timing.v1 failed: jitter too high.";
  ok(wording === expected, "Test 23: Check failed wording exact match", wording !== expected ? `got: ${wording}` : "");
}

// ============================================================================
// Test 24: Complex scenario: L0+L1+L2 with mixed checks
// ============================================================================
{
  const input: BadgeInput = {
    anchored: { chain: "Avalanche C-Chain", block: "1500", size: "75" },
    consent: { status: "revoked", onset: "1200" },
    signature: { keyId: "0x456", org: "RoboData Inc", validAtAnchor: true },
    attestation: { level: 2, manufacturer: "Google", model: "Tensor 4" },
    claims: [
      {
        check: "timing.v1",
        result: "pass",
        issued_at: 2000,
      },
      {
        check: "kinematics.v1",
        result: "pass",
        issued_at: 2000,
      },
      {
        check: "dedup.v1",
        result: "inconclusive",
        issued_at: 2000,
      },
    ],
    checksConfig: {
      "timing.v1": { enabled: true, blocking: true, emit_fail: true },
      "kinematics.v1": { enabled: true, blocking: true, emit_fail: true },
      "dedup.v1": { enabled: true, blocking: false, emit_fail: false },
    },
  };
  const result = computeBadges(input);
  ok(result.badges.includes("L0"), "Test 24a: has L0");
  ok(result.badges.includes("L1"), "Test 24b: has L1");
  ok(result.badges.includes("L2"), "Test 24c: has L2");
  ok(result.badges.includes("L3"), "Test 24d: has L3");
  ok(result.badges.length === 4, "Test 24e: exactly 4 badges (L0, L1, L2, L3)");
  ok(result.wording[0].includes("revoked at block 1200"), "Test 24f: L0 mentions revocation");
  ok(result.wording.some(w => w.includes("RoboData Inc")), "Test 24g: L1 mentions org");
  ok(result.wording.some(w => w.includes("Google")), "Test 24h: L2 mentions manufacturer");
  ok(result.wording.some(w => w.includes("Checked by")), "Test 24i: L3 present");
  ok(!result.pending, "Test 24j: not pending");
  ok(result.failed.length === 0, "Test 24k: no failed checks");
}

console.log(fails === 0 ? "\nbadges: all checks passed\n" : `\n${fails} check(s) failed\n`);
process.exit(fails ? 1 : 0);
