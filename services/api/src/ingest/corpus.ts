/**
 * T-040 — §9.2/D-30: `CorpusManifest.sources[]` derivation.
 *
 * `sources[]` is "derived by the server from member episodes" (PLAN §9.2)
 * — SORTED bytewise, unique, drawn from the same `source` enum as
 * `CaptureManifest.source` (§9.1, `packages/protocol/src/schemas.ts`
 * `SourceEnum`). This is the single derivation helper; nothing else in
 * `services/api` computes `sources[]` independently.
 *
 * Not yet wired into a route: `POST /v1/corpora` and
 * `POST /v1/corpora/{id}/log` (`routes/corpora.ts`) are still `501`
 * stubs (T-025's corpus logging has not landed), so there is no place
 * that reads member episodes' `source` values yet. Wiring this helper
 * into those routes belongs to T-025 when it implements corpus logging.
 */
import type { Source } from "../../../../packages/protocol/src/schemas.ts";

/**
 * Bytewise-sorted, de-duplicated `sources[]` from a corpus's member
 * episodes' declared `source` values (§27 trap #2 — bytewise, not
 * locale-aware, comparison; every member of `SourceEnum` sorts correctly
 * under plain `<` since none contain non-ASCII bytes).
 */
export function deriveSources(episodeSources: Source[]): Source[] {
  return Array.from(new Set(episodeSources)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
