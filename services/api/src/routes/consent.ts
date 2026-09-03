import { Hono } from "hono";
import type { Hex } from "viem";
import type { AppEnv } from "../app.ts";
import { getJsonBody, parseOrThrow } from "../app.ts";
import { ApiError } from "../errors.ts";
import { RevokeConsentBody } from "../schemas/requests.ts";
import { SparseTree } from "../../../../packages/protocol/src/sparse.ts";
import { hashObjectExcluding, type JsonObject } from "../../../../packages/protocol/src/canonical.ts";
import type { OperatorSigner } from "../ingest/receipt.ts";

export type RevocationReceipt = {
  v: 1;
  kind: "revocation_receipt";
  consent_key: Hex;
  received_at: number;
  signature: { alg: "ed25519"; key_id: Hex; sig: Hex };
};

async function signRevocationReceipt(
  signer: OperatorSigner,
  consentKey: Hex,
  receivedAt: number,
): Promise<RevocationReceipt> {
  const { sign: signObject } = await import("../../../../packages/protocol/src/sign.ts");
  const unsigned = {
    v: 1 as const,
    kind: "revocation_receipt" as const,
    consent_key: consentKey,
    received_at: receivedAt,
  };
  const objectHash = hashObjectExcluding(unsigned as unknown as JsonObject, ["signature"]);
  const sig = await signObject("ed25519", "appendReceipt", objectHash, signer.privateKey);
  return { ...unsigned, signature: { alg: "ed25519", key_id: signer.keyId, sig } };
}

export const consentRoutes = new Hono<AppEnv>()
  // GET /v1/consent/{consentKey}?root=&size= — public
  // Build the SMT from revocations whose firstAnchor.size <= anchor size
  // Return { status, holder, bitmap, siblings, onset? }
  .get("/consent/:consentKey", async (c) => {
    const { logStore, registry } = c.get("deps");
    const store = logStore ?? registry?.getStore();
    if (!store) throw new ApiError("internal", "log store not configured");

    const consentKey = c.req.param("consentKey") as Hex;
    const rootParam = c.req.query("root");
    const sizeParam = c.req.query("size");

    if (!rootParam || !sizeParam) {
      throw new ApiError("invalid_request", "missing required parameters: root, size");
    }

    const root = rootParam as Hex;
    const size = Number(sizeParam);

    if (!Number.isInteger(size) || size < 1) {
      throw new ApiError("invalid_request", "size must be a positive integer");
    }

    // Resolve the anchor by (root, size)
    const anchor = store.anchorBy(root, size);
    if (!anchor) {
      throw new ApiError("not_found", `anchor (root: ${root}, size: ${size}) not found`);
    }

    // Build SMT from revocations
    const { SparseTree } = await import("../../../../packages/protocol/src/sparse.ts");
    const revocations = store.revocations();
    const smt = new SparseTree();

    for (const rev of revocations) {
      smt.set(rev.consentKey, rev.value);
    }

    // Check if the consent key has a revocation
    const isRevoked = revocations.some((r) => r.consentKey === consentKey);

    // Get the consent proof
    const { bitmap, siblings } = smt.proof(consentKey);

    // For onset, find the first anchor containing this revocation
    // For now, we'll track this when available (T-004/T-012 will handle this properly)
    let onset: any = undefined;
    if (isRevoked) {
      // Find the first anchor that has a different revocationRoot
      const anchors = store.anchors();
      for (const a of anchors) {
        if (a.size >= size) {
          // This is the first anchor at or after the requested size that contains revocations
          const prevAnchor = anchors.find((x) => x.idx === a.idx - 1);
          if (!prevAnchor || prevAnchor.revocationRoot !== a.revocationRoot) {
            // This is the onset anchor
            onset = {
              root: a.root,
              size: a.size,
              chains: store.anchorChains(a.root, a.size).map((ch) => ({
                chain_id: ch.chainId,
                index: ch.idx,
                block_number: ch.blockNumber,
              })),
            };
            break;
          }
        }
      }
    }

    const response: any = {
      status: isRevoked ? "revoked" : "live",
      holder: "organisation", // TODO: get from consent record stored in episode
      bitmap: bitmap.toString(),
      siblings,
    };

    if (onset) {
      response.onset = onset;
    }

    return c.json(response);
  })
  // POST /v1/consent/{consentKey}/revoke — public, rate-limited 60/min/IP
  .post("/consent/:consentKey/revoke", async (c) => {
    const { rateLimiter, logStore, registry, operator } = c.get("deps");
    const store = logStore ?? registry?.getStore();
    if (!store) throw new ApiError("internal", "log store not configured");
    if (!operator) throw new ApiError("internal", "operator key not configured");

    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "unknown";
    if (!rateLimiter.allow(ip)) {
      throw new ApiError("rate_limited", "too many revoke requests from this IP");
    }

    const body = parseOrThrow(RevokeConsentBody, await getJsonBody(c));
    const consentKey = c.req.param("consentKey") as Hex;

    // Verify and record the revocation
    try {
      await store.revoke(body.record, body.signature);
    } catch (e) {
      throw new ApiError("unauthorized", e instanceof Error ? e.message : "revocation signature verification failed");
    }

    // Sign and return the receipt
    const receivedAt = Math.floor(Date.now() / 1000);
    const receipt = await signRevocationReceipt(operator, consentKey, receivedAt);

    return c.json({
      accepted: true,
      received_at: receivedAt,
      receipt,
    });
  });
