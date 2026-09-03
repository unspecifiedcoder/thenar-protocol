import { Hono } from "hono";
import { isAddress, type Hex } from "viem";
import type { AppEnv } from "../app.ts";
import { getJsonBody, parseOrThrow, notImplemented } from "../app.ts";
import { requireAuth } from "../auth.ts";
import { ApiError } from "../errors.ts";
import { CorpusManifestInput, type CorpusManifest } from "../schemas/corpusManifest.ts";
import { isUnreachable } from "../chain.ts";
import type { ILogStore } from "../../../log/src/store-interface.ts";
import { encodeCorpus, corpusLeafHash } from "../../../../packages/protocol/src/corpus.ts";

/**
 * PLAN §8 `Corpus.containsRevoked`: true when any episode this corpus was
 * sealed over now has a live revocation (D-19 consent semantics). Computed
 * fresh from the store's `revocation` table on every read rather than
 * trusted from the `corpus` row's own `contains_revoked` column — a
 * revocation can arrive after the corpus was sealed, and the column is only
 * as current as whatever last wrote it.
 */
function computeContainsRevoked(logStore: ILogStore, corpusId: string): boolean {
  const revoked = new Set(logStore.revocations().map((r) => r.consentKey));
  if (revoked.size === 0) return false;
  for (const { leafHash } of logStore.corpusEpisodeLeaves(corpusId)) {
    const meta = logStore.episodeMeta(leafHash);
    if (meta?.consentKey && revoked.has(meta.consentKey)) return true;
  }
  return false;
}

