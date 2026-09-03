/**
 * T-036 — the single commit path shared by the ingest job (one call per
 * `EpisodeRef`, `job.ts`) and `POST /episodes` (the SDK path, `routes/
 * episodes.ts`): validate (T-035), refuse a duplicate `manifestHash` for
 * the org, build the 0x02 leaf per §10.12 (`manifestToEpisode` →
 * `encodeEpisode` → `hashEpisodeLeaf`), append atomically, sign an
 * AppendReceipt.
 *
 * "Atomically" here means what `LogStore.append` already guarantees
 * (BEGIN IMMEDIATE — the leaf row and the tree-node cache commit or roll
 * back together) plus this function's own ordering: every check that can
 * fail runs *before* `store.append`, so a thrown `ApiError` — bad schema,
 * a duplicate, whatever — always means nothing was written (PLAN §12
 * binding rule: "Failure anywhere before append writes nothing").
 */
import type { Hex } from "viem";
import { validateManifest } from "../../../../packages/protocol/src/schemas.ts";
import { manifestHash as computeManifestHash, manifestToEpisode } from "../../../../packages/protocol/src/mapping.ts";
import { encodeEpisode, hashEpisodeLeaf } from "../../../../packages/protocol/src/episode.ts";
import type { ILogStore } from "../../../log/src/store-interface.ts";
import { ApiError } from "../errors.ts";
import { signAppendReceipt, type AppendReceipt, type OperatorSigner } from "./receipt.ts";

export type CommitDeps = {
  store: ILogStore;
  /** unix seconds — the server's own receive time (§27 trap #7: never read from the manifest). */
  now: () => number;
  operator: OperatorSigner;
  /**
   * T-020: fired after a successful append, with the new episode's leaf
   * hash. Not a hard import of `services/verify/src/worker.ts` — the app
   * wires this to `enqueueEpisode`/`processPending` (or nothing, in
   * tests) so this file stays ignorant of checks/ffmpeg/parquet. A
   * failure here is caught and logged, never allowed to turn a successful
   * commit into a failed one — the episode leaf is already durably
   * appended by the time this runs.
   */
  onEpisodeCommitted?: (leafHash: Hex, leafIndex: number) => void | Promise<void>;
};

export type CommitOutcome = {
  leafHash: Hex;
  leafIndex: number;
  submittedAt: number;
  receipt: AppendReceipt;
};

/**
 * `manifest` is `unknown` on purpose — it may not yet be a valid
 * `CaptureManifest` (an ingest-job-built manifest can fail schema
 * validation per episode; a client-submitted one can fail for any reason
 * at all), and `validateManifest` is exactly the boundary that decides.
 */
export async function commitEpisode(
  deps: CommitDeps,
  orgId: string,
  manifest: unknown,
  datasetId: string | null,
  consentKeyHex: Hex | null,
): Promise<CommitOutcome> {
  const validated = validateManifest(manifest);
  if (!validated.ok) {
    throw new ApiError("unprocessable", "manifest failed validation", validated.issues);
  }
  const m = validated.value;
  const mHash = computeManifestHash(m);

  const existing = deps.store.episodeByManifestHash(orgId, mHash);
  if (existing) {
    throw new ApiError("conflict", `an episode with this manifestHash is already logged for org ${orgId}`, {
      leaf_hash: existing.leaf,
      leaf_index: existing.index,
    });
  }

  const submittedAt = deps.now();
  const episode = manifestToEpisode(m, BigInt(submittedAt));
  const preimage = encodeEpisode(episode);
  const leafHash = hashEpisodeLeaf(preimage);

  const leafIndex = deps.store.append(leafHash, {
    preimage,
    manifest: JSON.stringify(m),
    manifestHash: mHash,
    payloadHash: m.payload_hash as Hex,
    datasetId: datasetId ?? undefined,
    orgId,
    consentKey: consentKeyHex ?? undefined,
    submittedAt,
  });

  const receipt = await signAppendReceipt(deps.operator, leafHash, leafIndex, deps.store.size(), submittedAt);

  if (deps.onEpisodeCommitted) {
    try {
      await deps.onEpisodeCommitted(leafHash, leafIndex);
    } catch (err) {
      console.error(`onEpisodeCommitted hook failed for ${leafHash}:`, err);
    }
  }

  return { leafHash, leafIndex, submittedAt, receipt };
}
