# T-023 — Attestation ingestion — Phase D, optional; FRONTIER gate FD-3

**Tier:** STRONG implementation; **FD-3** decides pinned roots and the
supported-device list before any key is marked level 2 in production.

## What is honestly supported (D-25)
| Platform | Evidence | Status |
| --- | --- | --- |
| Android (Google-certified devices, e.g. Pixel) | Key Attestation X.509 chain to Google hardware root; `TrustedEnvironment`/`StrongBox` | implementable now |
| iOS/macOS apps | App Attest (P-256) | implementable now |
| PC/NUC rigs with TPM 2.0 | `TPM2_Certify` + AK chain to manufacturer EK root | implementable; root list per vendor (FD-3) |
| Meta Quest (Horizon OS) | not Google-certified; Key Attestation chain unverified | **unsupported until proven** |
| NVIDIA Jetson | no TPM by default | unsupported without add-on TPM |

## What L2 proves / does not
Proves: the registered key is hardware-resident on a device whose
manufacturer chain roots to a pinned root; model/OS facts carried by the
attestation. Does not prove: that sensors produced the signed bytes; app
integrity beyond the attestation's own statements.

## Objective
`verifyAttestation({platform, blob, nonce, pubkey})` → `{level: 1|2, platform, model?, securityLevel?, chainRoot, detail}`; nonce issued by `POST /orgs/{id}/keys/challenge` (10-minute validity, single use).

## Dependencies
T-037, T-024.

## Files
`services/api/src/attest/{android,apple,tpm,index}.ts`, `config/attestation-roots/*.pem` (each root's fingerprint in the commit message), tests with public sample blobs.

## Rules
Android: chain → pinned Google root; extension `1.3.6.1.4.1.11129.2.1.17`; `keyOrigin = GENERATED`; challenge == nonce; attested key == registered key. Apple: per Apple's documented verification; App ID from config. TPM: signature by AK; AK cert chains to a pinned EK root; certified object name == registered key; `fixedTPM | sensitiveDataOrigin` set. Anything else → level 1 with `detail.reason`.

## Tests
Positive vectors per platform; expired intermediate; nonce replay; key mismatch.

## Acceptance
A Pixel-class device reaches L2 in a Phase D demo extension.

## Security
Roots change only by PR with fingerprints; level 2 never assigned without a nonce match.
