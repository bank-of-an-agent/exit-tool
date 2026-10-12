# agentbank-exit

Withdraw everything from an Agent Bank account **without Agent Bank**: no API, no co-signer, no
account with us. Only an RPC URL and your owner key.

[![CI](https://github.com/bank-of-an-agent/exit-tool/actions/workflows/ci.yml/badge.svg)](https://github.com/bank-of-an-agent/exit-tool/actions/workflows/ci.yml)
![Node 22](https://img.shields.io/badge/node-22-339933)
![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)

> [!IMPORTANT]
> Testnet only for now (Base Sepolia and Anvil); mainnet chain ids are refused until Agent Bank's
> mainnet launch gate. Pre-release software: read the plan it prints before you execute it.

## Why it exists

Every Agent Bank agent account is a Safe smart account whose owner key belongs to you. Agent Bank
can refuse a payment but can never move your funds, and if Agent Bank goes away, you still hold
the key. This tool turns that guarantee into a command: it uses the Safe's native
`execTransaction` path, signed by the owner, which no Agent Bank module, hook or service can
block.

## What it can recover

- USDC and ETH in the smart account (and other ERC-20s with `--extra-token`)
- Escrows you paid into, once expired (refunded to you)
- Streams you fund (cancelled: accrued amounts go to the payee, the rest back to you)
- Time-locked vaults (immediately once unlocked; earlier with your signature)
- The agent's x402 spend-key float, through the permit the spend key signed at setup
- Fund shares from the treasury sweep (moved, not redeemed)

It can also revoke every Agent Bank power over the account (`disable-modules`: session keys,
policy hook, executors and the ERC-7579 adapter) while keeping your guardian recovery module, and
re-align the owner validator after a guardian recovery (`sync-owner`).

## Install

```bash
git clone https://github.com/bank-of-an-agent/exit-tool.git
cd exit-tool
pnpm install && pnpm build
alias agentbank-exit="node $PWD/dist/cli.js"
```

Requires Node.js 22.

## Usage

```bash
# 1. See what's there and what's recoverable now or later (read-only).
agentbank-exit inspect --account 0xYourSafe --rpc-url https://sepolia.base.org --deployments agentbank.json

# 2. Plan the full exit and simulate every step (dry run, the default).
agentbank-exit exit --account 0xYourSafe --to 0xYourWallet --deployments agentbank.json

# 3. Execute: sign with your owner key and confirm.
OWNER_PRIVATE_KEY=0x… agentbank-exit exit --account 0xYourSafe --to 0xYourWallet --deployments agentbank.json --execute
#    or an encrypted keystore: --keystore owner.json (passphrase prompted, never echoed)
```

With a hardware wallet, add `--signer-only`: the tool writes each Safe transaction as EIP-712
JSON, you sign it on the device (for example `cast wallet sign --ledger --data --from-file
step-01-SafeTx.json`), and `submit --plan-file plan.json --signature … --execute` sends it from
any funded address. Locked positions can be collected later by running `exit` again on the dates
`inspect` lists.

| Command                                                                   | What it does                                                                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `inspect`                                                                 | Owners, threshold, modules, guard, balances, escrows, streams, vaults, spend-key floats, recovery module, findings |
| `withdraw`                                                                | Send USDC, ETH or an ERC-20 (`--amount all` or a decimal) to `--to`                                                |
| `refund-escrows`, `cancel-streams`, `withdraw-vaults`, `sweep-spend-keys` | Recover each kind of position                                                                                      |
| `disable-modules`                                                         | Remove every module (keeps the recovery module unless `--include-recovery`) and reset the fallback handler         |
| `sync-owner`                                                              | After a guardian recovery, make the owner validator's owners match the Safe's                                      |
| `exit`                                                                    | All of the above, planned in a safe order                                                                          |
| `submit`                                                                  | Send a plan signed elsewhere (`--signer-only`)                                                                     |

Common flags: `--account`, `--rpc-url`, `--chain base-sepolia|anvil`, `--deployments` (or
`--usdc/--escrow/--streams/--vaults`), `--json`, `--execute`, `--yes`. Run any command with
`--help` for the rest.

A static page, [`web/index.html`](web), offers inspect, withdraw, exit and the validator sync with
an injected wallet, for owners who prefer not to use a terminal. It talks only to your RPC.

## Shutdown drill

[`docs/shutdown-drill.md`](docs/shutdown-drill.md) records the Phase 5 evidence: on a local Anvil
chain with the real Safe and Agent Bank contracts and every Agent Bank service absent, `exit`
returned 9,808.59 USDC, 2 ETH and the fund shares to the owner's wallet and left the account with
no modules, guard or adapter; a second run 31 days later collected the remaining 128.59 USDC as
positions unlocked. A Base Sepolia fork test covers guardian recovery followed by `sync-owner`.

## Development

```bash
pnpm test                      # unit tests
pnpm test:integration          # the Anvil shutdown drill (needs Foundry's anvil)
RUN_FORK_TESTS=1 pnpm test:integration   # plus the Base Sepolia fork tests
pnpm drill:demo                # narrated drill for a live demo
```

## Security

Keys are read from `OWNER_PRIVATE_KEY`, an encrypted keystore or a hardware wallet, and are never
printed or logged. Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
