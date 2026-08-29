/**
 * The chain this deployment anchors to.
 *
 * The only per-chain file in the service, so everything around it stays
 * byte-identical across deployments and `scripts/check-parity.mjs` can hold the
 * two repositories to each other.
 */
export const CHAIN = {
  id: 43113,
  name: "Avalanche Fuji",
  nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.avax-test.network/ext/bc/C/rpc"] } },
} as const;
