# Security policy

`@agentbank/exit` is the tool an Agent Bank account owner uses to take their money out when Agent
Bank is unavailable, compromised or gone. A bug here can stop an owner from exiting or, worse, send
their funds somewhere else. We treat every report seriously.

## Reporting a vulnerability

Please report privately through GitHub: **Security → Report a vulnerability** on
`bank-of-an-agent/exit-tool` (a private security advisory). Do not open a public issue for a
vulnerability.

Include what you found, how to reproduce it (an Anvil script is ideal), and the impact you see. We
aim to acknowledge reports within 3 business days and to agree on a disclosure timeline with you.
Agent Bank's bug bounty covers this repository once it is live.

## Supported versions

Only the latest release is supported. This version works on Base Sepolia (84532) and local Anvil
(31337) only; it refuses Ethereum and Base mainnet. Mainnet support unlocks after Agent Bank's
Phase 5 gate.

## Security model

- **No Agent Bank service is involved.** The tool talks only to the JSON-RPC endpoint you give it
  (or, for `web/index.html`, only to your wallet). It needs no API, co-signer, bundler, paymaster or
  indexer. The integration test asserts that the CLI contacts nothing but the RPC.
- **Owner path only.** Every action on the account is a Safe transaction (EIP-712 `SafeTx`) signed by
  the owner and executed through the Safe's native `execTransaction`, which bypasses ERC-4337, the
  Safe7579 adapter and every ERC-7579 module or hook. Steps that anyone may perform (escrow refunds
  after expiry, unlocked vault withdrawals, stream settlements) are plain calls whose contracts can
  only pay the account.
- **CALL only, no refunds.** The tool only produces `operation = CALL` SafeTxs with
  `safeTxGas = baseGas = gasPrice = 0`: the Safe never pays the executor, and a failing inner call
  reverts the whole transaction. Plan files with any other values are rejected.
- **Dry run by default.** Plans are simulated in full (one `eth_simulateV1` block) before anything is
  signed. Dry runs stand in for owner signatures with a simulation-only ERC-1271 stub installed by a
  state override; it never reaches the chain. Execution re-checks every step with `eth_call` right
  before sending it and stops at the first failure.
- **Keys.** `OWNER_PRIVATE_KEY` or an encrypted v3 JSON keystore (passphrase read without echo). Keys
  are never printed, logged or put in error messages, and a keystore is only decrypted to execute.
  `--signer-only` needs no key at all: it writes the EIP-712 payloads for a hardware wallet and accepts
  the signatures back. Signer-only plan files contain no secrets.
- **Mainnet refusal** is based on the chain id the RPC itself reports, not on a flag.

## Known limitations

- **Guards.** A Safe transaction guard can veto any owner transaction, including the one removing it.
  Agent Bank does not install guards; the tool removes any guard first and the simulation shows
  whether the guard allows it.
- **Re-enabling the Safe7579 adapter** after `disable-modules` brings back the ERC-7579 configuration
  stored in it (validators, session keys, executors, hooks). Uninstall those modules first if you ever
  re-enable it.
- **Spend-key floats** can only be pulled back when the spend key's permit allowance to the account
  exists on-chain (ADR 0001). A float above the allowance can only be moved by the agent runtime that
  holds that key.
- **Counterfactual accounts.** If the Safe was never deployed, funds at its address can only be moved
  after deploying it with its original setup parameters, which this tool does not reconstruct.
- **Passkey owners** (contract signers) cannot sign through the CLI; use a wallet that supports them
  with the `--signer-only` payloads, or the Safe's own interfaces.
