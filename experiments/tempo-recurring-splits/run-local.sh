#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
tempo_binary="${1:?Pass the absolute path to Tempo v1.15.0}"
if cast rpc eth_chainId --rpc-url http://127.0.0.1:19545 >/dev/null 2>&1; then
  echo 'Port 19545 is already in use; stop that node before running.' >&2
  exit 1
fi
forge build
chain_dir="$(mktemp -d "${TMPDIR:-/tmp}/mpp-split-proof.XXXXXX")"
"$tempo_binary" node --dev \
  --dev.mnemonic 'test test test test test test test test test test test junk' \
  --dev.block-time 200ms --datadir "$chain_dir" \
  --tempo.bootnodes-endpoint none --disable-discovery --no-persist-peers \
  --http --http.addr 127.0.0.1 --http.port 19545 --http.api eth,net,web3,debug,trace \
  --port 0 --authrpc.port 0 --ipcdisable --log.file.max-files 0 >node.log 2>&1 &
node_pid=$!
trap 'kill "$node_pid" 2>/dev/null || true; wait "$node_pid" 2>/dev/null || true' EXIT
ready=false
for attempt in {1..100}; do
  if cast rpc eth_chainId --rpc-url http://127.0.0.1:19545 >/dev/null 2>&1; then
    ready=true
    break
  fi
  kill -0 "$node_pid"
  sleep 0.1
done
if [[ "$ready" != true ]]; then
  echo 'Node did not become ready; inspect node.log.' >&2
  exit 1
fi
python3 run.py | tee test-output.txt
echo "Temporary chain retained at $chain_dir"
