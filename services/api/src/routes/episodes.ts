import { Hono } from "hono";
import type { Hex } from "viem";
import type { AppEnv } from "../app.ts";
import { getJsonBody, parseOrThrow, notImplemented } from "../app.ts";
import { requireAuth } from "../auth.ts";
import { ApiError } from "../errors.ts";
import { CreateEpisodeBody } from "../schemas/requests.ts";
import { manifestHash as computeManifestHash } from "../../../../packages/protocol/src/mapping.ts";
import { verify as verifySignature } from "../../../../packages/protocol/src/sign.ts";
import { commitEpisode } from "../ingest/commit.ts";
import { computeBadges } from "../../../../packages/protocol/src/badges.ts";
import { loadChecksConfig } from "../../../verify/src/config.ts";

export const episodeRoutes = new Hono<AppEnv>()
  // POST /v1/episodes — org (SDK path). §9.1 validated, §10.4 payload_hash
  // recomputed and the manifest signature verified before anything is
  // appended (PLAN §12 binding rule).
  .post("/episodes", async (c) => {
    const { keyStore, registry, logStore, uploadRegistry, operator, onEpisodeCommitted } = c.get("deps");
    if (!logStore) throw new ApiError("internal", "log store not configured");
    const principal = requireAuth(keyStore, c.req.header("Authorization"));
    const body = parseOrThrow(CreateEpisodeBody, await getJsonBody(c));
    const manifest = body.manifest;

    if (manifest.org_id !== principal.orgId) {
      throw new ApiError("forbidden", "manifest org_id must match the caller's organisation");
    }
    if (!manifest.signature) {
      throw new ApiError("unauthorized", "manifest must carry a signature");
    }

    const mHash = computeManifestHash(manifest);
    const now = Math.floor(Date.now() / 1000);
    // D-20/I-14: a not-yet-anchored leaf's signature is checked against
    // key validity *now*, re-evaluated at first-anchor time (T-024 `resolveKey`).
    const keyRow = registry.resolveKey(manifest.signature.key_id as Hex, now);
    if (!keyRow || keyRow.orgId !== principal.orgId) {
      throw new ApiError("unauthorized", "signature key is not a currently-valid key of the caller's organisation");
    }
    const sigValid = await verifySignature(
      manifest.signature.alg as "ed25519" | "p256",
      "manifest",
      mHash,
      manifest.signature.sig as Hex,
      keyRow.pubkey,
    );
    if (!sigValid) {
      throw new ApiError("unauthorized", "manifest signature does not verify");
    }

    for (const f of manifest.files) {
      const upload = await uploadRegistry.get(f.hash as Hex);
      if (!upload || upload.status !== "stored" || upload.orgId !== principal.orgId) {
        throw new ApiError("unprocessable", `file ${f.hash} is not a stored upload of this organisation`, { hash: f.hash });
      }
    }

    if (!operator) throw new ApiError("internal", "operator signing key not configured");
    const outcome = await commitEpisode(
      { store: logStore, now: () => Math.floor(Date.now() / 1000), operator, onEpisodeCommitted },
      principal.orgId,
      manifest,
      manifest.dataset_id ?? null,
      null,
    );

    return c.json({
      leaf_hash: outcome.leafHash,
      leaf_index: outcome.leafIndex,
      submitted_at: outcome.submittedAt,
      receipt: outcome.receipt,
    });
  })
  // GET /v1/episodes/{leafHash} — public
  // Return { preimage, leaf_index, submitted_at, badges, wording, claims, anchor? }
  .get("/episodes/:leafHash", (c) => {
    const { logStore, registry } = c.get("deps");
    const store = logStore ?? registry?.getStore();
    if (!store) throw new ApiError("internal", "log store not configured");

    const leafHash = c.req.param("leafHash") as Hex;

    // Get episode metadata
    const episodeMeta = store.episodeMeta(leafHash);
    if (!episodeMeta) {
      throw new ApiError("not_found", `episode ${leafHash} not found`);
    }

    // Get claims for this episode
    const claims = store.claimsFor(leafHash);

    // Find the anchor containing this leaf
    let anchor: { root: Hex; size: number; chains?: any[] } | undefined;
    let latestAnchor: { root: Hex; size: number; blockNumber: number; at: number } | undefined;
    const leaves = store.leaves();
    const leafIndex = leaves.indexOf(leafHash);
    if (leafIndex !== -1) {
      const anchors = store.anchors();
      // Get the latest anchor for badge computation
      if (anchors.length > 0) {
        const latest = anchors[anchors.length - 1];
        latestAnchor = latest;
      }
      // Find the first anchor covering this leaf
      for (const a of anchors) {
        if (leafIndex < a.size) {
          anchor = { root: a.root, size: a.size };
          // Get chain locators from anchorChains
          const chains = store.anchorChains(a.root, a.size);
          if (chains.length > 0) {
            anchor.chains = chains.map((ch) => ({
              chain_id: ch.chainId,
              index: ch.idx,
              at: ch.at,
              block_number: ch.blockNumber,
              tx_hash: ch.txHash,
            }));
          }
          break;
        }
      }
    }

    // Compute badges using T-021 badge engine
    const checksConfig = loadChecksConfig();
    const badgeResult = computeBadges({
      anchored: anchor ? {
        chain: "primary", // TODO: get actual chain name from chain config
        block: String(anchor.chains?.[0]?.block_number ?? 0),
        size: String(anchor.size),
      } : null,
      consent: { status: "live" }, // TODO: query actual consent status from store
      signature: null, // T-021 notes: signature/attestation null for now
      attestation: null,
      claims: claims.map((c) => ({
        check: c.check,
        result: c.result as "pass" | "fail" | "inconclusive",
        issued_at: c.issuedAt,
        detail: c.detail ? { summary: c.detail } : undefined,
      })),
      checksConfig,
    });

    const response: any = {
      preimage: episodeMeta.preimage,
      leaf_index: episodeMeta.index,
      submitted_at: episodeMeta.submittedAt,
      badges: badgeResult.badges,
      wording: badgeResult.wording,
      claims: claims.map((c) => ({
        check: c.check,
        result: c.result,
        issued_at: c.issuedAt,
        detail: c.detail,
        verifier_key_id: c.verifierKeyId,
      })),
    };

    if (anchor) {
      response.anchor = anchor;
    }

    return c.json(response);
  });
