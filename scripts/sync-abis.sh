#!/usr/bin/env bash
# Refresh the vendored Agent Bank contract ABIs (src/core/abis/generated/agentbank.ts) from the
# contracts repository.
#
#   scripts/sync-abis.sh [path-to-contracts-repo]     (default: ../contracts)
#
# Source of truth, in order of preference:
#   1. <contracts>/abis/<Name>.json        (exported ABI files, once the contracts repo publishes them)
#   2. <contracts>/out/<Name>.sol/<Name>.json  (Foundry build artifacts; run `forge build` there first)
#
# The exit tool ships its own copy of the ABIs on purpose: it must keep working when Agent Bank (and
# its repositories) are gone. Review the diff before committing: an ABI change in a deployed
# contract is a breaking change for owners.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${here}/.." && pwd)"
contracts_dir="${1:-${AGENTBANK_CONTRACTS_DIR:-${repo_root}/../contracts}}"

if [[ ! -d "${contracts_dir}" ]]; then
  echo "error: contracts repository not found at ${contracts_dir}" >&2
  echo "usage: scripts/sync-abis.sh [path-to-contracts-repo]" >&2
  exit 1
fi

node "${here}/gen-abis.mjs" "${contracts_dir}" "${repo_root}/src/core/abis/generated/agentbank.ts"
