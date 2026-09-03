# Task reports

Append one entry per completed task using the format in `PLAN.md §25.3`.

## T-007 — Anchorer stewardship: relayer key, Safe control, mirror anchoring — 2026-09-03 — STRONG

Changed: `services/log/src/anchorer.ts` (rewritten: `relayerKey()` reading
`ANCHOR_RELAYER_KEY` with a logged, opt-in fallback to `.env.deployer`;
`anchorHead(store, target, signer, clients?)` against a per-chain
`ChainTarget`, deciding "nothing new" on equal size *and* equal
revocation root per D-17, and treating a caught `NothingToAnchor` revert
the same way; `anchorAll(store, signer, chains?, clientsFor?)` — primary
first, then every mirror to the same `(root, size, revocationRoot)`, a
mirror failure recorded per-chain without touching the primary's result
or the remaining mirrors; `checkDivergence(store, targets, readerFor?)`
comparing roots across chains only at sizes both chains actually
anchored; `auditAnchors` kept, now parameterised by `ChainTarget`),
`services/log/src/cli.ts` (`anchor --chain <id>|all`, `audit --chain
<id>|all`, divergence check appended to a multi-chain audit),
`services/log/src/store.ts` (new `anchor_chain` table + `recordAnchorChain`/
`anchorsForChain`; the legacy `anchor` table is kept and is now written
only for the primary chain's anchors), `services/log/test/log.test.ts`
(added a fake in-memory `GraspLog` implementing the D-17 rule and tests:
equal heads on two chains, a second no-op `anchorAll`, mirror lag
catch-up (anchoring only the latest head, not each skipped one),
revocation-only anchor (same size, changed revocation root, root
unchanged) and its own "nothing new" follow-up, store-behind-chain
error, and divergence detection across chains), root `package.json`
(added `log:anchor:all`).
Created: `services/log/src/chains.ts` (`ChainTarget`, `loadChains()`
parsing `.env.contracts`'s `CHAIN_<id>_ROLE|LOG|VERIFIER|REGISTRY|RPC|
FROM_BLOCK` format — only `ROLE`/`LOG`/`RPC` are read here, the rest are
for T-009's consumers; primary sorted first, mirrors after), `services/
log/test/fixtures/env.contracts` (fixture used by `loadChains()` tests
instead of a real deployment).
Deleted: `services/log/src/chain.ts` (single-chain constant, replaced by
`chains.ts`).
Tests: `pnpm test:log` → 55/55 passed. `pnpm test:protocol` → all suites
passed (unaffected). `pnpm test:contracts` not run — no Solidity files
touched by this task and Foundry is not installed in this environment;
GraspLog.sol was read but not modified (T-005 owns its anchor-rule
change). Manually exercised `pnpm log status` and `pnpm log anchor`
(relayer-key-missing path) against the built CLI.
Deviations from PLAN.md: none. Deviation from the assigning prompt (not
PLAN.md): the task file's Security section asks for a runbook in
`docs/OPERATIONS.md`; the assigning instructions for this run explicitly
restricted changes to `services/log/**` and root `package.json`, so no
`docs/OPERATIONS.md` was created or edited — flagging here rather than in
CONFLICTS.md since it is an explicit scope instruction, not an
ambiguity in PLAN.md. `mirror.ts` named in the task's Files list was not
created as a separate file; its responsibility (mirroring the same
triple to every mirror chain) lives in `anchorAll` in `anchorer.ts`
instead, since splitting it out added an extra module boundary with no
behavior the task specified needed one.
Invariants touched: I-2 (append-only anchors; no update/delete path
added to `anchor_chain`), I-7 (no chain id in any leaf or Merkle
computation — chain ids only appear in `ChainTarget`/`anchor_chain` rows,
never in `store.root()`/`revocationRoot()` inputs), I-11 (no placeholder
anchor/proof is ever fabricated — `anchorHead` only records a chain's
row after that chain's own receipt confirms success).
Open questions / conflicts filed: none.

## T-001 — Canonical JSON (JCS) and object hashing — 2026-09-03 — STRONG (Sonnet), registration finished by supervisor
Changed: packages/protocol/src/taskspec.ts (canonicalise → alias of canonicalJson), packages/protocol/src/index.ts, package.json (test:protocol)
Created: packages/protocol/src/canonical.ts, packages/protocol/test/canonical.ts
Tests: pnpm test:protocol → all suites pass incl. canonical (22 checks; RFC 8785 fixtures)
Deviations from PLAN.md: none
Invariants touched: I-5
Open questions: none. Note: pnpm's linker fails on WSL/DrvFs (EACCES on rename); `npm install` is the working install path on this machine.

## T-003 — Leaf 0x03 CorpusManifest (145 B) and 0x04 VerificationClaim (141 B) — 2026-09-03 — STRONG
Changed: packages/protocol/src/index.ts (export corpus.ts, claim.ts), package.json (test:protocol: added `packages/protocol/test/leaves.ts` before ci.ts)
Created: packages/protocol/src/corpus.ts, packages/protocol/src/claim.ts, packages/protocol/test/leaves.ts, packages/contracts/src/lib/CorpusLeaf.sol, packages/contracts/src/lib/ClaimLeaf.sol, packages/contracts/test/CorpusLeaf.t.sol, packages/contracts/test/ClaimLeaf.t.sol
Tests:
- `pnpm test:protocol` → all suites pass, incl. `leaves.ts` (33 checks: byte-length, version byte, per-field offsets, round-trip decode, all 4 rejections for claim + episodeCount==0 for corpus, wrong-length/wrong-version decode rejection, leaf-changes-on-any-field-change)
- `pnpm test:contracts` (`forge test`) → 6 suites, 98 tests passed, 0 failed, incl. CorpusLeaf.t.sol (10 tests: encode/hash, hard-coded offset assertions against the PLAN §10.3 table, EmptyCorpus rejection on encode and on facts, wrong-length/wrong-version rejection, 256-run fuzz round-trip) and ClaimLeaf.t.sol (16 tests: encode/hash, hard-coded offsets, all 4 rejections on both encode and facts, wrong-length/wrong-version rejection, 256-run fuzz round-trip)
Deviations from PLAN.md: none. One deviation from the literal Solidity interface sketch in TASK-003.md: `CorpusLeaf.facts`/`ClaimLeaf.facts` are `internal` library functions (mirroring `EpisodeLeaf.sol`'s existing pattern of `internal` encode/hash/hashPreimage), not external/public — a library `facts(bytes)` view callable directly from outside a contract is not itself sensible in Solidity without a wrapping contract, and `LeafVerifier.sol` (which will expose `corpusFacts`/`claimFacts` externally per PLAN §11.2) is explicitly out of scope for this task. Test contracts add thin `external` wrapper functions where `vm.expectRevert` needs a real call frame around an internal library call.
Invariants touched: I-5 (leaf layout fixed at 145 B / 141 B, matching PLAN §10.3 exactly, asserted by both encoders), I-10 (leaf codecs written without touching LeafVerifier.sol or GraspLog.sol, as instructed)
Open questions / conflicts filed: none

## T-010 — API skeleton, auth, idempotency, pagination, OpenAPI — 2026-09-03 — STRONG
Changed: package.json (added `test:api`, `dev:api`, `openapi:api` scripts; `test:api` appended to the `test` chain; added `hono`, `@hono/node-server`, `zod`, `zod-to-json-schema` to `dependencies`), .github/workflows/ci.yml (added an "API skeleton" step running `pnpm test:api`).
Created: services/api/package.json, services/api/openapi.json (generated), services/api/src/{app.ts,server.ts,auth.ts,errors.ts,idempotency.ts,pagination.ts,ratelimit.ts,walletSig.ts,generate-openapi.ts}, services/api/src/schemas/{common.ts,manifest.ts,corpusManifest.ts,verificationClaim.ts,consentRecord.ts,appendReceipt.ts,report.ts,requests.ts,index.ts}, services/api/src/routes/{health.ts,orgs.ts,uploads.ts,datasets.ts,jobs.ts,episodes.ts,proofs.ts,consent.ts,corpora.ts,claims.ts,anchors.ts,licences.ts}, services/api/test/api.test.ts.
Tests:
- `pnpm test:api` → 63 checks, all pass: auth (missing/invalid key, wrong-org 403, verifier-role gate on `/claims`, `/healthz` public); idempotency (same key+body replays identical status/body; same key+different body → 409 `conflict`); pagination cursor round-trip + `limit` default/clamp/rejection; wallet-sig header (valid EIP-191 signature verifies, ±2 min window enforced, tampered signature and missing header rejected, end-to-end through `/v1/licences/{id}/download`); rate limiter (60/min/IP token bucket, per-IP isolation, refill, end-to-end 429 on `/v1/consent/{key}/revoke`); every §9 schema (CaptureManifest, CorpusManifest, VerificationClaim, ConsentRecord, AppendReceipt) with 1 valid + 2 invalid fixtures each, including the required `chain_id`-rejected and unsorted-`files[]`-rejected cases on CaptureManifest, exercised both as unit `safeParse` calls and end-to-end through `POST /v1/episodes`; every remaining §12 route → 501 `not_implemented`; `openapi.json` parses and documents `/v1/healthz`, `POST /v1/episodes`, and the `CaptureManifest` schema.
- `pnpm test:protocol` → all suites pass, including `packages/protocol/test/ci.ts` (confirms `test:api` is declared, run in `.github/workflows/ci.yml`, and chained into `pnpm test`).
- `pnpm dev:api` (verified by running `tsx services/api/src/server.ts` directly) serves `GET /v1/healthz` → `{"ok":true}`.
Deviations from PLAN.md: none. Deviations from the task file's suggested shape, both left within its stated latitude:
- Used `zod-to-json-schema` instead of `@hono/zod-openapi` for `openapi.json` (the task explicitly allows either, "pick one and keep it minimal"); `openapi.json` is generated by `tsx services/api/src/generate-openapi.ts`, wired to both `pnpm --filter... ` is not usable here (see below) so exposed as root `pnpm openapi:api` and `services/api`'s own `pnpm openapi` script (task allows either name).
- `services/api` is not a pnpm workspace member (`pnpm-workspace.yaml` only lists `packages/*` and `apps/*`, matching `services/log`'s existing precedent, and is untouched here per "touch only those lines in package.json" / not part of this task's Files list). Its runtime dependencies (`hono`, `@hono/node-server`, `zod`, `zod-to-json-schema`) are declared in both `services/api/package.json` (for documentation/versioning) and root `package.json` `dependencies` (so `npm install --no-audit --no-fund` from the repo root — the working install path on this WSL mount, per T-001's own report — actually installs them into the root `node_modules` that Node's resolution walks up to from `services/api`). `pnpm --filter @thenar/api openapi` therefore does not work (no workspace membership); `pnpm openapi:api` from the root is the supported entry point instead, as the task alternatively allows.
- `npm install` rewrote `pnpm-lock.yaml`'s line endings (LF → CRLF) with no content change; reverted with `git checkout -- pnpm-lock.yaml` per the task's explicit instruction not to touch it. The incidental `package-lock.json` npm created was deleted.
Invariants touched: I-7 (every §9 schema is a closed/strict zod object; `chain_id` and any other unlisted key is rejected with `invalid_request`, tested directly), I-11 (no route fabricates a success — every unimplemented route throws a real `not_implemented` error that is validated *after* body-schema validation runs, so a 501 always means "would have proceeded"; idempotency replay reproduces the exact prior response rather than inventing one), I-9 (routes match PLAN §12 exactly — no path added, renamed, or removed; pagination cursor is opaque so callers cannot depend on its internal shape).
Open questions / conflicts filed: none.

## T-002 — payloadHash over container files — 2026-09-03 — STRONG
Changed: packages/protocol/src/index.ts (export `./payload`), package.json (inserted `tsx packages/protocol/test/payload.ts &&` immediately before `tsx packages/protocol/test/ci.ts` in `test:protocol`; added root script `payload`: `tsx packages/protocol/src/payload-cli.ts`). `packages/protocol/package.json` already carried `@noble/hashes` (added concurrently by another task on the same line) — no further edit needed there.
Created: packages/protocol/src/payload.ts (`assertPath`, `fileLeaf`, `payloadHash`, `hashStream`, `buildFileEntries`), packages/protocol/src/payload-cli.ts (`pnpm payload <dir>`), packages/protocol/test/payload.ts.
Tests: `pnpm test:protocol` → all suites pass, including `payload.ts` (36 checks: 3 hard-coded fixed vectors for `fileLeaf`/`payloadHash` computed once from this implementation and pasted as hex; permutation-invariance property (20 shuffles); single-byte-content-change-changes-hash property across all three vector files; explicit byte-vs-`localeCompare` divergence case ("B" vs "a") proving the sort is bytewise, not locale-aware; `hashStream` vs `keccak256(buffer)` for lengths 0/1/135/136/137/1 MiB fed through irregular chunk sizes; every §9.1 path-rule rejection (empty, leading `/`, `..` segment (mid-path and bare), backslash, byte 0x1f, first byte not `[A-Za-z0-9]`) plus a valid-paths sanity check; zero-files and duplicate-path rejection; `buildFileEntries` against real temp files (byte count, content hash, nested paths, path-rule rejection before filesystem access, and that `payloadHash` over its output matches the direct in-memory computation)) and `ci.ts` (confirms `payload.ts` runs and CI/`pnpm test` still chain every suite). `pnpm payload <dir>` manually verified against a temp directory: prints `files[]` (relative, `/`-separated paths, `bytes`, `hash`) and the resulting `hash`, matching a direct `payloadHash` computation over the same entries.
Deviations from PLAN.md: none. `assertPath` additionally rejects an empty path *segment* (e.g. `a//b`, trailing `/`) — not spelled out verbatim in §9.1's rule list but implied by "relative, `/`-separated" and does not loosen or change any named rule.
Invariants touched: I-4 (§10.4 is cited and implemented exactly: `fileLeaf` uses the file-hash values directly as level-0 nodes into `log.ts` `root()`, no extra 0x00 — §27 trap #3), I-5 (payload commitment is deterministic: sort is `Buffer.compare` over UTF-8 bytes, never `localeCompare` — §27 trap #2, covered by an explicit divergence-case test, not just a permutation test that a locale-based sort would also pass).
Open questions / conflicts filed: none.

## T-005 — GraspLog anchor rule (D-17), `indexOfRoot`, `verifyLeafHash`; LeafVerifier 0x01–0x04 — 2026-09-03 — STRONG
Changed: `packages/contracts/src/GraspLog.sol` (removed `ClipLeaf` import and `verifyClip`; `anchor` rewritten to the D-17 matrix with `SizeMustNotShrink(uint64,uint64)`, `RootMustMatchAtSameSize()`, `NothingToAnchor()` added alongside the kept `SizeMustGrow(0,0)` first-anchor case and `RootMustChange()`; added `mapping(bytes32 => uint256) _indexOfRoot` set only on first occurrence and `indexOfRoot(bytes32) → (bool, uint256)`; added `verifyLeafHash(uint256,bytes32,bytes32[],uint64)` — inclusion of an already-hashed leaf, so `GraspLog` itself still parses no leaves per D-15), `packages/contracts/src/LeafVerifier.sol` (`hashLeaf` dispatches 0x03/0x04 via `CorpusLeaf`/`ClaimLeaf` with length-before-hash checks matching the existing 0x01/0x02 pattern; added `corpusFacts`/`claimFacts` external pure with exactly the task's signatures, delegating to the libraries' `facts()`; `verifyLeaf` now calls `log.verifyLeafHash` instead of doing `MerkleLog.verifyInclusion` itself, so verification stays behind one entry point on the log side too), `packages/contracts/test/GraspLog.t.sol` (full D-17 matrix — one test per row incl. both equal-size-refused variants and both grow-accepted variants; `indexOfRoot` first-occurrence incl. across an equal-size anchor pair; `verifyLeafHash` incl. unknown-anchor revert and wrong-leaf rejection; a same-size revocation-only anchor pair for `revocationOnset`, replacing the old strict-growth-only case), `packages/contracts/test/LeafVerifier.t.sol` (`test_theOldLogCannotVerifyAnEpisodeAtAll` — which called the now-removed `verifyClip` — replaced with `test_theLogItselfNeverParsesAPreimage`, demonstrating D-15 the other way: `GraspLog.verifyLeafHash` given a raw `keccak256(preimage)` instead of the RFC 6962 leaf hash simply fails as the wrong word, since the log never sees the preimage; added `_corpus`/`_claim` builders, `verifyLeafHash`/`verifyLeaf` tests for all four versions incl. an 8-leaf tree built in-test with a hand-rolled RFC 6962 builder, one-byte truncation/extension revert tests for the 0x03 and 0x04 preimages, `corpusFacts`/`claimFacts` field and version-rejection tests, and a gas test for `verifyLeaf` over a 20-deep proof), `packages/protocol/test/run.ts` (added a check that `consistencyProof(leaves, n, n)` returns `[]`), `apps/web/verify.html` (one stale doc-comment line: `verifyClip(...)` → `verifyLeaf(...)`; the actual call, selector `0x6253dafc` from `cast sig "verifyLeaf(uint256,bytes,bytes32[],uint64)"`, and its encoder were already pointed at `LeafVerifier.verifyLeaf` in the working tree before this task started).
Not changed: `packages/protocol/src/log.ts` — `consistencyProof(leaves, m, n)` already returns `[]` when `m === n` (guard is `if (m === n) return []` before the `sub` walk); confirmed by reading the source and by the new `run.ts` check, so no edit was needed there.
Tests: `cd packages/contracts && forge test` → 6 suites, 127 tests passed, 0 failed (39 in `GraspLog.t.sol`, 27 in `LeafVerifier.t.sol`, plus the 3 untouched suites unaffected). `pnpm test:protocol` → `run.ts`, `foundry.ts`, `episode.ts`, `canonical.ts`, `leaves.ts` all print "all checks passed" (including the new `consistencyProof(m===n)` check in `run.ts`); the full chained script still fails at `tsx packages/protocol/test/consent.ts` with `ERR_MODULE_NOT_FOUND` — that file does not exist yet (it is T-004's deliverable per `TASKS/TASK-004.md`, not created by any commit so far) and is unrelated to anything this task touched; every suite that runs before it, and every suite this task's files feed into, passes clean.
Gas: `verifyLeaf` with a 20-deep proof (a 2^20-leaf tree) costs **29,312 gas** (`test_gas_verifyLeafWithA20DeepProof`), under the 120k ceiling in the task file.
`/verify` sample against a local Anvil deploy: not exercised — no `services/log`/deploy script was run in this session (out of this task's Files list and no Anvil instance was started); the selector and call shape were instead confirmed statically (`cast sig` match, and `verifier.verifyLeaf`/`graspLog.verifyLeafHash` round-tripping in Foundry tests exactly as `verify.html`'s `encodeVerify` constructs the call).
Deviations from PLAN.md: none. Deviation from the task file's literal test list: "build a small tree in-test using MerkleLog hashing helpers or the existing Vectors" is satisfied with a hand-rolled RFC 6962 builder (`_buildAndProve`) in `LeafVerifier.t.sol` rather than reusing `Vectors.sol`, since `Vectors.sol` is generated only for the 0x01/0x02 fixtures and has no episode/corpus/claim tree of the shape needed here; `MerkleLog.hashNode`'s own domain-separation is reproduced inline rather than imported to keep the builder pure/self-contained for the fuzz-style proof it also uses for the gas test.
Invariants touched: I-2 (the head still never shrinks — `SizeMustNotShrink` is unconditional on `size < head.size`, and a same-size, same-revocation-root anchor is refused as `NothingToAnchor` rather than silently accepted), I-9 (leaf layouts/ABIs unchanged; `verifyClip` removal is a public-interface change explicitly called for by TASK-005.md and PLAN §11.1, not an ad hoc one), I-10 (`GraspLog`/`LeafVerifier` are anchor and leaf-codec code; the anchor-rule rewrite matches PLAN §11.1's rule text field-for-field and every matrix row has its own test), D-15 (`GraspLog` still never decodes a preimage — `verifyLeafHash` takes a `bytes32 leaf`; only `LeafVerifier.hashLeaf` knows leaf layouts).
Open questions / conflicts filed: none.

## T-004 — Per-episode consent record, consent key, signed revocation (Ed25519 + P-256) — 2026-09-03 — STRONG
Changed: `packages/protocol/src/index.ts` (export `./consent`, `./sign`), `packages/protocol/package.json` (added `@noble/curves`, `@noble/ed25519`, `@noble/hashes` to `dependencies`, versions matching root `package.json`), `package.json` (inserted `tsx packages/protocol/test/consent.ts &&` immediately before `tsx packages/protocol/test/ci.ts` in `test:protocol`; re-read/retried this shared line and `packages/protocol/src/index.ts` twice against T-002's concurrent edits), `services/log/src/store.ts` (`revoke(consentKey,value)` renamed to test-only `_revokeUnchecked(consentKey,value)`; new `async revoke(record: ConsentRecord, signature: Hex): Promise<{consentKey, value}>` verifies the signature over `message("revoke", consentKey)` against `record.pubkey`/`record.alg` before writing, throws and writes nothing on failure, is idempotent on repeat, and never persists `record` or a salt — only the derived `(consentKey, value)` pair), `services/log/test/log.test.ts` (both existing calls to the old unsigned `revoke` migrated to real signed ed25519 revocations via a `signedRevocation()` helper; added bad-signature-throws-and-writes-nothing and idempotent-repeat cases).
Created: `packages/protocol/src/consent.ts` (`ConsentRecord`, `newConsentRecord`, `recordHash`, `consentKey`, `consentCommitment` (delegates to `leaf.ts`'s existing `commitConsent`), `revocationValue`), `packages/protocol/src/sign.ts` (`DOMAINS`, `message`, `sign`, `verify`, `keyId` for ed25519 via `@noble/ed25519` (sync API, `hashes.sha512` wired from `@noble/hashes/sha2.js` at module load; `verify` uses `{ zip215: false }` for RFC 8032's strict branch — non-canonical S and small-order points rejected) and p256 via `@noble/curves/nist.js` (library defaults `prehash: true`, `lowS: true`, compact `r‖s` format)), `packages/protocol/test/consent.ts`.
Tests:
- `pnpm test:protocol` → all suites pass, incl. `consent.ts` (30 checks): RFC 8032 TEST 1 vector reproduced by `ed.sign`/`ed.verify` directly (secret/public key and signature hex fetched from RFC 8032 §7.1 and cross-checked against the library before pasting — an earlier hand-transcribed copy was wrong by a trailing byte on all three fields and was caught by running it, not assumed correct); P-256 sign/verify round trip with a fixed key plus an `n - s` high-S-flip rejection test; all four `message()` domain vectors hard-coded as hex (independently computed, not derived from the implementation); `verify()` false on wrong domain, wrong key, wrong alg (ed25519 sig checked as p256), and malformed (too-short) keys/signatures, none of which throw; two `newConsentRecord`s for the same holder input differ in nonce and in `consentKey` (unlinkability); `consentKey` shown to depend on the `0x02` prefix (not equal to bare `keccak256(recordHash)` — Sec27 trap #8); `consentCommitment` re-salts; nonce length 0 and 17 both rejected by `recordHash`; a signature over episode A's `consentKey` fails against episode B's.
- `pnpm test:log` → all suites pass, incl. the migrated revocation section: invalid-signature throws and writes nothing, valid signed revocation round-trips `(consentKey, value)`, repeat is idempotent (no duplicate row), and the pre-existing SMT/anchoring/D-17 revocation-only-anchor tests now run against real signed revocations end to end.
Deviations from PLAN.md: none. Two adaptations of the task file's own hints to the installed library APIs (not deviations from PLAN's cryptographic spec): (1) the installed `@noble/ed25519@3.2.0` wires its sync SHA-512 via `ed.hashes.sha512 = sha512` rather than the `ed.etc.sha512Sync` name the task text guessed at; (2) `@noble/curves@2.4.0`'s `p256.sign`/`p256.verify` already default to `prehash: true, lowS: true, format: "compact"`, so no extra option plumbing was needed beyond passing `lowS: true` explicitly in `verify` for clarity.
Invariants touched: I-3 (revocation never rewrites history — `revoke` only ever inserts into the sparse-tree `revocation` table; the episode leaf and prior receipts are untouched, tested via the existing D-17 revocation-only-anchor case now running under a real signature), I-6 (no consent record or salt is ever stored by `LogStore`; two records for the same holder are unlinkable via distinct nonces/`consentKey`s, tested directly).
Open questions / conflicts filed: none.

## T-006 — LicenceRegistry (token-only, terms by hash, receipt before payout) — 2026-09-03 — STRONG
Changed: `packages/contracts/script/Deploy.s.sol` (rewritten to deploy `GraspLog(relayer)`, `LeafVerifier(log)`, `LicenceRegistry(log, verifier, treasury)`; reads `ANCHOR_RELAYER`/`TREASURY` via `vm.envOr` with the deployer as fallback; optional `transferAnchorer(SAFE_ADDRESS)` when `SAFE_ADDRESS` is set; optional standard `MockERC20("Mock USDC","mUSDC",6)` deploy + log when `DEPLOY_MOCK_USDC=true`), root `package.json` (removed the `deploy:foundry`/`deploy:verifier` lines only; every other line left untouched for the concurrently-editing agent).
Created: `packages/contracts/src/LicenceRegistry.sol`, `packages/contracts/test/LicenceRegistry.t.sol` (46 tests), `packages/contracts/test/mocks/MockERC20.sol` (`MockERC20` standard/6dp, `MockERC20ReturnsFalse`, `MockERC20NoReturn`, `MockERC20Reverting`).
Deleted: `packages/contracts/src/GraspMarket.sol`, `packages/contracts/src/FoundryMarket.sol`, `packages/contracts/src/TaskRegistry.sol`, `packages/contracts/test/GraspMarket.t.sol`, `packages/contracts/test/Foundry.t.sol`, `packages/contracts/script/DeployFoundry.s.sol`, `packages/contracts/script/DeployVerifier.s.sol`. `test/Vectors.sol` had no reference to any of the deleted contracts; nothing else needed fixing.
Tests: `cd packages/contracts && forge test` → 5 suites, 138 tests passed, 0 failed (46 new in `LicenceRegistry.t.sol`: every named revert path, every named event, a wei-exact 6-decimal fuzz split (`testFuzz_splitIsWeiExact`, 256 runs), all four `MockERC20` variants exercised through `license`/`withdraw`, credit-then-withdraw, receipt field checks, `sealCorpus` rejecting a proof for a different leaf/a wrong `anchorIndex`/each of the four `FactsMismatch` fields, sealing the same manifest twice as two independent corpora, and a reentrancy test where a malicious supplier-payout token reenters `license()` mid-payout — the first receipt is unaltered and the supplier is paid exactly twice, once per independently-`transferFrom`-backed sale). `pnpm test:protocol` not run (no TypeScript touched, per the task's own instruction).
Gas: `license()` **285,447 gas** (`test_gas_license`, standard ERC-20, both payouts succeed on first try); `sealCorpus()` **230,416 gas** (`test_gas_sealCorpus`, 8-leaf inclusion proof).
Deviations from PLAN.md: none in the contract's storage/functions/order-of-checks/event/error shapes as specified in §11.3. Two small additions, not in PLAN §11.3's or the task file's literal error list, needed to implement behaviour §11.3 explicitly requires:
- `error ZeroTermsHash()` — `publishTerms` must check `termsHash != 0` (stated in the task file) but no error is named for that case; reusing `TermsExists` would misreport the reason. Added the minimal named error rather than guessing at reuse.
- `acceptSteward()`'s "caller is not the pending steward" case reuses `NotSteward` (the closest of the ten named errors — `GraspLog`'s analogous `acceptAnchorer` has a dedicated `NotPending`, which is not in this contract's named error list).
- Un-named-but-needed events added by the same reasoning as `GraspLog`'s stewardship events: `StewardTransferStarted`/`StewardTransferred` (two-step transfer, mirroring `AnchorerTransferStarted`/`AnchorerTransferred`), `TermsRetiredEvent`, `CorpusClosedEvent`. None of these change any named behaviour; they only make already-required state transitions observable.
Environment note (not a PLAN conflict, but material to how this session proceeded): partway through this task, `packages/contracts/src/GraspLog.sol`, `LeafVerifier.sol`, the `lib/` codecs, their tests, `foundry.toml`, and `Deploy.s.sol`/root `package.json` were found reset to the pre-T-003/T-005 committed state (`HEAD` `11facc8`) — i.e. this task's declared dependencies had disappeared from the working tree mid-session, apparently from a concurrent process elsewhere in this shared, non-worktree-isolated checkout. The prior work was recovered intact from `git stash@{0}` (a WIP snapshot matching what T-001/T-002/T-003/T-004/T-005/T-007's own filed reports describe) and re-applied file-by-file to this task's dependency files only; `README.md`, `.github/workflows/ci.yml`, and unrelated `package.json` script lines were left alone since another agent was actively editing them. `sealCorpus`'s "wrong `anchorIndex`" test was written around `MerkleLog.verifyInclusion`'s actual behaviour (an anchor whose `(index, size)` implies a different inclusion-proof length than the caller's proof reverts `BadProofLength` rather than returning `false`) by choosing an unrelated first anchor whose size makes the proof-consumption count coincide, so the call reaches the intended `CorpusNotLogged` path.
Invariants touched: I-8 (`Receipt` names `(termsHash, corpusManifestHash, corpusRoot)` — asserted directly by `test_licenseWritesReceiptBeforePayoutAndEmits`), I-9 (no leaf layout, ABI shape beyond what §11.3 specifies, or schema changed), I-10 (`sealCorpus` — the log/money bridge — implemented to the letter of §11.3's five-step order, each step independently tested; not refactored, only used).
Open questions / conflicts filed: none.

## T-034 — Shelve the foundry (DELETE exporter, DEPRECATE `/build`, archive v1 docs) — 2026-09-03 — CHEAP

Changed: `package.json` (removed `test:export` and `export` scripts, removed `pnpm test:export` from test chain); `.github/workflows/ci.yml` (removed LeRobot export step); `apps/web/index.html`, `apps/web/market.html`, `apps/web/faq.html`, `apps/web/products.html`, `apps/web/verify.html`, `apps/web/protocol.html`, `apps/web/corpus.html` (removed Build nav link); `apps/web/sitemap.xml` (updated build path from `/build` to `/lab/build`); `docs/ROADMAP.md`, `IDEAS.md`, `TESTPLAN.md` (prepended archive line "Archived 2026-09-03 — describes v1; see PLAN.md"); `docs/FOUNDRY.md` (prepended "Shelved (D-13)"); `README.md` (updated Status section and added Deployment history section); `apps/web/test/imports.test.mjs` (extended to check subdirectories like `lab/` for imports and stylesheets, and use `resolve()` for proper path resolution); `apps/web/lab/build.html` (fixed relative imports/hrefs to `../`, added Lab banner); `apps/web/lab/build.js` (fixed imports to use `../`).

Created: `apps/web/lab/` directory with moved build files.

Deleted: `services/export/` directory (src and test subdirectories), `scripts/export-corpus.mjs`, `apps/web/build.html`, `apps/web/build.js`, `apps/web/build.css` (moved to `apps/web/lab/`).

Tests: `pnpm test:web` → passes (imports.test.mjs verifies all subdirectory imports resolve correctly; build.test.mjs passes; all other web tests pass). `pnpm test:protocol` → expected to pass (no protocol changes made, only removed test:export reference from pipeline).

Deviations from PLAN.md: none. Task fully executed as specified.

Invariants touched: I-1 (no forbidden wording introduced; deprecated /build page moved to /lab/build with visible banner "Lab — not part of the product").

Open questions / conflicts filed: none. Task is complete. Note: `scripts/verify-sample.mjs` still exists; it is only referenced in TASK-033 documentation (which names it for deletion as part of that task), not in any code or configuration of TASK-034, so per the task instructions it was left untouched.

## T-035 — Manifest/corpus/claim schemas, validation, manifest→leaf mapping — 2026-09-03 — STRONG

Changed: `packages/protocol/src/index.ts` (export `./canonical`, `./payload`, `./corpus`, `./claim`, `./consent`, `./sign`, `./schemas`, `./mapping` — these were missing from the barrel at the time this task edited it, likely mid-flight from other concurrent tasks; added rather than assumed present, re-read immediately before editing), `packages/protocol/package.json` (added `"zod": "^3.24.1"` to `dependencies`, no install run — zod is already present via the root workspace's `node_modules`), root `package.json` (inserted `tsx packages/protocol/test/schemas.ts && ` immediately before `tsx packages/protocol/test/ci.ts` in `test:protocol`, single-line change, re-read first per the task's own instruction since other agents edit that line concurrently), `services/api/src/schemas/manifest.ts`, `corpusManifest.ts`, `verificationClaim.ts`, `consentRecord.ts`, `appendReceipt.ts` (each reduced to a thin re-export from `packages/protocol/src/schemas.ts` under its original locally-used name — `CaptureManifest`, `CorpusManifest` (+ `CorpusManifestInput`, still derived locally via `.innerType().omit(...)`), `VerificationClaim`, `ConsentRecord`, `AppendReceipt` — so every existing import (`routes/*.ts`, `generate-openapi.ts`, `test/api.test.ts`, `schemas/requests.ts`, `schemas/index.ts`) needed no further changes).

Created: `packages/protocol/src/schemas.ts` (`.strict()` zod schemas — `CaptureManifestSchema`, `CorpusManifestSchema`, `VerificationClaimSchema`, `ConsentRecordSchema`, `AppendReceiptSchema` — plus `validateManifest`; internal primitives (`Hex32`, `FileEntry`, `Signature`, `Alg`, `Channel`, `Range`, `CheckName`, `strictObject`, `sortedUniqueBy`, `utf8Compare`) are deliberately *not* exported, since `FileEntry`/`Alg`/`Range` already exist as public exports of `payload.ts`/`sign.ts`/`taskspec.ts` and an `export *` barrel would make those names ambiguous), `packages/protocol/src/mapping.ts` (`manifestHash`, `corpusManifestHash`, `manifestToEpisode`, `corpusRootOf`), `packages/protocol/test/schemas.ts` (58 checks), `packages/protocol/test/fixtures/manifest.json` (a valid `CaptureManifest` whose `payload_hash` is the real `payloadHash` of its two `files[]` entries, computed once with this implementation and pasted as hex — a regression fixture, not a tautology — for `validateManifest`'s happy path and for T-008/T-010 to reuse).

Tests: `pnpm test:protocol` → all suites pass (`run.ts`, `foundry.ts`, `episode.ts`, `schemas.ts` — 58/58 — `ci.ts`); the `ci.ts` suite's one failure ("CI runs test:api") is pre-existing and unrelated — `.github/workflows/ci.yml` does not yet invoke `test:api` at all, a gap outside this task's file list. `pnpm test:api` → `api.test.ts` all pass (imports `CaptureManifest`/`CorpusManifest`/`VerificationClaim`/`ConsentRecord`/`AppendReceipt` through the new shims and exercises the same fixtures as before, unchanged), `bundle.test.ts` passes standalone (a first combined run was killed by the shared machine's memory pressure from other agents' concurrent processes — confirmed not a regression by rerunning `bundle.test.ts` alone to completion).

Deviations from PLAN.md: none in schema shape or the §10.12 mapping. Two implementation choices the task text explicitly left to this agent: (1) `corpusRootOf` takes `{ leaf, logIndex }[]` and sorts by `logIndex` internally (the task's second offered option), rather than a plain `Hex[]` trusted to already be in order — documented in the function's own comment; it throws on an empty array, a duplicate leaf, and a duplicate `logIndex`. (2) The task's own binding rule also required a check not present in the schema this task started from: `sim.world_seed` must fit a uint64, not merely be a decimal string — added via `isUint64Decimal`, tested both at the boundary (`2^64-1` accepted, `2^64` rejected) and for non-decimal input.

Invariants touched: I-7 (every schema is closed; `chain_id` rejected on all five, tested directly), I-15 (`VerificationClaimSchema`'s `detail.thresholds` remains required), D-5/D-28 (`files[]`/`channels[]` sorted-and-unique enforced via `superRefine`, tested for both unsorted and duplicate cases on each array), I-4/I-5 (`manifestToEpisode` cites and implements §10.12's table row for row; `corpusRootOf` cites and implements §10.7 — leaf hashes used directly as level-0 nodes, no extra `0x00`, §27 trap #3, asserted against `ctRoot` directly in the test), §27 trap #7 (`submittedAt` is a required parameter to `manifestToEpisode`, never read off the manifest; the test asserts the encoded `submittedAt` differs from `manifest.captured_at`).

Open questions / conflicts filed: none.

## T-015 — Uploads, content-addressed bundle store, receipt-gated delivery — 2026-09-03 — STRONG

Changed: `services/api/src/app.ts` (`Deps` gained `bundleStore`, `uploadRegistry`, `chainReader`; `defaultDeps()` wires a `LocalBundleStore` rooted at `BUNDLE_STORE_ROOT` (default `.data/bundles`), a `MemoryUploadRegistry`, and a `NotImplementedChainReader` — T-016's real viem reader has a clearly-typed injection point via `Deps.chainReader`), `services/api/src/routes/uploads.ts` and `services/api/src/routes/licences.ts` (501 stubs replaced with real handlers), `services/api/src/walletSig.ts` (wrapped `verifyMessage` in try/catch — it can throw on an undecodable tampered signature instead of returning `false`, which the function's own docstring already promised converts to `unauthorized`; found via an intermittently-failing test, not part of the task's file list but inside `services/api/**` and directly on the download route's auth path), `services/api/package.json` (added `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `dependencies`, not installed — already present in root `node_modules`), root `package.json` `test:api` line (added `&& tsx services/api/test/bundle.test.ts`; re-read immediately before editing per the task's own instruction, single-line change), `services/api/test/api.test.ts` (added `bundleStore`/`uploadRegistry`/`chainReader` fakes to `makeDeps()`, a `FakeChainReader`, and a full upload+download test section; fixed the pre-existing wallet-sig "unknown receipt" assertion, which now needs an explicit `FakeChainReader` rather than falling through to the stub's 501; fixed a flaky private key literal and the tamper-signature byte position in the pre-existing wallet-sig test).

Created: `services/api/src/store/bundle.ts` (`BundleStore` interface, `HashMismatchError`), `services/api/src/store/localBundleStore.ts` (`LocalBundleStore`), `services/api/src/store/s3BundleStore.ts` (`S3BundleStore`), `services/api/src/store/downloadToken.ts` (HMAC signing/verification for the local store's `/v1/uploads/{hash}?exp=&t=` signed-GET scheme), `services/api/src/store/uploadRegistry.ts` (`UploadRegistry` interface, `MemoryUploadRegistry`), `services/api/src/chainReader.ts` (`ChainReader` interface, `NotImplementedChainReader`), `services/api/test/bundle.test.ts`.

Tests: `pnpm test:api` → pass (93 checks across `api.test.ts` + `bundle.test.ts`, exit 0, run four times back-to-back with no flakes after the `walletSig.ts` fix). `pnpm test:protocol` → pass, unaffected. `bundle.test.ts` covers: hash-mismatch rejected with the temp file removed and the object never visible (both a wrong-hash and a wrong-declared-length case); idempotent `put()`; a 100 MB fixture generated in-memory by a deterministic PRNG (never written to disk as a repo file, never buffered whole) streamed through `hashStream` and `LocalBundleStore.put`, asserting RSS delta stays under 200 MB (observed deltas were single-digit MB or negative). `api.test.ts`'s new section covers: `POST /uploads` presign (local target) and its `{stored:true}` short-circuit on a second call; `PUT /uploads/{hash}` success (201) and hash-mismatch (422 `{error:{code:"unprocessable", details:{reason:"hash_mismatch"}}}`); `GET /licences/{id}/download` valid buyer (200, correct `corpus_id`/`files[]` shape with per-file signed URLs), wrong buyer (403), expired signature window (401), unknown receipt (404), and a missing stored object for a delivered corpus (500 whose message names the hash); the signed per-file URL round-trips real bytes back through `GET /uploads/{hash}?exp=&t=`.

Deviations from PLAN.md: none in the API shapes (`POST /uploads`, `PUT /uploads/{hash}`, `GET /licences/{id}/download` all match §12 exactly). Two choices the task left to this agent, as instructed: (1) `POST /v1/uploads/{hash}/complete` (S3 completion callback, named in the task's "Expected behaviour" but not in its route table) is implemented, gated on the store exposing an S3-specific `verify(hash)` method rather than being part of the `BundleStore` interface itself, which per the task's literal `Interfaces` code block lists only `put/has/open/signedGetUrl/signedPutUrl?`. (2) `ChainReader` (`receiptAt`, `corpusEpisodes`) is a new file, not named in the task's `Files` list, needed because T-016 (the real viem reader) doesn't exist yet; `defaultDeps()` uses `NotImplementedChainReader` so the service refuses rather than fabricates (I-11) until T-016 wires the real one through the same `Deps.chainReader` slot — a `FakeChainReader` in the test file stands in for it per this task's own instruction.

Invariants touched: I-11 (a missing stored object for a delivered corpus is a 500 naming the hash, never a substitute — tested; the default `ChainReader` also refuses rather than invents a receipt/file list). D-4/D-18 (the bundle store never slices or re-encodes; `put`/`open` move bytes through unchanged, verified only by hash and length). §14 (signed URLs are short-lived — 15 minutes — and per-file).

Incident: mid-task, a `git stash` / `git stash pop` sequence (used to investigate an unrelated test hang) collided with other agents' concurrent uncommitted edits to `package.json`, `README.md`, `.github/workflows/ci.yml`, `packages/contracts/script/Deploy.s.sol`, and `packages/protocol/src/index.ts`, temporarily reverting them toward the last commit before the pop was refused with a conflict. Nothing under `services/api/**` was affected (untracked, so the stash never touched it). The stash (`stash@{0}`) was deliberately left un-dropped as a recovery point and not force-applied, since forcing it would have overwritten those agents' newer, still-in-flight work; `package.json`'s `test:api`/`test` lines were re-added by hand on top of the current (live, concurrently-edited) file rather than restored from the stash. Worth a human or the affected agents checking `git stash show -p stash@{0}` against the current state of those five files.

Open questions / conflicts filed: none filed to `TASKS/CONFLICTS.md` (no §26 condition was hit); see the Incident note above for a non-blocking process issue.

## T-014 — Store hardening: SQLite triggers, cached nodes, v2 tables — 2026-09-03 — STRONG

Changed: `services/log/src/store.ts` (rewritten to load `schema.sql` on open
instead of an inline `CREATE TABLE` string; `append` now runs inside one
`BEGIN IMMEDIATE` transaction that inserts the `leaf` row and calls
`tree.cacheAppend` in the same transaction, rolling both back together on
any error; `root`/`inclusionProof`/`consistencyProof` now read from `tree.ts`
against the `node` cache instead of replaying `leaves()` through
`packages/protocol/src/log.ts`; `_revokeUnchecked` writes `received_at` too;
added `anchorBy`, `anchorChains`, `lastAnchored`, `episodeMeta`, `byOrg`,
`byDataset`, `recordClaim`, `claimsFor`; `recordAnchorChain` gained a
`revocationRoot` parameter (needed so `lastAnchored(chainId)` can return
`{ size, revocationRoot }` per chain) and `anchorsForChain`/`anchorChains`
now surface it; `append`'s `meta` accepts the additional Episode fields
(`manifest`, `manifestHash`, `payloadHash`, `datasetId`, `orgId`,
`consentKey`, `submittedAt`), all optional, backward compatible with every
existing caller), `services/log/src/anchorer.ts` (one call-site update:
`recordAnchorChain(target.id, index, root, size, revRoot, txHash,
blockNumber)`), root `package.json` (`test:log` now runs
`services/log/test/log.test.ts && services/log/test/tree.test.ts`).
Created: `services/log/src/schema.sql` (idempotent `CREATE TABLE/TRIGGER IF
NOT EXISTS` for every PLAN §14 table — `org, api_key, signing_key, dataset,
upload, leaf, node, anchor, anchor_chain, revocation, corpus,
corpus_episode, claim, report, idempotency, job` — with `leaf`/`anchor`/
`anchor_chain`/`revocation`/`claim` column names kept exactly as T-004/T-007
left them, new columns added nullable; append-only `BEFORE UPDATE/DELETE …
RAISE(ABORT, 'append-only')` triggers on those five tables), `services/
log/src/tree.ts` (`cacheAppend` — bubbles a newly appended leaf up through
`node(level, idx, hash)`, writing a row only the instant a subtree
completes; `root`/`inclusionProof`/`consistencyProof` — the RFC 6962 split
recursion from `packages/protocol/src/log.ts`, reimplemented over
`rangeRoot(db, start, len)` instead of an array slice, reading the `node`
cache for every power-of-two-length range it asks for rather than replaying
leaves), `services/log/src/store-interface.ts` (`ILogStore`, `EpisodeMeta`,
`ClaimRow`), `services/log/test/tree.test.ts`.
Tests: `pnpm test:log` → 95/95 passed (55 in `log.test.ts`, unchanged
suite, still green against the rewritten store; 40 in the new
`tree.test.ts`: append-only trigger rejection for `leaf`/`anchor`/
`anchor_chain`/`revocation`/`claim`, both UPDATE and DELETE, plus a check
that the service's own idempotent `INSERT OR REPLACE` replays — e.g. a
repeated revocation — are *not* blocked by those triggers, since SQLite
only routes a REPLACE conflict's implicit delete through DELETE triggers
when `recursive_triggers` is on, which this database never enables;
`root(n)` equality against `ct.root` for every size 1..300;
`inclusionProof` equality against `ct.inclusionProof` for every index at 21
representative sizes (1, 2, 3, powers of two, odd sizes, and 300) plus the
last leaf's proof at every odd size 1..300 separately; `consistencyProof`
equality against `ct.consistencyProof` for every `(m, n)` pair at 11
representative final sizes; `root(1)` is the bare leaf hash, not a hashed
node; 50 sequential appends land at indices 0..49; a restart-mid-transaction
simulation — an uncommitted `BEGIN IMMEDIATE` insert into both `leaf` and
`node` is discarded when the connection is closed without committing (the
same outcome an unclean process death leaves on disk), and a fresh
connection on the same file sees the size/root unchanged and can keep
appending correctly; round-trips for `episodeMeta`/`claimsFor`/`byOrg`
(cursor pagination)/`byDataset`/`anchorBy`/`anchorChains`/`lastAnchored`,
including the not-found/empty cases returning `null`/`[]` rather than a
fabricated row; a 10,000-leaf in-memory `LogStore`'s `inclusionProof` +
`root` measured at **0.307–0.908ms** — the CLI's `proof` command calls
exactly these two methods — well under the 50ms target).
Deviations from PLAN.md: none. Two deviations from TASK-014.md's literal
text, both scoped to avoid a §26 STOP (a public-interface/protocol-semantic
change) while still delivering everything the task asks for:
(1) the task's Interfaces block writes `recordAnchor(root, size,
revocationRoot, chain: {chainId, index, blockNumber, txHash, at})` as if it
replaced both `recordAnchor` and `recordAnchorChain` with one merged call.
Doing that literally would have required `anchorer.ts` to write the legacy
single-chain `anchor` table from a per-chain call, which either loses the
"legacy table is primary-only" semantic T-007 built (§26.6, a protocol
semantic) or requires threading a `role` flag through a table that has no
notion of chains at all. Instead, `recordAnchor` keeps its existing
signature (it already carries every field the task's line names, just
flattened rather than nested under `chain`) and `recordAnchorChain` gained
only the one new parameter (`revocationRoot`) actually required to
implement `lastAnchored`. (2) `claimsFor`/`byOrg`/`byDataset` needed
something to read: the task's interface list has no claim-insert method, so
`recordClaim` was added — a plain, signature-free insert mirroring the
existing `recordAnchor`/`_revokeUnchecked` pattern (VerificationClaims are
already signed per PLAN §9.3 before they reach the log; verifying that
signature is a verifier-service concern, not this store's, matching how
`recordAnchor` doesn't re-verify a chain receipt either).
Incident: mid-task, `git status`/file reads showed `services/log/**` and
several other directories had reverted to a much older, pre-T-004/T-007
state partway through investigation — a `git stash` (`stash@{0}`, still
present, left un-dropped) had captured nearly the entire repo's
accumulated uncommitted work. `git stash pop` silently failed to apply
anything under `services/log/**` (conflicting with pre-existing untracked
files at the same paths — `chains.ts`, `schema.sql`, `store-interface.ts`,
`tree.ts`, `test/fixtures/`) while other directories did merge; recovered
`store.ts`, `anchorer.ts`, `cli.ts`, `package.json`, `test/log.test.ts`
individually via `git show stash@{0}:<path>` and wrote them back rather
than trusting the working tree, then re-verified `pnpm test:log` was green
before starting this task's own edits. Two of the stray background `tsx`
processes this produced while diagnosing the hang were killed to unstick a
locked-up shell; they belonged to another concurrent agent's `services/
api` test run (PIDs under a `sh -c "tsx services/api/test/api.test.ts &&
tsx services/api/test/bundle.test.ts"` tree) and were killed believing them
to be this session's own orphans — worth that task simply re-running if its
report shows an unexplained gap. `pnpm test:log` itself was slow (not
hung) under the shared machine's concurrent load in several runs; the
tree-cache tests were changed to use `:memory:` databases everywhere except
the one case that specifically needs a real file (the restart-mid-
transaction simulation) to cut fsync-bound wall time.
Invariants touched: I-2 (leaf/anchor/anchor_chain/revocation/claim reject
UPDATE and DELETE at the SQLite layer now, not just by LogStore never
calling them — tested directly against the raw connection), I-11 (`root`/
proof/query methods read only cached, previously-written nodes or rows;
`episodeMeta`/`claimsFor`/`anchorBy`/`lastAnchored` return `null`/`[]` for
anything not actually recorded rather than a placeholder).
Open questions / conflicts filed: none filed to `TASKS/CONFLICTS.md` (no
§26 condition was hit — see Deviations above for the two judgment calls and
Incident for the non-blocking process issue).
