# T-014 — Store hardening: SQLite triggers, cached nodes, v2 tables

**Tier:** STRONG. Enforced immutability (I-2) and O(log n) proofs (D-24).

## Objective
Keep SQLite; add append-only triggers, a cached-node table so roots and
proofs are O(log n), and the v2 tables from PLAN §14.

## Dependencies
T-004.

## Files
- Modify `services/log/src/store.ts`; create `services/log/src/schema.sql`, `services/log/src/tree.ts` (cached-node algorithms), tests in `services/log/test/log.test.ts` and `test/tree.test.ts`.

## Interfaces (additions to `LogStore`)
```ts
append(leaf, meta): number              // now updates `node` rows in the same transaction
root(upTo?): Hex                         // from cached nodes; must equal ct.root(leaves(upTo)) for all sizes
inclusionProof(index, size?): Hex[]      // from cached nodes
consistencyProof(m, n?): Hex[]
recordAnchor(root, size, revocationRoot, chain: {chainId, index, blockNumber, txHash, at})
anchorBy(root, size) / anchorChains(root, size)
lastAnchored(chainId): { size, revocationRoot } | null
episodeMeta(leafHash) / claimsFor(leafHash) / byOrg(orgId, cursor, limit) / byDataset(datasetId)
```

## Expected behaviour
- Triggers: `BEFORE UPDATE OR DELETE ON leaf, anchor, revocation, claim → SELECT RAISE(ABORT, 'append-only')`.
- `node(level, idx, hash)`: complete subtree roots; prefix roots (`root(upTo)`
  for `upTo < size`) computed by the RFC 6962 split recursion over cached
  complete subtrees; equality with pure `ct.root` tested for sizes 1..300.
- Tables: `org, api_key, signing_key, dataset, upload, leaf, node, anchor,
  anchor_chain, revocation, corpus, corpus_episode, claim, report, idempotency, job`.
- `append` is one transaction (`BEGIN IMMEDIATE`).

## Edge cases
Restart mid-transaction (WAL rollback); `size` 1; proofs for the last leaf
at odd sizes.

## Tests
Trigger rejection; root/proof equality vs pure TS for 1..300; existing suite green; 50 sequential appends → indices 0..49.

## Acceptance
`pnpm test:log` green; `proof` CLI works for a 10k-leaf DB in < 50 ms.

## Security
API DB role concept N/A in SQLite; file permissions documented.
