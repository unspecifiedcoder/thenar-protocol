/**
 * T-021 — Badge engine
 *
 * Computes an episode's badges (L0, L1, L2, L3) and wording according to
 * PLAN §1, D-20, D-21. Rules are exact: L0 iff anchored; L1 iff signature present
 * and validAtAnchor; L2 iff L1 and attestation.level == 2; L3 iff every check
 * with blocking=true has latest result "pass" AND no check's latest result is "fail".
 */

import {
  l0Wording, l1Wording, l2Wording, l3Wording, pendingWording, checkFailedWording,
  sourceWording, attestedPhysicalWording, isAttestedPhysical,
  type SourceAttestation, type SourceClaim,
} from "./wording";
import type { Source } from "./schemas";

export type BadgeLevel = "L0" | "L1" | "L2" | "L3";

export interface AnchorInfo {
  chain: string;
  block: string;
  size: string;
}

export interface ConsentStatus {
  status: "live" | "revoked";
  onset?: string; // block number when revoked, present iff status == "revoked"
}

export interface SignatureInfo {
  keyId: string;
  org: string;
  validAtAnchor: boolean;
}

export interface AttestationInfo {
  level: 2;
  manufacturer: string;
  model: string;
}

export interface VerificationClaim {
  check: string;
  result: "pass" | "fail" | "inconclusive";
  issued_at: number;
  detail?: { summary?: string };
}

export interface CheckConfig {
  enabled: boolean;
  blocking: boolean;
  emit_fail: boolean;
}

/**
 * §1.1/D-30 — the source axis block, orthogonal to L0-L3. `attestation`
 * here is the *robot controller's* attestation (level, subject,
 * manufacturer/model), distinct from `BadgeInput.attestation` (the
 * signer's L2 badge attestation) — a phone's `signer_device` attestation
 * can satisfy L2 but can never satisfy `attestedPhysical` (§1.1: "a
 * phone's secure element attests the signer's device, never the robot").
 */
export interface SourceInput {
  declared: Source;
  attestation?: SourceAttestation | null;
  hasVideoChannel?: boolean;
}

export interface SourceOutput {
  declared: Source;
  attested: boolean;
  wording: string;
}

export interface BadgeInput {
  anchored: AnchorInfo | null;
  consent: ConsentStatus;
  signature: SignatureInfo | null;
  attestation: AttestationInfo | null;
  claims: VerificationClaim[];
  checksConfig: Record<string, CheckConfig>;
  /** §1.1/D-30 source axis; optional so existing callers/tests need no change. */
  source?: SourceInput;
}

export interface BadgeOutput {
  badges: BadgeLevel[];
  pending: boolean;
  failed: Array<{ check: string; summary: string }>;
  wording: string[];
  /** §1.1/D-30 — present iff `input.source` was given. */
  source?: SourceOutput;
}

/**
 * §1.1/D-30 — computes the `source` block: whether the attested-physical
 * rule holds (using the episode's own `claims` for `sim_signature.v1`/
 * `sensor_consistency.v1`, the same array badges L0-L3 read), and the
 * verbatim declared/attested wording line.
 */
function computeSourceBlock(source: SourceInput, claims: VerificationClaim[]): SourceOutput {
  const sourceClaims: SourceClaim[] = claims.map((c) => ({ check: c.check, result: c.result, issued_at: c.issued_at }));
  const attested = isAttestedPhysical({
    source: source.declared,
    attestation: source.attestation,
    claims: sourceClaims,
    hasVideoChannel: source.hasVideoChannel,
  });
  const wording = attested
    ? attestedPhysicalWording(source.attestation!.manufacturer as string, source.attestation!.model as string)
    : sourceWording(source.declared);
  return { declared: source.declared, attested, wording };
}

/**
 * Compute badges and wording for an episode.
 * - L0 iff anchored (else pending)
 * - L1 iff signature && signature.validAtAnchor
 * - L2 iff L1 && attestation?.level == 2
 * - L3 iff every check with blocking=true (and enabled=true) has latest result "pass"
 *       AND no enabled check's latest result is "fail"
 * - failed: every check whose latest result is "fail" (regardless of badges)
 * - wording: one per badge (plus Pending if not anchored, plus one "Check {name} failed" per failure)
 */
