#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
tempo_binary="${1:?Absolute path to Tempo v1.15.0 required}"
chain_spec="$(pwd)/source/dev-t11-control-v1.15.0.json"
if cast rpc eth_chainId --rpc-url http://127.0.0.1:19547 >/dev/null 2>&1; then echo 'Port 19547 is occupied' >&2; exit 1; fi
chain_dir="$(mktemp -d "${TMPDIR:-/tmp}/subscription-split-proof.XXXXXX")"
"$tempo_binary" node --chain "$chain_spec" --dev \
  --dev.mnemonic 'test test test test test test test test test test test junk' \
  --dev.block-time 200ms --datadir "$chain_dir" \
  --tempo.bootnodes-endpoint none --disable-discovery --no-persist-peers \
  --http --http.addr 127.0.0.1 --http.port 19547 --http.api eth,net,web3,debug,trace \
  --port 0 --authrpc.port 0 --ipcdisable --log.file.max-files 0 >node.log 2>&1 &
node_pid=$!
trap 'kill "$node_pid" 2>/dev/null || true; wait "$node_pid" 2>/dev/null || true' EXIT
ready=false
for attempt in {1..100}; do
  if cast rpc eth_chainId --rpc-url http://127.0.0.1:19547 >/dev/null 2>&1; then ready=true; break; fi
  kill -0 "$node_pid"
  sleep 0.1
done
if [[ "$ready" != true ]]; then echo 'Node not ready; inspect node.log' >&2; exit 1; fi
node --import tsx chain.ts | tee chain-test-output.txt
