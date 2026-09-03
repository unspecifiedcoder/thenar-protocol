import { Hono } from "hono";
import { isAddress, type Hex } from "viem";
import type { AppEnv } from "../app.ts";
import { getJsonBody, parseOrThrow } from "../app.ts";
import { requireAuth } from "../auth.ts";
import { ApiError } from "../errors.ts";
import { CorpusManifestInput, type CorpusManifest } from "../schemas/corpusManifest.ts";
import { isUnreachable } from "../chain.ts";
import type { ILogStore } from "../../../log/src/store-interface.ts";
import { encodeCorpus, corpusLeafHash } from "../../../../packages/protocol/src/corpus.ts";
import { corpusManifestHash as computeCorpusManifestHash, corpusRootOf } from "../../../../packages/protocol/src/mapping.ts";
import { newUlid } from "../registry.ts";
import { deriveSources } from "../ingest/corpus.ts";
import type { Source } from "../../../../packages/protocol/src/schemas.ts";
import { buildReport } from "../report/build.ts";
import { renderReportHtml } from "../report/render.ts";
import { PlaywrightPdfRenderer, PdfUnavailableError } from "../report/pdf.ts";

const defaultPdfRenderer = new PlaywrightPdfRenderer();

const ZERO32 = ("0x" + "00".repeat(32)) as Hex;

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
  // POST /v1/corpora — org (PLAN §9.2/§12). The caller supplies everything
  // except `corpus_root`/`episode_count`/`sources`, which the server
  // computes from the member episodes actually in the log (§9.2: "derived
  // by the server"; never trusted from the caller, I-11). Refuses an
  // episode that is not logged (`unprocessable`) or that carries a live
  // revocation (422 `consent_revoked`, naming every offending episode —
  // §6.1: "the log service refuses to include the episode in a manifest
  // logged after [revocation]"). Stores a `draft` row; `sealed_at` is
  // always written as `null` here regardless of what the caller sent —
  // it is set only by `POST /corpora/{id}/log`.
  .post("/corpora", async (c) => {
    const { keyStore, logStore } = c.get("deps");
    if (!logStore) throw new ApiError("internal", "log store not configured");
    const principal = requireAuth(keyStore, c.req.header("Authorization"));
    const body = parseOrThrow(CorpusManifestInput, await getJsonBody(c));

    if (body.org_id !== principal.orgId) {
      throw new ApiError("forbidden", "manifest org_id must match the caller's organisation");
    }

    const revokedKeys = new Set(logStore.revocations().map((r) => r.consentKey));
    const revokedEpisodes: Hex[] = [];
    const entries: { leaf: Hex; logIndex: number }[] = [];
    const sources: Source[] = [];
    for (const leaf of body.episodes as Hex[]) {
      const meta = logStore.episodeMeta(leaf);
      if (!meta) {
        throw new ApiError("unprocessable", `episode ${leaf} is not in the log`, { leaf_hash: leaf });
      }
      if (meta.consentKey && revokedKeys.has(meta.consentKey)) {
        revokedEpisodes.push(leaf);
        continue;
      }
      entries.push({ leaf, logIndex: meta.index });
      if (meta.manifest) {
        const parsed = JSON.parse(meta.manifest) as { source?: Source };
        if (parsed.source) sources.push(parsed.source);
      }
    }
    if (revokedEpisodes.length > 0) {
      throw new ApiError("unprocessable", "consent_revoked", { code: "consent_revoked", episodes: revokedEpisodes });
    }
    if (entries.length === 0) {
      throw new ApiError("invalid_request", "episodes must be non-empty");
    }

    // corpusRootOf sorts by logIndex ascending itself (PLAN §10.7) — the
    // manifest stores episodes in that same order (§9.2: "SORTED by log
    // index ascending"), independent of the order the caller supplied.
    const corpusRoot = corpusRootOf(entries);
    const sortedEntries = [...entries].sort((a, b) => a.logIndex - b.logIndex);

    const fullManifest: CorpusManifest = {
      ...body,
      episodes: sortedEntries.map((e) => e.leaf),
      corpus_root: corpusRoot,
      episode_count: entries.length,
      sources: deriveSources(sources),
      sealed_at: null,
    } as CorpusManifest;

    const cManifestHash = computeCorpusManifestHash(fullManifest);
    const corpusId = newUlid();
    const createdAt = Math.floor(Date.now() / 1000);

    logStore.insertCorpus(
      {
        corpusId, orgId: principal.orgId, manifest: JSON.stringify(fullManifest),
        corpusManifestHash: cManifestHash, corpusRoot,
        manifestLeafHash: null, manifestLeafIdx: null, onChainId: null,
        status: "draft", containsRevoked: false, createdAt,
      },
      sortedEntries.map((e, i) => ({ leafHash: e.leaf, corpusIndex: i })),
    );

    return c.json({
      corpus_id: corpusId,
      org_id: principal.orgId,
      manifest: fullManifest,
      corpus_manifest_hash: cManifestHash,
      corpus_root: corpusRoot,
      manifest_leaf_hash: null,
      manifest_leaf_index: null,
      on_chain_id: null,
      status: "draft",
      contains_revoked: false,
    });
  })
  // POST /v1/corpora/{id}/log — org (PLAN §9.2/§10.11/§12). Builds the
  // 0x03 `CorpusManifestLeaf` and appends it: `termsHash` from the stored
  // manifest, `taskId` from `manifest.task_id` (else zero), `episodeCount`
  // from the manifest, `sealedAt` = now. Re-checks revocation at this exact
  // moment (not only at draft-creation time) since §6.1's rule is about
  // what gets *logged*, and a revocation can land in the gap between
  // `POST /corpora` and this call.
  .post("/corpora/:id/log", async (c) => {
    const { keyStore, logStore } = c.get("deps");
    if (!logStore) throw new ApiError("internal", "log store not configured");
    const principal = requireAuth(keyStore, c.req.header("Authorization"));
    const id = c.req.param("id");
    const row = logStore.corpusById(id);
    if (!row) throw new ApiError("not_found", `no corpus ${id}`);
    if (row.orgId !== principal.orgId) {
      throw new ApiError("forbidden", "corpus belongs to a different organisation");
    }
    if (row.status !== "draft") {
      throw new ApiError("conflict", `corpus ${id} is already ${row.status}`);
    }

    const manifest = JSON.parse(row.manifest) as CorpusManifest;

    const revokedKeys = new Set(logStore.revocations().map((r) => r.consentKey));
    const revokedEpisodes: Hex[] = [];
    for (const leaf of manifest.episodes as Hex[]) {
      const meta = logStore.episodeMeta(leaf);
      if (meta?.consentKey && revokedKeys.has(meta.consentKey)) revokedEpisodes.push(leaf);
    }
    if (revokedEpisodes.length > 0) {
      throw new ApiError("unprocessable", "consent_revoked", { code: "consent_revoked", episodes: revokedEpisodes });
    }

    const sealedAt = Math.floor(Date.now() / 1000);
    const sealedManifest: CorpusManifest = { ...manifest, sealed_at: sealedAt };
    const taskId = (sealedManifest.task_id ?? ZERO32) as Hex;
    const episodeCount = BigInt(sealedManifest.episode_count ?? sealedManifest.episodes.length);
    // §9.2's `corpusManifestHash` covers the whole manifest, `sealed_at`
    // included — the draft-time hash (over `sealed_at: null`) is no longer
    // this manifest's hash once `sealed_at` is filled in.
    const cManifestHash = computeCorpusManifestHash(sealedManifest);

    const preimage03 = encodeCorpus({
      corpusManifestHash: cManifestHash,
      corpusRoot: row.corpusRoot,
      termsHash: sealedManifest.terms_hash as Hex,
      taskId,
      episodeCount,
      sealedAt: BigInt(sealedAt),
    });
    const leafHash = corpusLeafHash(preimage03);
    const leafIndex = logStore.append(leafHash, { preimage: preimage03 });

    logStore.setCorpusManifestLeaf(id, leafHash, leafIndex, "logged", JSON.stringify(sealedManifest), cManifestHash);

    return c.json({ leaf_hash: leafHash, leaf_index: leafIndex });
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
  // GET /v1/corpora/{id}/report?format= — public (PLAN §9.6/§12/§25).
  // JSON by default; `?format=pdf` renders `templates/report.html` through
  // headless Chromium (`report/pdf.ts`) — a browser-unavailable environment
  // answers `503 pdf_unavailable` rather than a fabricated body (I-11);
  // this is deliberately outside the closed `ErrorCode` enum in
  // `errors.ts` (no code there maps to a 503) since every other route's
  // failure modes are covered by that table and this one genuinely is not
  // ("the PDF renderer is not available" is neither a request error nor an
  // operator error).
  .get("/corpora/:id/report", async (c) => {
    const { logStore, verifier, pdfRenderer } = c.get("deps");
    if (!logStore) throw new ApiError("internal", "log store not configured");
    if (!verifier) throw new ApiError("internal", "verifier signing key not configured");
    const id = c.req.param("id");

    const report = buildReport(
      { logStore, operator: { name: "THENAR", verifierKeyId: verifier.keyId } },
      id,
    );

    const format = c.req.query("format");
    if (format === "pdf") {
      const html = renderReportHtml(report, { reportJsonUrl: `${new URL(c.req.url).origin}/v1/corpora/${id}/report` });
      try {
        const renderer = pdfRenderer ?? defaultPdfRenderer;
        const pdf = await renderer.renderPdf(html);
        return new Response(pdf as BodyInit, { status: 200, headers: { "content-type": "application/pdf" } });
      } catch (e) {
        if (e instanceof PdfUnavailableError) {
          return c.json({ error: { code: "pdf_unavailable", message: e.message } }, 503);
        }
        throw e;
      }
    }
    if (format && format !== "json") {
      throw new ApiError("invalid_request", `unknown format "${format}"`);
    }

    return c.json(report);
  });
