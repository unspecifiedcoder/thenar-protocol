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

export const episodeRoutes = new Hono<AppEnv>()
  // POST /v1/episodes — org (SDK path). §9.1 validated, §10.4 payload_hash
  // recomputed and the manifest signature verified before anything is
  // appended (PLAN §12 binding rule).
  .post("/episodes", async (c) => {
    const { keyStore, registry, logStore, uploadRegistry, operator } = c.get("deps");
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
      { store: logStore, now: () => Math.floor(Date.now() / 1000), operator },
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
  .get("/episodes/:leafHash", (c) => notImplemented(`episode detail for ${c.req.param("leafHash")}`));
