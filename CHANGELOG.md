# Changelog

All notable changes to `@agentbank/exit` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-11

### Added

- `agentbank-exit` CLI: `inspect`, `withdraw`, `disable-modules`, `refund-escrows`, `cancel-streams`,
  `withdraw-vaults`, `sweep-spend-keys`, `exit` and `submit`, for Agent Bank accounts (Safe v1.4.1 with
  the Safe7579 adapter) on Base Sepolia and Anvil. Ethereum and Base mainnet are refused until the
  Phase 5 gate.
- Owner path only: every account action is an EIP-712 `SafeTx` executed through `execTransaction`;
  public recovery steps (escrow refunds, vault withdrawals, stream settlements) are plain calls that
  can only pay the account.
- Dry run by default with a full `eth_simulateV1` simulation of the plan (no key needed), balance
  deltas and gas estimates; `--execute` with an interactive confirmation (`--yes` for scripts); tx
  hashes and explorer links.
- Keys from `OWNER_PRIVATE_KEY` or an encrypted JSON keystore; `--signer-only` plan files with
  EIP-712 payloads for hardware wallets, `--signature` to hand signatures back, and `submit` through
  any funded relayer key (or printed transactions to send from any wallet). Multi-owner Safes are
  supported through this flow.
- Discovery of escrows, streams and vaults from contract events (adaptive `eth_getLogs` chunking for
  RPCs with range limits) with an enumeration fallback; agent spend keys from their permit approvals.
- `web/index.html`: a single static page with the same inspect, withdraw and exit flow through an
  injected wallet, with a strict Content-Security-Policy (`connect-src 'none'`).
- Shutdown drill on Anvil (`pnpm test:integration`), the Phase 5 gate evidence described in
  `docs/shutdown-drill.md`.