export const corpusRoutes = new Hono<AppEnv>()
  // POST /v1/corpora — org
  .post("/corpora", async (c) => {
    const { keyStore } = c.get("deps");
    requireAuth(keyStore, c.req.header("Authorization"));
    const body = parseOrThrow(CorpusManifestInput, await getJsonBody(c));
    return notImplemented(`create corpus "${body.title}"`);
  })
  // POST /v1/corpora/{id}/log — org
  .post("/corpora/:id/log", (c) => {
    const { keyStore } = c.get("deps");
    requireAuth(keyStore, c.req.header("Authorization"));
    return notImplemented(`log corpus ${c.req.param("id")}`);
  })
  // GET /v1/corpora/{id}/seal-params?price=&token=&supplier= — org (PLAN §12,
  // §11.3 `SealParams`). The manifest schema (§9.2) does not itself carry a
  // price, a settlement token or a supplier address — those are the
  // caller's own commercial terms, not something the log ever computed —
  // so the org running `scripts/seal-corpus.mjs` supplies them as query
  // parameters and this route folds them into `seal_params` alongside the
  // facts it *can* prove: the corpus's own hashes, terms hash and episode
  // count, re-derived from the exact 0x03 preimage the log anchored (never
  // invented, I-11).
  .get("/corpora/:id/seal-params", (c) => {
    const { keyStore, logStore } = c.get("deps");
    requireAuth(keyStore, c.req.header("Authorization"));
    if (!logStore) throw new ApiError("internal", "log store not configured");
    const id = c.req.param("id");
    const row = logStore.corpusById(id);
    if (!row) throw new ApiError("not_found", `no corpus ${id}`);
    if (row.manifestLeafHash === null || row.manifestLeafIdx === null) {
      throw new ApiError("conflict", "corpus not logged");
    }

    const price = c.req.query("price");
    const token = c.req.query("token");
    const supplier = c.req.query("supplier");
    if (!price || !/^[0-9]+$/.test(price)) throw new ApiError("invalid_request", "query param price must be a non-negative integer");
    if (!token || !isAddress(token)) throw new ApiError("invalid_request", "query param token must be an address");
    if (!supplier || !isAddress(supplier)) throw new ApiError("invalid_request", "query param supplier must be an address");

    const manifest = JSON.parse(row.manifest) as CorpusManifest;
    if (manifest.sealed_at === null || manifest.sealed_at === undefined) {
      throw new ApiError("conflict", "corpus not logged");
    }
    const episodeCount = BigInt(manifest.episode_count ?? manifest.episodes.length);
    const taskId = (manifest.task_id ?? ("0x" + "00".repeat(32))) as Hex;

    const preimage03 = encodeCorpus({
      corpusManifestHash: row.corpusManifestHash,
      corpusRoot: row.corpusRoot,
      termsHash: manifest.terms_hash,
      taskId,
      episodeCount,
      sealedAt: BigInt(manifest.sealed_at),
    });
    // Sanity check, never trusted blindly (I-11): the preimage this route
    // just rebuilt from the stored manifest must hash to the exact leaf the
    // log recorded at commit time, or something upstream is inconsistent.
    if (corpusLeafHash(preimage03) !== row.manifestLeafHash) {
      throw new ApiError("internal", "reconstructed corpus preimage does not match the logged leaf");
    }

    const anchors = logStore.anchors().filter((a) => a.size > (row.manifestLeafIdx as number));
    if (anchors.length === 0) throw new ApiError("conflict", "corpus leaf not yet anchored");
    const anchor = anchors[0];
    const chainRows = logStore.anchorChains(anchor.root, anchor.size);
    if (chainRows.length === 0) throw new ApiError("conflict", "corpus leaf's anchor has not reached any chain yet");

    const logProof = logStore.inclusionProof(row.manifestLeafIdx, anchor.size);

    return c.json({
      seal_params: {
        corpusManifestHash: row.corpusManifestHash,
        corpusRoot: row.corpusRoot,
        termsHash: manifest.terms_hash,
        episodeCount: episodeCount.toString(),
        supplier,
        price,
        token,
      },
      preimage03,
      log_proof: logProof,
      leaf_index: row.manifestLeafIdx,
      anchor: {
        root: anchor.root,
        size: anchor.size,
        chains: chainRows.map((r) => ({ chain_id: r.chainId, index: r.idx })),
      },
    });
  })
  // GET /v1/corpora/{id}/onchain — public. `sealCorpus` (PLAN §11.3) is run
  // by a script from the supplier's own wallet, off any path this service
  // controls, so nothing here ever learns the on-chain corpus id by being
  // told it — it is found the only trustworthy way: scanning
  // `corpusCount()`/`corpusAt(i)` on the primary `LicenceRegistry` for the
  // entry whose `corpusManifestHash` matches this row's. Not in PLAN §12's
  // table; added per the T-027 supervisor note because no lookup by
  // manifest hash exists on chain or in the store.
  .get("/corpora/:id/onchain", async (c) => {
    const { logStore, graspReader } = c.get("deps");
    if (!logStore) throw new ApiError("internal", "log store not configured");
    const id = c.req.param("id");
    const row = logStore.corpusById(id);
    if (!row) throw new ApiError("not_found", `no corpus ${id}`);
    if (!graspReader) return c.json({ unreachable: true, chain_id: null });

    const countResult = await graspReader.corpusCount();
    if (isUnreachable(countResult)) return c.json({ unreachable: true, chain_id: countResult.chain_id });

    for (let i = 0; i < countResult.count; i++) {
      const corpus = await graspReader.corpusAt(i);
      if (isUnreachable(corpus)) continue;
      if (corpus.corpusManifestHash.toLowerCase() === row.corpusManifestHash.toLowerCase()) {
        return c.json({ on_chain_id: String(i), corpus });
      }
    }
    throw new ApiError("not_found", `corpus ${id} has not been sealed on chain yet`);
  })
  // GET /v1/corpora/{id} — public. Store row + on-chain `corpusAt` block
  // (D-29, PLAN §12/§15) when the corpus carries an `onChainId`, plus
  // `contains_revoked` computed fresh from the store's revocations.
  .get("/corpora/:id", async (c) => {
    const { logStore, graspReader } = c.get("deps");
    if (!logStore) throw new ApiError("internal", "log store not configured");
    const id = c.req.param("id");
    const row = logStore.corpusById(id);
    if (!row) throw new ApiError("not_found", `no corpus ${id}`);

    let onChain: unknown = null;
    if (row.onChainId !== null) {
      if (!graspReader) {
        onChain = { unreachable: true, chain_id: null };
      } else {
        const result = await graspReader.corpusAt(row.onChainId);
        onChain = isUnreachable(result)
          ? { unreachable: true, chain_id: result.chain_id }
          : result;
      }
    }

    return c.json({
      corpus_id: row.corpusId,
      org_id: row.orgId,
      manifest: JSON.parse(row.manifest),
      corpus_manifest_hash: row.corpusManifestHash,
      corpus_root: row.corpusRoot,
      manifest_leaf_hash: row.manifestLeafHash,
      manifest_leaf_index: row.manifestLeafIdx,
      on_chain_id: row.onChainId,
      status: row.status,
      contains_revoked: computeContainsRevoked(logStore, id),
      on_chain: onChain,
    });
  })
  // GET /v1/corpora/{id}/report?format= — public
  .get("/corpora/:id/report", (c) => notImplemented(`report for corpus ${c.req.param("id")}`));
