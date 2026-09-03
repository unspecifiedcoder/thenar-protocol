import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { getJsonBody, parseOrThrow, notImplemented } from "../app.ts";
import { requireAuth } from "../auth.ts";
import { ApiError } from "../errors.ts";
import { CorpusManifestInput } from "../schemas/corpusManifest.ts";
import { isUnreachable } from "../chain.ts";
import type { ILogStore } from "../../../log/src/store-interface.ts";

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
  // GET /v1/corpora/{id}/seal-params — org
  .get("/corpora/:id/seal-params", (c) => {
    const { keyStore } = c.get("deps");
    requireAuth(keyStore, c.req.header("Authorization"));
    return notImplemented(`seal params for corpus ${c.req.param("id")}`);
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
