# Shutdown drill

Phase 5 of the Agent Bank plan requires the "owner exit tool published and tested against a
simulated bank shutdown", and the gate requires the exit tool to be verified. This drill is that
test. It backs threat T6 of the threat model: Agent Bank going down (outage, insider or shutdown)
must never stop an owner from getting their money out.

## Result

**Passed.** Run on 2026-10-11 with `@agentbank/exit` 0.1.0, Anvil 1.8.4 and the Agent Bank
contracts at commit `2c44a19`. All 11 drill tests passed in about 9 seconds.

| Check                    | Result                                                                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Positions found          | 4 escrows, 3 streams, 3 vaults and 2 spend keys, found both from contract events and by enumerating the contracts                                                                                                                                                               |
| Network access           | The CLI contacted only the RPC URL, with no Agent Bank API, co-signer, bundler, paymaster or indexer (asserted on the inspect, dry-run and exit runs)                                                                                                                           |
| Dry run                  | 11 steps simulated in one `eth_simulateV1` block without the owner key; chain state unchanged afterwards                                                                                                                                                                        |
| Exit, phase 1            | 12 transactions sent with the owner key alone. The destination received 9,793.59 USDC, 2 ETH and all the treasury-fund shares. The account ends empty with no modules, no guard, and the plain fallback handler. The bank's module can no longer move funds                     |
| Exit, phase 2 (+31 days) | The owner used a hardware-wallet flow (`--signer-only`, then `submit` through an unrelated relayer key) and recovered 128.59 more USDC. The escrow and vault contracts hold nothing of the account. The streams contract holds only the 20 USDC owed to the frozen payee        |
| Other paths              | Hardware-wallet `EarlyWithdrawal` and `SafeTx` signatures; a 2-of-3 Safe (one signature refused, two accepted in any order); encrypted keystore (wrong passphrase refused, key never printed); a restrictive RPC with no `eth_simulateV1` and `eth_getLogs` capped at 10 blocks |

Every unit of value that the account could recover was recovered. Value the account could not
recover yet was reported with the date it becomes available, then recovered once that date
passed. What is left belongs to someone else: the frozen payee's earned 20 USDC, and a spend-key
float that has no allowance to the account.

## How to run it

```sh
pnpm install
pnpm test:integration          # the drill (needs anvil; reads ../contracts/out)
pnpm drill:demo                # the same scenario on a long-running Anvil, to try the CLI and web page by hand
```

The drill needs:

- `anvil`, found through `$ANVIL_BIN`, then `PATH`, then `nix shell nixpkgs#foundry -c anvil`.
- The Agent Bank Foundry artifacts, from `../contracts/out` or `$AGENTBANK_CONTRACTS_OUT`.

If the artifacts are missing, the escrow, stream and vault parts are skipped with a clear message,
and a plain ERC-20 stands in for USDC. Set `REQUIRE_AGENTBANK_CONTRACTS=1` to turn that skip into a
failure. In CI, the `Shutdown drill (Anvil)` job checks out and builds the contracts repository
when it can. Run it through `workflow_dispatch` with `require_contracts` to get gate evidence.

## The scenario

Each Anvil instance starts on a random port. The scenario builds an account that looks like a real
Agent Bank account:

- **Safe infrastructure.** The canonical Safe v1.4.1 contracts are installed at their canonical
  addresses: Safe, SafeL2, SafeProxyFactory, CompatibilityFallbackHandler and MultiSendCallOnly. Their
  code hashes match Base Sepolia, and the drill asserts this.
- **The account.** A 1-of-1 SafeL2 proxy owned by Anvil development key #1. The Safe7579 adapter
  address is both a Safe module and the fallback handler. A second module, an EOA, stands in for the
  bank's execution powers: the drill runs every agent action through it, the way the adapter runs
  agent sessions. A `DebugTransactionGuard` is set as the transaction guard.
- **Funds and activity.** 2 ETH and 10,000 MockUSDC, then agent activity:

