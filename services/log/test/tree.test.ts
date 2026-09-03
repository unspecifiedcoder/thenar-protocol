/** T-014: SQLite hardening — append-only triggers, cached-node tree, v2 tables. */
import { keccak256, toHex, type Hex } from "viem";
import { rmSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { LogStore } from "../src/store.ts";
import * as ct from "../../../packages/protocol/src/log.ts";

let fails = 0;
const ok = (c: boolean, m: string, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };
const h = (s: string): Hex => keccak256(toHex(s));

function freshPath(name: string): string {
  const p = `/tmp/thenar-tree-test-${name}.db`;
  for (const f of [p, `${p}-wal`, `${p}-shm`]) if (existsSync(f)) rmSync(f);
  return p;
}

// ============================================================================
// append-only triggers — every protected table rejects UPDATE and DELETE
// ============================================================================
{
  const store = new LogStore(":memory:");

  const idx = store.append(h("leaf-0"));
  store._revokeUnchecked(h("consent-0"), h("value-0"));
  store.recordAnchor(0, store.root(), store.size(), h("revroot-0"), "0xtx", 1);
  store.recordAnchorChain(1, 0, store.root(), store.size(), h("revroot-0"), "0xtx", 1);
  store.recordClaim({
    leafHash: h("claim-0"), subjectLeaf: h("leaf-0"), verifierKeyId: h("verifier-0"),
    check: "dedup.v1", result: "pass", levelAsserted: 3,
    detail: "{}", detailHash: h("detail-0"), issuedAt: 1756900000, signature: null,
  });

  // Reach into the raw db (test-only) to attempt the UPDATE/DELETE statements
  // themselves — LogStore's own public API has no update/delete path to call.
  const raw = (store as unknown as { db: DatabaseSync }).db;

  const rejects = (sql: string, label: string) => {
    let threw = false;
    let msg = "";
    try { raw.prepare(sql).run(); } catch (e) { threw = true; msg = (e as Error).message; }
    ok(threw && msg.includes("append-only"), label, msg || "no error thrown");
  };

  rejects(`UPDATE leaf SET success = 0 WHERE idx = ${idx}`, "leaf rejects UPDATE");
  rejects(`DELETE FROM leaf WHERE idx = ${idx}`, "leaf rejects DELETE");
  rejects(`UPDATE anchor SET size = 999 WHERE idx = 0`, "anchor rejects UPDATE");
  rejects(`DELETE FROM anchor WHERE idx = 0`, "anchor rejects DELETE");
  rejects(`UPDATE anchor_chain SET size = 999 WHERE chain_id = 1 AND idx = 0`, "anchor_chain rejects UPDATE");
  rejects(`DELETE FROM anchor_chain WHERE chain_id = 1 AND idx = 0`, "anchor_chain rejects DELETE");
  rejects(`UPDATE revocation SET value = '${h("tampered")}' WHERE consent_key = '${h("consent-0")}'`, "revocation rejects UPDATE");
  rejects(`DELETE FROM revocation WHERE consent_key = '${h("consent-0")}'`, "revocation rejects DELETE");
  rejects(`UPDATE claim SET result = 'fail' WHERE leaf_hash = '${h("claim-0")}'`, "claim rejects UPDATE");
  rejects(`DELETE FROM claim WHERE leaf_hash = '${h("claim-0")}'`, "claim rejects DELETE");

  // The service's own idempotent re-inserts (INSERT OR REPLACE on a repeated
  // key) must still work — the triggers must not turn those into errors.
  let replayThrew = false;
  try { store._revokeUnchecked(h("consent-0"), h("value-0")); } catch { replayThrew = true; }
  ok(!replayThrew, "an idempotent INSERT OR REPLACE (e.g. a repeated revocation) is not blocked by the append-only trigger");

  store.close();
}

// ============================================================================
// root/inclusionProof/consistencyProof equality vs the pure reference
// (packages/protocol/src/log.ts) for every size 1..300
// ============================================================================
{
  const store = new LogStore(":memory:");
  const leaves: Hex[] = [];

  let allRootsMatch = true;
  let firstRootMismatch = "";
  for (let n = 1; n <= 300; n++) {
    const leaf = h(`eq-leaf-${n - 1}`);
    leaves.push(leaf);
    store.append(leaf);
    const got = store.root();
    const want = ct.root(leaves);
    if (got !== want) {
      allRootsMatch = false;
      if (!firstRootMismatch) firstRootMismatch = `size ${n}: got ${got}, want ${want}`;
    }
  }
  ok(allRootsMatch, "root(n) equals the pure reference for every size 1..300", firstRootMismatch);

  // Inclusion proofs: every index, at a representative sample of sizes
  // (including size 1, an odd size, a power of two, and the final size 300).
  const inclusionSizes = [1, 2, 3, 5, 7, 8, 13, 16, 17, 63, 64, 65, 127, 128, 129, 200, 255, 256, 257, 299, 300];
  let allInclusionMatch = true;
  let firstInclusionMismatch = "";
  for (const n of inclusionSizes) {
    const slice = leaves.slice(0, n);
    for (let i = 0; i < n; i++) {
      const got = store.inclusionProof(i, n);
      const want = ct.inclusionProof(slice, i);
      const same = got.length === want.length && got.every((v, j) => v === want[j]);
      if (!same) {
        allInclusionMatch = false;
        if (!firstInclusionMismatch) firstInclusionMismatch = `size ${n}, index ${i}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`;
      }
    }
  }
  ok(allInclusionMatch, `inclusionProof matches the pure reference for every index at sizes ${JSON.stringify(inclusionSizes)}`, firstInclusionMismatch);

  // Consistency proofs: every (m, n) pair at a sample of final sizes.
  const consistencySizes = [1, 2, 8, 9, 16, 64, 100, 128, 200, 256, 300];
  let allConsistencyMatch = true;
  let firstConsistencyMismatch = "";
  for (const n of consistencySizes) {
    const slice = leaves.slice(0, n);
    for (let m = 1; m <= n; m++) {
      const got = store.consistencyProof(m, n);
      const want = ct.consistencyProof(slice, m, n);
      const same = got.length === want.length && got.every((v, j) => v === want[j]);
      if (!same) {
        allConsistencyMatch = false;
        if (!firstConsistencyMismatch) firstConsistencyMismatch = `(m=${m}, n=${n}): got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`;
      }
    }
  }
  ok(allConsistencyMatch, `consistencyProof matches the pure reference for every (m, n) pair at sizes ${JSON.stringify(consistencySizes)}`, firstConsistencyMismatch);

  // Odd-size edge case explicitly: proof for the *last* leaf at every odd size.
  let lastLeafOddOk = true;
  for (let n = 1; n <= 300; n += 2) {
    const slice = leaves.slice(0, n);
    const got = store.inclusionProof(n - 1, n);
    const want = ct.inclusionProof(slice, n - 1);
    if (got.length !== want.length || !got.every((v, j) => v === want[j])) lastLeafOddOk = false;
  }
  ok(lastLeafOddOk, "the last leaf's inclusion proof matches the reference at every odd size 1..300");

  // size === 1 root is exactly the leaf hash itself (RFC 6962: single leaf = the leaf hash).
  ok(store.root(1) === leaves[0], "root(1) is the leaf hash itself, not a hashed node");

  store.close();
}

// ============================================================================
// 50 sequential appends land at indices 0..49
// ============================================================================
{
  const store = new LogStore(":memory:");
  let sequential = true;
  for (let i = 0; i < 50; i++) {
    const idx = store.append(h(`seq-${i}`));
    if (idx !== i) sequential = false;
  }
  ok(sequential, "50 sequential appends land at indices 0..49");
  ok(store.size() === 50, "the store holds exactly 50 leaves");
  store.close();
}

// ============================================================================
// restart mid-transaction: a second connection after an aborted transaction
// sees the size unchanged (WAL rollback simulation)
// ============================================================================
{
  const path = freshPath("restart-midtx");
  const store = new LogStore(path);
  store.append(h("pre-0"));
  store.append(h("pre-1"));
  const sizeBefore = store.size();
  const rootBefore = store.root();

  // Simulate a crash mid-append: begin a write transaction, insert a leaf
  // row *and* its node-cache entries, but never commit — then close that
  // connection without committing (the same outcome a crashed process
  // leaves: whatever the OS/SQLite discards on an unclean shutdown of a
  // connection holding an open write transaction) and open a *fresh*
  // connection on the same file, as a restart would, confirming it observes
  // no partial state at all — neither the `leaf` row nor the `node` rows
  // the crashed append would have written.
  const raw = (store as unknown as { db: DatabaseSync }).db;
  raw.exec("BEGIN IMMEDIATE");
  raw.prepare(
    `INSERT INTO leaf (idx, leaf, preimage, task_id, contributor, quality_score, success,
                        manifest, manifest_hash, payload_hash, dataset_id, org_id, consent_key,
                        submitted_at, created_at)
     VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
  ).run(sizeBefore, h("crashed-leaf"), Date.now());
  raw.prepare("INSERT INTO node (level, idx, hash) VALUES (0, ?, ?)").run(sizeBefore, h("crashed-leaf"));
  // Closing with a transaction still open rolls it back (SQLite never
  // persists an uncommitted transaction across a connection's lifetime) —
  // exactly what a crash before COMMIT leaves on disk for the next reader.
  store.close();

  const restarted = new LogStore(path);
  ok(restarted.size() === sizeBefore, "after a restart, a leaf inserted in an uncommitted transaction is gone — the size is unchanged");
  ok(restarted.root() === rootBefore, "after a restart, the root is unchanged — the crashed append left no trace");

  // The store must still be fully usable afterwards (no corrupt cache state).
  const idx = restarted.append(h("post-restart"));
  ok(idx === sizeBefore, "appending after a restart continues at the correct index");
  ok(restarted.root() === ct.root([...restarted.leaves()]), "the root after recovery matches the pure reference");

  restarted.close();
}

// ============================================================================
// v2 interface additions: anchorBy/anchorChains/lastAnchored/episodeMeta/
// claimsFor/byOrg/byDataset — round-trip against what was written
// ============================================================================
{
  const store = new LogStore(":memory:");

  const leaf = h("episode-leaf-0");
  store.append(leaf, {
    orgId: "org-1", datasetId: "dataset-1",
    manifest: "{}", manifestHash: h("manifest-0"), payloadHash: h("payload-0"),
    consentKey: h("consent-episode-0"), submittedAt: 1756900000,
  } as any);

  const meta = store.episodeMeta(leaf);
  ok(meta !== null && meta.orgId === "org-1" && meta.datasetId === "dataset-1", "episodeMeta round-trips org/dataset ids");
  ok(meta !== null && meta.manifestHash === h("manifest-0") && meta.payloadHash === h("payload-0"), "episodeMeta round-trips manifest/payload hashes");
  ok(store.episodeMeta(h("never-appended")) === null, "episodeMeta returns null for an unknown leaf, not a fabricated row");

  const claim: import("../src/store-interface.ts").ClaimRow = {
    leafHash: h("claim-leaf-0"), subjectLeaf: leaf, verifierKeyId: h("verifier-0"),
    check: "dedup.v1", result: "pass", levelAsserted: 3,
    detail: JSON.stringify({ thresholds: {} }), detailHash: h("detail-0"),
    issuedAt: 1756900000, signature: null,
  };
  store.recordClaim(claim);
  const claims = store.claimsFor(leaf);
  ok(claims.length === 1 && claims[0].check === "dedup.v1" && claims[0].result === "pass", "claimsFor returns the recorded claim");
  ok(store.claimsFor(h("no-claims-here")).length === 0, "claimsFor returns empty, not fabricated rows, for a leaf with no claims");

  for (let i = 1; i < 5; i++) {
    store.append(h(`org-leaf-${i}`), { orgId: "org-1" } as any);
  }
  const page1 = store.byOrg("org-1", undefined, 2);
  ok(page1.items.length === 2 && page1.nextCursor !== null, "byOrg paginates with a cursor when more rows remain");
  const page2 = store.byOrg("org-1", page1.nextCursor ?? undefined, 2);
  ok(page2.items.length === 2 && page2.items[0].index === page1.items[1].index + 1, "byOrg's cursor continues immediately after the prior page");
  const rest = store.byOrg("org-1", page2.nextCursor ?? undefined, 10);
  ok(rest.nextCursor === null, "byOrg's cursor is null once every row for that org has been paged through");

  ok(store.byDataset("dataset-1").length === 1 && store.byDataset("dataset-1")[0].leaf === leaf, "byDataset returns exactly the episodes tagged with that dataset");
  ok(store.byDataset("no-such-dataset").length === 0, "byDataset returns empty for an unknown dataset");

  const root = store.root();
  const size = store.size();
  store.recordAnchor(0, root, size, h("revroot-x"), "0xanchor", 42);
  store.recordAnchorChain(7, 0, root, size, h("revroot-x"), "0xchain7", 42);
  ok(store.anchorBy(root, size)?.txHash === "0xanchor", "anchorBy finds the legacy anchor row by exact (root, size)");
  ok(store.anchorBy(h("wrong-root"), size) === null, "anchorBy returns null for a root that was never anchored");
  const chains = store.anchorChains(root, size);
  ok(chains.length === 1 && chains[0].chainId === 7, "anchorChains finds every chain's row for an exact (root, size)");
  const last = store.lastAnchored(7);
  ok(last !== null && last.size === size && last.revocationRoot === h("revroot-x"), "lastAnchored returns the most recent size/revocationRoot for a chain");
  ok(store.lastAnchored(999) === null, "lastAnchored returns null for a chain that has never anchored");

  store.close();
}

// ============================================================================
// `proof` CLI timing: a 10k-leaf in-memory DB, inclusion proof < 50ms
// ============================================================================
{
  const store = new LogStore(":memory:");
  const N = 10_000;
  for (let i = 0; i < N; i++) store.append(h(`perf-${i}`));
  ok(store.size() === N, "the perf store holds 10,000 leaves");

  const t0 = performance.now();
  const proof = store.inclusionProof(N - 1, N);
  const rootAtN = store.root(N);
  const t1 = performance.now();
  const elapsedMs = t1 - t0;

  const replay = (() => {
    let node = h(`perf-${N - 1}`), i = N - 1, m = N, p = 0;
    while (m > 1) {
      if (i % 2 === 1) node = ct.hashNode(proof[p++], node);
      else if (i + 1 < m) node = ct.hashNode(node, proof[p++]);
      i = Math.floor(i / 2); m = Math.ceil(m / 2);
    }
    return node;
  })();
  ok(replay === rootAtN, "the 10k-leaf inclusion proof actually verifies against the root");
  ok(elapsedMs < 50, `an inclusion proof + root over a 10,000-leaf log takes under 50ms`, `${elapsedMs.toFixed(3)}ms`);
  console.log(`  timing: inclusionProof(9999, 10000) + root(10000) over a 10,000-leaf in-memory log = ${elapsedMs.toFixed(3)}ms`);

  store.close();
}

console.log(fails === 0 ? "\ntree cache: all checks passed\n" : `\n${fails} check(s) failed\n`);
process.exit(fails ? 1 : 0);
