# T-003 — Leaf 0x03 CorpusManifest (145 B) and 0x04 VerificationClaim (141 B)

**Tier:** STRONG. Byte-exact encoders in two languages (I-5, I-10); layouts
fixed in PLAN §10.3.

## Objective
Add both leaf types to the TS reference and the Solidity libraries with
encode/decode/hash, byte-identical.

## Dependencies
None (T-008 supplies cross-checks).

## Files
- Create `packages/protocol/src/corpus.ts`, `packages/protocol/src/claim.ts`, `packages/protocol/test/leaves.ts` (register).
- Create `packages/contracts/src/lib/CorpusLeaf.sol`, `packages/contracts/src/lib/ClaimLeaf.sol`, `packages/contracts/test/CorpusLeaf.t.sol`, `packages/contracts/test/ClaimLeaf.t.sol`.
- Modify `packages/protocol/src/index.ts`.

## Interfaces (TS)
```ts
export const CORPUS_VERSION = 3, CORPUS_PREIMAGE_BYTES = 145;
export type CorpusLeaf = { corpusManifestHash: Hex; corpusRoot: Hex; termsHash: Hex; taskId: Hex; episodeCount: bigint; sealedAt: bigint };
export function encodeCorpus(c): Hex; export function decodeCorpus(p: Hex): CorpusLeaf; export function corpusLeafHash(p: Hex): Hex;
export const CLAIM_VERSION = 4, CLAIM_PREIMAGE_BYTES = 141;
export type ClaimLeaf = { subjectLeaf: Hex; verifierKeyId: Hex; detailHash: Hex; signatureHash: Hex; checkId: number; result: 0|1|2; levelAsserted: number; issuedAt: bigint };
export function encodeClaim(c): Hex; export function decodeClaim(p: Hex): ClaimLeaf; export function claimLeafHash(p: Hex): Hex;
```
Solidity: `library CorpusLeaf { VERSION=0x03; PREIMAGE_BYTES=145; struct Corpus; encode; hash; hashPreimage; facts(bytes) }`, same shape for `ClaimLeaf` (`facts` returns the fields).

## Expected behaviour
- Wrong length → throw / `WrongPreimageLength`; wrong version → `UnsupportedVersion`.
- Reject: `episodeCount == 0`; `result > 2`; `levelAsserted > 4`; `checkId == 0`; `issuedAt == 0`.
- Leaf hash = `keccak256(0x00 ‖ preimage)`; `decode(encode(x)) == x`.
- Use `abi.encodePacked`; never `abi.encode`.

## Tests
Round-trip fuzz (Solidity 256 runs; TS random); each rejection; offsets
checked field-by-field against the PLAN table.

## Acceptance
`forge test` and `pnpm test:protocol` green.

## Security
Offsets are hand-written twice; T-008 vectors are the proof they agree.