| Position            | Setup                                                                                  | State when the bank shuts down (day 2)    |
| ------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------- |
| Escrow 1            | 100 USDC to a payee, expires after 1 h                                                 | expired: anyone can refund it             |
| Escrow 2            | 50 USDC, expires after 30 days                                                         | locked                                    |
| Escrow 3            | 25 USDC with an arbiter, disputed by the payee                                         | disputed: refundable 30 days after expiry |
| Escrow 4            | 10 USDC, released to the payee                                                         | closed (the payee's money)                |
| Stream 1            | 1,000 USDC at 0.001 USDC/s                                                             | ~172.8 USDC earned by the payee           |
| Stream 2            | 200 USDC at 10 USDC/day to a payee that USDC later freezes                             | 20 USDC earned                            |
| Stream 3            | incoming: another agent streams 100 USDC to the account                                | ~86.4 USDC owed to the account            |
| Vault 1             | 300 USDC, unlocks after 1 day                                                          | unlocked                                  |
| Vault 2             | 500 USDC, locked for a year, owner = owner key                                         | locked; early withdrawal possible         |
| Vault 3             | 40 USDC, locked 20 days, owner = another key                                           | locked; not the owner's to unlock early   |
| Spend key 1         | 25 USDC float, permit-style allowance to the account                                   | recoverable                               |
| Spend key 2         | 5 USDC float, no allowance                                                             | not recoverable by the owner              |
| Treasury automation | TopUpExecutor and SweepExecutor installed; 60 USDC deposited into a mock treasury fund | fund shares held by the account           |

**The shutdown.** Two days pass. Agent Bank's pause guardian pauses AgentEscrow, PaymentStreams
and TimeLockVaults, which stops inflows only. USDC freezes the payee of stream 2. No API,
co-signer, bundler, paymaster or indexer exists. The bank's module is still enabled, and the drill
asserts that it could still move funds at that point.

## The exit

The owner runs `agentbank-exit` with the RPC URL, the account, the deployments file and the owner
key.

1. `inspect` reports the Safe's configuration, every position, and the findings: the two modules,
   the 7579 fallback, the guard, the executors, and the vault owned by another key. It then splits
   what can be recovered now from what cannot yet. It does this once from events and once by
   enumeration.
2. `exit --to <destination>` with no key is a dry run. It prints 11 steps, each with its call,
   calldata, SafeTx nonce and hash, and simulates all of them in one block. It also prints the
   balance changes and the gas the owner's key will pay.
3. `exit … --execute --yes` with the owner key sends these steps, each checked with `eth_call`
   right before it is sent:
   1. Remove the transaction guard. A guard can veto owner transactions, so this goes alone and
      first.
   2. In one Safe transaction, disable both modules (the adapter and the bank's module) and reset
      the fallback handler to the plain CompatibilityFallbackHandler. The batch is a DELEGATECALL to
      the canonical MultiSendCallOnly, after its code hash is checked. Nothing can act between the
      removals.
   3. Cancel streams 1 and 2. Stream 2's payee is frozen, so the payee's share is deferred, but the
      refund to the account still goes through.
   4. Refund escrow 1. Settle the incoming stream 3.
   5. Return vault 1. Early-withdraw vault 2, using an EIP-712 `EarlyWithdrawal` signed by the owner
      key.
   6. Pull spend key 1's float back with `transferFrom`.
   7. Withdraw all USDC, the fund shares (`--extra-token`) and all ETH to the destination. Amounts
      are read when each step runs.
4. On day 33, the locks have expired. The owner signs on a "hardware wallet" (Anvil's
   `eth_signTypedData_v4` over the exported JSON) and an unrelated relayer key submits. Round 1
   needs no signatures: it refunds escrows 2 and 3, settles stream 3, and returns vault 3 (all
   public calls). Round 2 signs the final USDC withdrawal.

The drill asserts conservation exactly. The destination's USDC equals what was minted to the
account, minus what payees earned or were paid, minus the positions still locked, plus what the
incoming stream paid, plus the spend-key float. Stream amounts come from the transaction receipts.

Output of the dry run (abridged):

```
 1. Remove transaction guard 0xe7f1…0512
 2. Revoke every agent and bank power in one transaction (3 changes)
 3. Cancel stream #1 to 0x90F7…b906
 4. Cancel stream #2 to 0x15d3…6A65
 5. Refund escrow #1 (expired) to the account
 6. Collect what incoming stream #3 owes the account
 7. Return unlocked vault #1 to the account
 8. Early-withdraw locked vault #2 to the account (owner-signed)
 9. Pull USDC float of spend key 0x9965…A4dc back into the account
10. Withdraw all USDC to 0x1310…41AA
11. Withdraw all ETH to 0x1310…41AA
Simulated result: the account goes from 7775 USDC → 0 USDC; 2 ETH → 0 ETH
                  the destination receives +9793.5935 USDC, +2 ETH
```

The web page (`web/index.html`) was driven through the same scenario in a browser, using a test
wallet that forwards to Anvil (a copy of the page with a relaxed CSP so the shim could reach Anvil).
It ran inspect, which showed the executor findings, and previewed the 11-step exit. It then sent all
11 transactions: the wallet was asked for 8 typed-data signatures (7 SafeTxs and 1
`EarlyWithdrawal`) and 11 transactions. The account ended empty with no modules. The unmodified page
also loaded under its own strict CSP with no console errors: script and style hashes matched, and
`connect-src` was `'none'`. This was a manual check, not part of the automated drill; the CSP hashes
are checked in CI.

The `--signer-only` payload files were also signed with `cast wallet sign --data --from-file`, the
command the CLI prints for Ledger users (here with a private key instead of a device). `submit`
accepted the signature and simulated the resulting transaction.

## What the drill does not cover

- **The Safe7579 adapter's own bytecode** is not executed. Its address is registered as a module
  and fallback handler, as on Base Sepolia, and an EOA module stands in for the execution powers
  the adapter gives sessions and executors. The exit path never calls the adapter: it uses
  `execTransaction` and disables the adapter.
- **Base Sepolia itself.** Agent Bank's contracts are not deployed there yet; the contracts repo
  only has dry-run CREATE2 predictions. Run the tool read-only against Base Sepolia once
  `deployments/84532.json` exists. The tool has been run read-only (`inspect` and a dry-run `exit`)
  against an existing Safe v1.4.1 on Base Sepolia through the public RPC.
- **Real USDC** (FiatToken v2.2) is replaced by MockUSDC, which mirrors its relevant behaviour,
  including the blacklist.
- **Mainnet** is refused by design until after this gate.
- Passkey (contract) owners, counterfactual (never deployed) accounts, and guards that refuse their
  own removal are out of scope. `SECURITY.md` explains why.
