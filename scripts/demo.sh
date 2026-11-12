#!/usr/bin/env bash
# Full happy path on testnet. Tx hashes go to evidence/demo-run.json.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node --env-file-if-exists=.env scripts/demo.mjs "$@"
