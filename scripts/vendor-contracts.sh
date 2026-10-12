#!/usr/bin/env bash
# Refresh the Agent Bank contract artifacts vendored for the shutdown drill
# (test/fixtures/agentbank-contracts/) from a Foundry build of the contracts repository.
#
#   scripts/vendor-contracts.sh [--allow-dirty] [path-to-contracts-out]
#
# The out/ directory defaults to $AGENTBANK_CONTRACTS_OUT, then ../contracts/out. Run `forge build`
# there first. Only the ABI and the creation bytecode of the contracts the drill deploys are kept;
# SOURCE records the contracts commit, the compiler settings and the sha256 of every file. The script
# refuses artifacts that were not built from the sources checked out, and (without --allow-dirty) a
# checkout with uncommitted source changes, so the recorded commit is always the one built.
#
# The drill uses these artifacts unless AGENTBANK_CONTRACTS_OUT points at another build, so CI needs
# no access to the contracts repository. Review the diff before committing.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${here}/.." && pwd)"

flags=()
positional=()
for arg in "$@"; do
  case "${arg}" in
    --allow-dirty) flags+=("${arg}") ;;
    -*)
      echo "unknown option: ${arg}" >&2
      exit 2
      ;;
    *) positional+=("${arg}") ;;
  esac
done

out_dir="${positional[0]:-${AGENTBANK_CONTRACTS_OUT:-${repo_root}/../contracts/out}}"
# ${flags[@]+...}: an empty array under `set -u` breaks older bash (macOS ships 3.2).
node "${here}/vendor-contracts.mjs" ${flags[@]+"${flags[@]}"} "${out_dir}" "${repo_root}/test/fixtures/agentbank-contracts"