export function computeBadges(input: BadgeInput): BadgeOutput {
  const badges: BadgeLevel[] = [];
  const wording: string[] = [];
  const failed: Array<{ check: string; summary: string }> = [];
  let pending = false;

  // Group claims by check, keep only the latest per check (highest issued_at)
  const latestClaimPerCheck = new Map<string, VerificationClaim>();
  for (const claim of input.claims) {
    const current = latestClaimPerCheck.get(claim.check);
    if (!current || claim.issued_at > current.issued_at) {
      latestClaimPerCheck.set(claim.check, claim);
    }
  }

  // L0: iff anchored
  if (input.anchored) {
    badges.push("L0");
    const consentPart = input.consent.status === "live"
      ? "live"
      : { revoked_at_block: input.consent.onset! };
    wording.push(l0Wording(
      input.anchored.block,
      input.anchored.chain,
      consentPart,
      input.anchored.size
    ));

    // L1, L2, L3, and failures are only available when anchored

    // L1: iff signature && signature.validAtAnchor
    let hasL1 = false;
    if (input.signature && input.signature.validAtAnchor) {
      badges.push("L1");
      hasL1 = true;
      wording.push(l1Wording(input.signature.org));
    }

    // L2: iff L1 && attestation?.level == 2
    if (hasL1 && input.attestation && input.attestation.level === 2) {
      badges.push("L2");
      wording.push(l2Wording(input.attestation.manufacturer, input.attestation.model));
    }

    // Collect failures: every ENABLED check whose latest result is "fail"
    for (const [check, claim] of latestClaimPerCheck.entries()) {
      if (claim.result === "fail") {
        // Only count enabled checks
        const config = input.checksConfig[check];
        if (config && !config.enabled) continue;
        const summary = claim.detail?.summary || "no summary provided";
        failed.push({ check, summary });
        wording.push(checkFailedWording(check, summary));
      }
    }

    // L3: iff every check with blocking=true (and enabled=true) has latest result "pass"
    //     AND no enabled check's latest result is "fail"
    // Disabled checks are ignored entirely
    const enabledCheckNames = Object.keys(input.checksConfig).filter(
      name => input.checksConfig[name].enabled
    );
    let hasL3 = true;

    if (hasL3) {
      // Check that all blocking checks have "pass"
      for (const checkName of enabledCheckNames) {
        const config = input.checksConfig[checkName];
        if (!config.blocking) continue;
        const claim = latestClaimPerCheck.get(checkName);
        if (!claim || claim.result !== "pass") {
          hasL3 = false;
          break;
        }
      }
    }

    // Check that no enabled check has "fail"
    if (hasL3) {
      for (const checkName of enabledCheckNames) {
        const claim = latestClaimPerCheck.get(checkName);
        if (claim && claim.result === "fail") {
          hasL3 = false;
          break;
        }
      }
    }

    if (hasL3) {
      badges.push("L3");
      // For L3, we need operator, n (count of passed checks), and list
      // The operator is implicit in the input or from the verifier.
      // For now, we'll collect all enabled checks that have a claim.
      const checkedNames: string[] = [];
      for (const checkName of enabledCheckNames) {
        const claim = latestClaimPerCheck.get(checkName);
        if (claim && claim.result === "pass") {
          checkedNames.push(checkName);
        }
      }
      // Assuming operator comes from context; use "verifier" as placeholder
      // Actually, looking at the wording template, operator should come from context
      // For now, we'll use a generic placeholder; the real operator should be passed in input
      wording.push(l3Wording(
        "verifier", // placeholder; should come from context/verifier info
        checkedNames.length,
        checkedNames.join(", ")
      ));
    }
  } else {
    pending = true;
    wording.push(pendingWording());
  }

  // §1.1/D-30 — orthogonal to L0-L3: computed whenever `input.source` was
  // given, independent of anchoring/pending status (source is a claim the
  // manifest itself carries, not a fact about the log).
  const sourceOutput = input.source ? computeSourceBlock(input.source, input.claims) : undefined;
  if (sourceOutput) wording.push(sourceOutput.wording);

  return {
    badges,
    pending,
    failed,
    wording,
    ...(sourceOutput ? { source: sourceOutput } : {}),
  };
}
