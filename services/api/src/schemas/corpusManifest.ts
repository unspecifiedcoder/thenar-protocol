/**
 * PLAN §9.2 — CorpusManifest v1. The canonical definition now lives in
 * `packages/protocol/src/schemas.ts` (T-035) — this file re-exports it
 * under the name the rest of `services/api` already imports, and derives
 * the API-only `CorpusManifestInput` (the body `POST /v1/corpora` accepts,
 * which omits the server-computed `corpus_root`/`episode_count`, and, since
 * T-040/D-30, `sources[]` — also "derived by the server from member
 * episodes", PLAN §9.2).
 */
import { CorpusManifestSchema } from "../../../../packages/protocol/src/schemas.ts";

export { CorpusManifestSchema as CorpusManifest } from "../../../../packages/protocol/src/schemas.ts";
export type { CorpusManifest } from "../../../../packages/protocol/src/schemas.ts";

/** Body accepted by `POST /v1/corpora`: `corpus_root`/`episode_count`/`sources` are server-computed. */
export const CorpusManifestInput = CorpusManifestSchema.innerType()
  .omit({ corpus_root: true, episode_count: true, sources: true })
  .strict();
