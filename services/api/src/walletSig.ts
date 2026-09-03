/**
 * `GET /v1/licences/{id}/download` — PLAN §12 wallet-signature header.
 *
 * Header: `X-Wallet-Sig: <address>:<unixMinute>:<hexSignature>`. The
 * signed message is `"THENAR download receipt <id> at <unixMinute>"`,
 * EIP-191 (`verifyMessage`), and `unixMinute` must fall within ±2 minutes
 * of the current minute so a captured header can't be replayed forever.
 */
import { isAddress, verifyMessage } from "viem";
import { ApiError } from "./errors.ts";

const WINDOW_MINUTES = 2;

export type WalletSigHeader = { address: `0x${string}`; unixMinute: number; signature: `0x${string}` };

export function parseWalletSigHeader(header: string | undefined | null): WalletSigHeader {
  if (!header) throw new ApiError("unauthorized", "missing X-Wallet-Sig header");
  const parts = header.split(":");
  if (parts.length !== 3) throw new ApiError("unauthorized", "malformed X-Wallet-Sig header");
  const [address, unixMinuteRaw, signature] = parts;
  if (!isAddress(address)) throw new ApiError("unauthorized", "malformed X-Wallet-Sig address");
  const unixMinute = Number(unixMinuteRaw);
  if (!Number.isInteger(unixMinute) || unixMinute < 0) {
    throw new ApiError("unauthorized", "malformed X-Wallet-Sig timestamp");
  }
  if (!/^0x[0-9a-fA-F]+$/.test(signature)) throw new ApiError("unauthorized", "malformed X-Wallet-Sig signature");
  return { address, unixMinute, signature: signature as `0x${string}` };
}

export function downloadMessage(receiptId: string, unixMinute: number): string {
  return `THENAR download receipt ${receiptId} at ${unixMinute}`;
}

/** Verifies the header for `receiptId` against the current time. Throws `unauthorized` on any failure. */
export async function verifyWalletSig(
  header: string | undefined | null,
  receiptId: string,
  now = Math.floor(Date.now() / 60_000),
): Promise<`0x${string}`> {
  const { address, unixMinute, signature } = parseWalletSigHeader(header);
  if (Math.abs(now - unixMinute) > WINDOW_MINUTES) {
    throw new ApiError("unauthorized", "X-Wallet-Sig timestamp is outside the ±2 minute window");
  }
  // `verifyMessage` returns `false` for a signature that recovers cleanly to
  // the wrong address, but can *throw* for one that fails to decode at all
  // (e.g. a tampered byte that no longer encodes a valid curve point) — both
  // are "signature does not match" per this function's contract, so both
  // become the same `unauthorized`, never a bare 500.
  let ok: boolean;
  try {
    ok = await verifyMessage({ address, message: downloadMessage(receiptId, unixMinute), signature });
  } catch {
    ok = false;
  }
  if (!ok) throw new ApiError("unauthorized", "X-Wallet-Sig signature does not match");
  return address;
}
