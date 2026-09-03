#!/usr/bin/env bash
# T-009: deploys the GraspLog stack (Deploy.s.sol) to one chain and appends
# the machine-parseable CHAIN_<id>_* lines it prints to .env.contracts, plus
# the RPC URL this run used (the one thing the contract itself cannot know).
#
# Usage: deploy-chain.sh <rpc-url> <role:primary|mirror> [etherscan-alias|none] [private-key]
#
# The private key comes from $DEPLOYER_PRIVATE_KEY unless passed as the 4th
# argument (used by deploy:anvil, which has no funded key to source from the
# environment — Anvil's own well-known first key is passed explicitly).
set -euo pipefail

RPC_URL="${1:?usage: deploy-chain.sh <rpc-url> <role> [etherscan-alias|none] [private-key]}"
ROLE="${2:?usage: deploy-chain.sh <rpc-url> <role> [etherscan-alias|none] [private-key]}"
VERIFY_ALIAS="${3:-none}"
PK="${4:-${DEPLOYER_PRIVATE_KEY:-}}"

if [ -z "$PK" ]; then
  echo "error: no private key — set DEPLOYER_PRIVATE_KEY or pass one as the 4th argument" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_CONTRACTS_FILE:-$ROOT_DIR/.env.contracts}"

VERIFY_ARGS=()
case "$VERIFY_ALIAS" in
  fuji)
    [ -n "${SNOWTRACE_API_KEY:-}" ] && VERIFY_ARGS=(--verify --etherscan-api-key "$SNOWTRACE_API_KEY")
    ;;
  sepolia)
    [ -n "${ETHERSCAN_API_KEY:-}" ] && VERIFY_ARGS=(--verify --etherscan-api-key "$ETHERSCAN_API_KEY")
    ;;
  base_sepolia)
    [ -n "${BASESCAN_API_KEY:-}" ] && VERIFY_ARGS=(--verify --etherscan-api-key "$BASESCAN_API_KEY")
    ;;
  none) ;;
  *) echo "warning: unknown etherscan alias \"$VERIFY_ALIAS\" — skipping --verify" >&2 ;;
esac
if [ "$VERIFY_ALIAS" != "none" ] && [ ${#VERIFY_ARGS[@]} -eq 0 ]; then
  echo "note: no API key set for \"$VERIFY_ALIAS\" — deploying without --verify" >&2
fi

cd "$ROOT_DIR/packages/contracts"

OUT="$(ROLE="$ROLE" DEPLOYER_PRIVATE_KEY="$PK" forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC_URL" --broadcast --slow "${VERIFY_ARGS[@]}" 2>&1)"
echo "$OUT"

LINES="$(echo "$OUT" | grep -E '^CHAIN_[0-9]+_(ROLE|LOG|VERIFIER|REGISTRY|FROM_BLOCK)=' || true)"
if [ -z "$LINES" ]; then
  echo "error: deploy output carried no CHAIN_<id>_* lines — not touching $ENV_FILE" >&2
  exit 1
fi
CHAIN_ID="$(echo "$LINES" | head -1 | sed -E 's/^CHAIN_([0-9]+)_.*/\1/')"

{
  echo "$LINES"
  echo "CHAIN_${CHAIN_ID}_RPC=$RPC_URL"
} >> "$ENV_FILE"

echo "appended chain $CHAIN_ID ($ROLE) to $ENV_FILE"
