import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { ApiError } from "../errors.ts";
import { verifyWalletSig } from "../walletSig.ts";

const DOWNLOAD_URL_TTL_S = 15 * 60;

export const licenceRoutes = new Hono<AppEnv>()
  // GET /v1/licences/{receiptId}/download — wallet signature header
  .get("/licences/:receiptId/download", async (c) => {
    const { nowMinute, chainReader, bundleStore } = c.get("deps");
    const receiptId = c.req.param("receiptId");
    const address = await verifyWalletSig(c.req.header("X-Wallet-Sig"), receiptId, nowMinute());

    const receipt = await chainReader.receiptAt(receiptId);
    if (!receipt) throw new ApiError("not_found", `no receipt ${receiptId}`);

    // Buyer comparison is case-insensitive hex (both are EIP-55/lowercase-agnostic addresses).
    if (receipt.buyer.toLowerCase() !== address.toLowerCase()) {
      throw new ApiError("forbidden", "signer is not this receipt's buyer");
    }

    const corpusFiles = await chainReader.corpusEpisodes(receipt.corpusId);
    const expiresAt = Math.floor(Date.now() / 1000) + DOWNLOAD_URL_TTL_S;

    const files = [];
    for (const file of corpusFiles) {
      if (!(await bundleStore.has(file.hash))) {
        // I-11 / §27 trap 18: a missing delivered object is a hard failure
        // naming the hash, never a substitute or a partial response.
        throw new ApiError("internal", `stored object missing for hash ${file.hash}`);
      }
      const url = await bundleStore.signedGetUrl(file.hash, DOWNLOAD_URL_TTL_S);
      files.push({ path: file.path, hash: file.hash, bytes: file.bytes, url, expires_at: expiresAt });
    }

    return c.json({ corpus_id: receipt.corpusId, files });
  });
