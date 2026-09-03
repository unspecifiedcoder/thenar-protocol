import { Hono } from "hono";
import type { Hex } from "viem";
import type { AppEnv } from "../app.ts";
import { notImplemented } from "../app.ts";
import { ApiError } from "../errors.ts";
import { decodeCursor, paginated, parseLimit } from "../pagination.ts";
import { isUnreachable } from "../chain.ts";

export const anchorRoutes = new Hono<AppEnv>()
  // GET /v1/anchors — public. List of Anchor (PLAN §8: root, size, prevRoot,
  // revocationRoot, chains[]) — one entry per (root, size) this log has ever
  // anchored, drawn from the store, each chain locator in `chains[]`
  // augmented with a live on-chain confirmation when that chain is reachable
  // (D-29: never present a stale value as live without saying so, I-11:
  // never fabricate one when it is not reachable).
  .get("/anchors", async (c) => {
    const { logStore, graspReader } = c.get("deps");
    if (!logStore) throw new ApiError("internal", "log store not configured");

    const limit = parseLimit(c.req.query("limit"));
    const cursorRaw = c.req.query("cursor");
    const after = cursorRaw ? Number(decodeCursor(cursorRaw).id) : -1;

    const all = logStore.anchors().filter((a) => a.idx > after);
    const slice = all.slice(0, limit);
    const nextCursor = all.length > limit ? { k: "idx", id: String(slice[slice.length - 1].idx) } : null;

    const items = [];
    for (const a of slice) {
      // `prevRoot` is not stored off-chain (only the chain itself knows the
      // anchor before this one) — fill it from a live read when reachable,
      // `null` otherwise; never guessed.
      const live = graspReader ? await graspReader.anchorAt(a.idx) : undefined;
      const prevRoot: Hex | null = live && !isUnreachable(live) ? live.prevRoot : null;

      const chainRows = logStore.anchorChains(a.root, a.size);
      const chains = [];
      for (const row of chainRows) {
        const onChain = graspReader ? await graspReader.anchorAtOnChain(row.chainId, row.idx) : undefined;
        const liveField = !onChain
          ? { unreachable: true }
          : isUnreachable(onChain)
            ? { unreachable: true }
            : { confirmed: onChain.root === a.root && onChain.size === a.size, stale_at: onChain.stale_at };
        chains.push({
          chain_id: row.chainId, index: row.idx, at: row.at,
          block_number: row.blockNumber, tx_hash: row.txHash, live: liveField,
        });
      }

      items.push({
        root: a.root, size: a.size, prev_root: prevRoot, revocation_root: a.revocationRoot,
        chains,
      });
    }

    return c.json(paginated(items, nextCursor));
  })
  // GET /v1/anchors/audit — public
  // Per chain from .env.contracts, run auditAnchors
  .get("/anchors/audit", async (c) => {
    const { logStore, registry } = c.get("deps");
    const store = logStore ?? registry?.getStore();
    if (!store) throw new ApiError("internal", "log store not configured");

    // If no chains configured, return empty list
    const anchors = store.anchors();
    if (anchors.length === 0) {
      return c.json({
        items: [],
        note: "no anchors recorded",
      });
    }

    // Load chains from .env.contracts
    const { loadChains } = await import("../../log/src/chains.ts");
    let targets: any[] = [];
    try {
      targets = loadChains();
    } catch {
      return c.json({
        items: [],
        note: "no chains configured",
      });
    }

    const { auditAnchors, defaultReader } = await import("../../log/src/anchorer.ts");
    const items = [];

    for (const target of targets) {
      try {
        const audits = await auditAnchors(logStore, target, defaultReader(target));
        items.push({
          chain_id: target.id,
          chain_name: target.name,
          audits,
        });
      } catch (e) {
        items.push({
          chain_id: target.id,
          chain_name: target.name,
          error: e instanceof Error ? e.message : "unknown error",
        });
      }
    }

    return c.json({ items });
  });
