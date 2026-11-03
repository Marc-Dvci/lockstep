#!/usr/bin/env bash
# Start a fresh local NEAR sandbox (nearcore 2.14.0, Linux/WSL). RPC on 127.0.0.1:3030, root account test.near.
# On distributions older than glibc 2.39 (e.g. Ubuntu 22.04) set GLIBC_DIR to an extracted libc6 2.39 tree.
set -euo pipefail
DIR="${SANDBOX_DIR:-$HOME/lockstep-sandbox}"
BIN="$DIR/Linux-x86_64/near-sandbox"
HOME_DIR="${SANDBOX_HOME:-/tmp/lockstep-sandbox}"
run() {
  if [ -n "${GLIBC_DIR:-}" ]; then
    "$GLIBC_DIR/ld-linux-x86-64.so.2" --library-path "$GLIBC_DIR:/lib/x86_64-linux-gnu" "$BIN" "$@"
  else
    "$BIN" "$@"
  fi
}
pkill -f "near-sandbox --home $HOME_DIR" 2>/dev/null || true
sleep 1
rm -rf "$HOME_DIR"
run --home "$HOME_DIR" init >/dev/null 2>&1
cp "$HOME_DIR/validator_key.json" /tmp/lockstep-sandbox-root-key.json
run --home "$HOME_DIR" run --rpc-addr 0.0.0.0:3030
