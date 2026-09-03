import { Hono } from "hono";
import type { Hex } from "viem";
import type { AppEnv } from "../app.ts";
import { ApiError } from "../errors.ts";

export const proofRoutes = new Hono<AppEnv>()
  // GET /v1/proofs/inclusion?leaf=&root=&size= — public
  // Resolve anchor by (root, size); 404 if unknown; look up leaf's index;
  // 404 "leaf N is not covered by anchor (size M)" if index >= size;
  // return { index, size, root, proof }
  .get("/proofs/inclusion", (c) => {
    const { logStore, registry } = c.get("deps");
    const store = logStore ?? registry?.getStore();
    if (!store) throw new ApiError("internal", "log store not configured");

    const leafParam = c.req.query("leaf");
    const rootParam = c.req.query("root");
    const sizeParam = c.req.query("size");

    if (!leafParam || !rootParam || !sizeParam) {
      throw new ApiError("invalid_request", "missing required parameters: leaf, root, size");
    }

    const leaf = leafParam as Hex;
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

    // Find the leaf's index in the log
    const leaves = store.leaves();
    const leafIndex = leaves.indexOf(leaf);
    if (leafIndex === -1) {
      throw new ApiError("not_found", `leaf ${leaf} not found in the log`);
    }

    // Check if the leaf is covered by this anchor
    if (leafIndex >= size) {
      throw new ApiError("not_found", `leaf ${leafIndex} is not covered by anchor (size ${size})`);
    }

    // Compute the inclusion proof
    const proof = store.inclusionProof(leafIndex, size);

    return c.json({ index: leafIndex, size, root, proof });
  })
  // GET /v1/proofs/consistency?from_size=&to_size= — public
  // Both must be anchored sizes; from_size > to_size -> 400;
  // equal -> { proof: [] }
  .get("/proofs/consistency", (c) => {
    const { logStore, registry } = c.get("deps");
    const store = logStore ?? registry?.getStore();
    if (!store) throw new ApiError("internal", "log store not configured");

    const fromSizeParam = c.req.query("from_size");
    const toSizeParam = c.req.query("to_size");

    if (!fromSizeParam || !toSizeParam) {
      throw new ApiError("invalid_request", "missing required parameters: from_size, to_size");
    }

    const fromSize = Number(fromSizeParam);
    const toSize = Number(toSizeParam);

    if (!Number.isInteger(fromSize) || fromSize < 1 || !Number.isInteger(toSize) || toSize < 1) {
      throw new ApiError("invalid_request", "from_size and to_size must be positive integers");
    }

    if (fromSize > toSize) {
      throw new ApiError("invalid_request", "from_size must be <= to_size");
    }

    // Check that both sizes are anchored
    const anchors = store.anchors();
    const fromAnchored = anchors.some((a) => a.size === fromSize);
    const toAnchored = anchors.some((a) => a.size === toSize);

    if (!fromAnchored) {
      throw new ApiError("not_found", `size ${fromSize} is not anchored`);
    }
    if (!toAnchored) {
      throw new ApiError("not_found", `size ${toSize} is not anchored`);
    }

    // Equal sizes -> empty proof
    if (fromSize === toSize) {
      return c.json({ proof: [] });
    }

    // Compute consistency proof
    const proof = store.consistencyProof(fromSize, toSize);

    return c.json({ proof });
  });
