import { getAddress, isAddressEqual, keccak256, type Address, type PublicClient } from "viem";
import { agentPolicyHookAbi, erc20Abi, sweepExecutorAbi, topUpExecutorAbi } from "./abis/index";
import { formatTimestamp } from "./describe";
import { formatAmount } from "./amounts";
import type { ChainConfig } from "./chains";
import {
  COMPATIBILITY_FALLBACK_HANDLER_CODEHASH,
  SAFE7579_ADAPTER,
  SAFE_V141,
  ZERO_ADDRESS,
} from "./constants";
import type { AgentBankContracts } from "./deployments";
import {
  discoverPositionIds,
  discoverSpendKeys,
  findDeploymentBlock,
  type PositionIds,
  type SpendKeyDiscovery,
} from "./discovery";
import { ExitToolError } from "./errors";
import { isCanonicalMultiSendCallOnly, MULTISEND_CALL_ONLY } from "./multisend";
import {
  readEscrows,
  readSpendKeys,
  readStreams,
  readTokenInfo,
  readVaults,
  type EscrowPosition,
  type SpendKeyFloat,
  type StreamPosition,
  type TokenInfo,
  type VaultPosition,
} from "./positions";
import { readRecoveryState, type RecoveryState } from "./recovery";
import { readSafeState, type SafeState } from "./safe";

export interface InspectOptions {
  chain: ChainConfig;
  account: Address;
  /** USDC (or the chain's stablecoin under test). */
  usdc?: Address;
  /** The plain fallback handler `disable-modules` restores. */
  compatibilityFallbackHandler: Address;
  contracts: AgentBankContracts;
  /** Earliest Agent Bank block from the deployments file, if known. */
  fromBlock?: bigint;
  /** The owner key that will sign, if known (for owner and vault-owner checks). */
  signer?: Address;
  /** Spend keys given explicitly (`--spend-key`). */
  spendKeys?: readonly Address[];
  /** Skip escrow/stream/vault/spend-key discovery (commands that only touch the Safe itself). */
  positions?: boolean;
  discovery?: { mode?: "auto" | "events" | "enumerate"; maxLogRequests?: number };
}

export type FindingSeverity = "danger" | "warning" | "info";

/** Something about the account's configuration an owner should know before exiting. */
export interface Finding {
  severity: FindingSeverity;
  code: string;
  message: string;
}

export interface AccountReport {
  chain: { id: number; name: string; label: string };
  block: { number: bigint; timestamp: bigint };
  account: Address;
  safe: SafeState;
  /** Owner key that will sign (if known) and whether it is an owner of the Safe. */
  signer?: { address: Address; isOwner: boolean };
  eth: bigint;
  usdc?: TokenInfo;
  /** Metadata of every token involved (USDC and position tokens), keyed by lowercase address. */
  tokens: Record<string, TokenInfo>;
  /** The account's balance of every token in `tokens`, keyed by lowercase address. */
  balances: Record<string, bigint>;
  agentBankConfigured: boolean;
  contracts: AgentBankContracts;
  escrows: EscrowPosition[];
  streams: StreamPosition[];
  vaults: VaultPosition[];
  spendKeys: SpendKeyFloat[];
  discovery?: {
    positions: PositionIds;
    spendKeys?: SpendKeyDiscovery;
    scanFromBlock: bigint;
    accountDeployedAt?: bigint;
  };
  findings: Finding[];
  /** Human labels for known addresses (lowercase keys). */
  labels: Record<string, string>;
  /**
   * The plain fallback handler the revoke installs: the canonical CompatibilityFallbackHandler v1.4.1
   * when its code hash is verified on this chain, otherwise address(0) (no handler, which is safe).
   */
  compatibilityFallbackHandler: Address;
  /** The canonical MultiSendCallOnly, when its code was verified on this chain (enables the atomic revoke). */
  multiSendCallOnly?: Address;
  /** Treasury-sweep fund shares held by the account (SweepExecutor configuration), if any. */
  fundShares?: { fund: TokenInfo; balance: bigint };
  /** Guardian recovery (Candide SocialRecoveryModule), when enabled. Kept unless --include-recovery. */
  recovery?: RecoveryState;
}

const KNOWN_SINGLETONS: Record<string, string> = {
  [SAFE_V141.safe.toLowerCase()]: "Safe v1.4.1",
  [SAFE_V141.safeL2.toLowerCase()]: "SafeL2 v1.4.1",
};

/** Labels for well-known addresses. */
export function knownLabels(
  options: Pick<InspectOptions, "contracts" | "usdc" | "compatibilityFallbackHandler">,
) {
  const labels: Record<string, string> = {
    [SAFE7579_ADAPTER.toLowerCase()]:
      "Safe7579 adapter (ERC-7579 modules: agent session keys, policy hook, executors)",
    [SAFE_V141.compatibilityFallbackHandler.toLowerCase()]: "CompatibilityFallbackHandler v1.4.1",
    ...KNOWN_SINGLETONS,
  };
  const c = options.contracts;
  if (c.escrow) labels[c.escrow.toLowerCase()] = "Agent Bank AgentEscrow";
  if (c.streams) labels[c.streams.toLowerCase()] = "Agent Bank PaymentStreams";
  if (c.vaults) labels[c.vaults.toLowerCase()] = "Agent Bank TimeLockVaults";
  if (c.topUpExecutor) labels[c.topUpExecutor.toLowerCase()] = "Agent Bank TopUpExecutor";
  if (c.sweepExecutor) labels[c.sweepExecutor.toLowerCase()] = "Agent Bank SweepExecutor";
  if (c.policyHook) labels[c.policyHook.toLowerCase()] = "Agent Bank AgentPolicyHook";
  if (options.usdc) labels[options.usdc.toLowerCase()] = "USDC";
  return labels;
}

function safeFindings(
  safe: SafeState,
  labels: Record<string, string>,
  compatibilityFallbackHandler: Address,
  signer: Address | undefined,
  recovery: RecoveryState | undefined,
  now: bigint,
): Finding[] {
  const findings: Finding[] = [];
  if (safe.version !== "1.4.1") {
    findings.push({
      severity: "warning",
      code: "safe_version",
      message: `Safe version is ${safe.version ?? "unknown"}; this tool is built and tested for Safe v1.4.1.`,
    });
  }
  if (safe.singleton && !KNOWN_SINGLETONS[safe.singleton.toLowerCase()]) {
    findings.push({
      severity: "warning",
      code: "unknown_singleton",
      message: `The Safe proxy points at an unrecognized implementation ${safe.singleton}.`,
    });
  }
  for (const m of safe.modules) {
    if (recovery && isAddressEqual(m, recovery.module)) continue;
    const label = labels[m.toLowerCase()];
    findings.push({
      severity: "danger",
      code: "module_enabled",
      message: `Module ${m}${label ? ` (${label})` : " (unknown)"} is enabled: it can move funds without the owner key. disable-modules / exit removes it.`,
    });
  }
  if (recovery) findings.push(...recoveryFindings(recovery, now));
  const handler = safe.fallbackHandler;
  if (isAddressEqual(handler, SAFE7579_ADAPTER)) {
    findings.push({
      severity: "danger",
      code: "fallback_7579",
      message:
        "The fallback handler is the Safe7579 adapter: ERC-4337 operations, executor calls and ERC-1271 signatures by agent validators reach the account through it. disable-modules / exit resets it to the plain CompatibilityFallbackHandler.",
    });
  } else if (isAddressEqual(handler, ZERO_ADDRESS)) {
    findings.push({
      severity: "info",
      code: "fallback_none",
      message:
        "No fallback handler is set (ERC-1271 and token callbacks are disabled). disable-modules / exit sets the plain CompatibilityFallbackHandler.",
    });
  } else if (!isAddressEqual(handler, compatibilityFallbackHandler)) {
    findings.push({
      severity: "warning",
      code: "fallback_unknown",
      message: `The fallback handler ${handler} is not the verified CompatibilityFallbackHandler v1.4.1 (it can answer ERC-1271 signature checks for the account). disable-modules / exit replaces it.`,
    });
  }
  if (!isAddressEqual(safe.guard, ZERO_ADDRESS)) {
    findings.push({
      severity: "warning",
      code: "guard_set",
      message: `A transaction guard ${safe.guard} is set: it inspects (and can block) every owner transaction. The exit removes it first.`,
    });
  }
  if (signer) {
    if (!safe.owners.some((o) => isAddressEqual(o, signer))) {
      findings.push({
        severity: "danger",
        code: "signer_not_owner",
        message: `The key ${signer} is not an owner of this Safe (owners: ${safe.owners.join(", ")}).`,
      });
    }
  }
  if (safe.threshold > 1n) {
    findings.push({
      severity: "info",
      code: "multisig",
      message: `This Safe needs ${safe.threshold} of ${safe.owners.length} owner signatures per transaction; collect the others with --signer-only and pass them with --signature.`,
    });
  }
  return findings;
}

/**
 * Reads everything an owner needs to exit: the Safe's configuration (owners, modules, fallback
 * handler, guard), balances, and every Agent Bank escrow, stream, vault and spend-key float that
 * involves the account. Read-only.
 */
export async function inspectAccount(client: PublicClient, options: InspectOptions): Promise<AccountReport> {
  const account = getAddress(options.account);
  const latest = await client.getBlock({ blockTag: "latest" });
  const block = { number: latest.number, timestamp: latest.timestamp };
  const safe = await readSafeState(client, account);
  const labels = knownLabels(options);
  const signer = options.signer ? getAddress(options.signer) : undefined;

  // Only trust configured Agent Bank contracts that exist on this chain (a dry-run deployments file,
  // or one for another network, would otherwise produce confusing errors).
  const contracts: AgentBankContracts = {};
  const missing: string[] = [];
  for (const [key, address] of Object.entries(options.contracts) as [
    keyof AgentBankContracts,
    Address | undefined,
  ][]) {
    if (!address) continue;
    const code = await client.getCode({ address });
    if (code && code !== "0x") contracts[key] = address;
    else missing.push(`${key} ${address}`);
  }

  const report: AccountReport = {
    chain: { id: options.chain.id, name: options.chain.name, label: options.chain.label },
    block,
    account,
    safe,
    eth: await client.getBalance({ address: account, blockNumber: block.number }),
    tokens: {},
    balances: {},
    agentBankConfigured: Boolean(contracts.escrow || contracts.streams || contracts.vaults),
    contracts,
    escrows: [],
    streams: [],
    vaults: [],
    spendKeys: [],
    findings: [],
    labels,
    compatibilityFallbackHandler: (await isCanonicalFallbackHandler(
      client,
      options.compatibilityFallbackHandler,
    ))
      ? options.compatibilityFallbackHandler
      : ZERO_ADDRESS,
  };
  if (signer)
    report.signer = { address: signer, isOwner: safe.owners.some((o) => isAddressEqual(o, signer)) };
  if (await isCanonicalMultiSendCallOnly(client)) report.multiSendCallOnly = MULTISEND_CALL_ONLY;

  if (missing.length > 0) {
    report.findings.push({
      severity: "warning",
      code: "contracts_missing",
      message: `Configured Agent Bank contracts have no code on ${options.chain.label} and were ignored: ${missing.join(", ")} (wrong or dry-run deployments file?).`,
    });
  }
  if (!safe.deployed) {
    report.findings.push({
      severity: "danger",
      code: "not_deployed",
      message:
        "No contract is deployed at this address yet (counterfactual account). Funds sent to it are safe but can only be moved after the Safe is deployed with its original setup parameters.",
    });
  } else {
    const recovery = await readRecoveryState(client, account, safe.modules, block.number);
    if (recovery) {
      report.recovery = recovery;
      labels[recovery.module.toLowerCase()] =
        `Candide SocialRecoveryModule (guardian recovery, ${recovery.delayLabel})`;
    }
    report.findings.push(
      ...safeFindings(safe, labels, report.compatibilityFallbackHandler, signer, recovery, block.timestamp),
    );
    if (isAddressEqual(report.compatibilityFallbackHandler, ZERO_ADDRESS)) {
      report.findings.push({
        severity: "warning",
        code: "no_verified_fallback_handler",
        message:
          "No CompatibilityFallbackHandler v1.4.1 with the audited code exists at its canonical address on this chain: the revoke removes the fallback handler instead of replacing it (ERC-1271 signatures by the account stop working, which is safe).",
      });
    }
  }

  const addToken = async (token: Address): Promise<void> => {
    const key = token.toLowerCase();
    if (report.tokens[key]) return;
    report.tokens[key] = await readTokenInfo(client, token);
    report.balances[key] = await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account],
      blockNumber: block.number,
    });
  };
  if (options.usdc) {
    await addToken(options.usdc);
    report.usdc = report.tokens[options.usdc.toLowerCase()];
  }

  if (safe.deployed) await executorFindings(client, report, contracts, block.number);

  if (options.positions === false || !safe.deployed) return report;

  // Incoming escrows/streams and spend-key approvals can target the account's address before it is
  // deployed (counterfactual), so they are scanned from the Agent Bank floor. Positions the account
  // created need it deployed, so those scans may start at its deployment block.
  const floor = [options.chain.agentBankGenesisBlock, options.fromBlock ?? 0n].reduce((a, b) =>
    b > a ? b : a,
  );
  const lo = floor < block.number ? floor : block.number;
  const accountDeployedAt = await findDeploymentBlock(client, account, lo, block.number);
  const scanFromBlock = lo;
  const maxLogRequests = options.discovery?.maxLogRequests ?? 500;

  const positions = await discoverPositionIds(client, account, contracts, {
    mode: options.discovery?.mode ?? "auto",
    fromBlock: scanFromBlock,
    ...(accountDeployedAt !== undefined ? { outgoingFromBlock: accountDeployedAt } : {}),
    toBlock: block.number,
    maxLogRequests,
  });
  report.discovery = { positions, scanFromBlock };
  if (positions.failedReads > 0) {
    report.findings.push({
      severity: "danger",
      code: "discovery_incomplete",
      message: `${positions.failedReads} escrow/stream/vault records could not be read from the RPC: positions may be missing from this report. Run it again or use another RPC before relying on it.`,
    });
  }
  if (accountDeployedAt !== undefined) report.discovery.accountDeployedAt = accountDeployedAt;

  if (contracts.escrow && positions.escrows.length > 0) {
    report.escrows = await readEscrows(client, contracts.escrow, positions.escrows, account, block.timestamp);
  }
  if (contracts.streams && positions.streams.length > 0) {
    report.streams = await readStreams(client, contracts.streams, positions.streams, account);
  }
  if (contracts.vaults && positions.vaults.length > 0) {
    report.vaults = await readVaults(client, contracts.vaults, positions.vaults, block.timestamp);
  }

  if (options.usdc) {
    const explicit = (options.spendKeys ?? []).map((k) => getAddress(k));
    const spendKeyDiscovery = await discoverSpendKeys(client, options.usdc, account, {
      fromBlock: scanFromBlock,
      toBlock: block.number,
      maxLogRequests,
    });
    report.discovery.spendKeys = spendKeyDiscovery;
    const all = new Map<string, Address>();
    for (const k of [...explicit, ...spendKeyDiscovery.candidates]) all.set(k.toLowerCase(), k);
    all.delete(account.toLowerCase());
    // The owner's own wallet may have approved the account: it is not an agent spend key.
    for (const o of safe.owners) {
      if (!explicit.some((e) => isAddressEqual(e, o))) all.delete(o.toLowerCase());
    }
    if (all.size > 0) {
      const floats = await readSpendKeys(client, options.usdc, [...all.values()], account);
      // Keys found from Approval events only matter while their allowance to the account is live
      // (a later approval of 0 revokes it); keys given with --spend-key are always shown.
      report.spendKeys = floats.filter(
        (k) => k.allowance > 0n || explicit.some((e) => isAddressEqual(e, k.address)),
      );
    }
  }

  for (const token of new Set([
    ...report.escrows.map((e) => e.token),
    ...report.streams.map((s) => s.token),
    ...report.vaults.map((v) => v.token),
  ])) {
    await addToken(token);
  }

  for (const v of report.vaults) {
    if (v.balance > 0n && !v.unlocked && signer && !isAddressEqual(v.owner, signer)) {
      report.findings.push({
        severity: "warning",
        code: "vault_owner_differs",
        message: `Vault #${v.id} is locked and its owner is ${v.owner}, not your key ${signer}: only that key can sign an early withdrawal.`,
      });
    }
  }
  if (report.discovery.spendKeys && !report.discovery.spendKeys.complete && report.discovery.spendKeys.note) {
    report.findings.push({
      severity: "warning",
      code: "spend_keys_incomplete",
      message: report.discovery.spendKeys.note,
    });
  }
  return report;
}

/** What the owner should know about guardian recovery (contracts ADR 0002). */
function recoveryFindings(recovery: RecoveryState, now: bigint): Finding[] {
  const out: Finding[] = [];
  const n = BigInt(recovery.guardians.length);
  out.push({
    severity: "info",
    code: "recovery_module",
    message: `Guardian recovery is enabled (Candide SocialRecoveryModule ${recovery.module}, ${recovery.delayLabel} delay): ${recovery.threshold} of ${n} guardians [${recovery.guardians.join(", ")}] can replace the owners after the delay unless the owner cancels. disable-modules and exit keep it; pass --include-recovery to remove it too.`,
  });
  if (n > 0n && (recovery.threshold < 2n || recovery.threshold * 2n <= n)) {
    out.push({
      severity: "warning",
      code: "recovery_policy",
      message: `The recovery threshold ${recovery.threshold} of ${n} breaks Agent Bank's policy (a strict majority, and at least 2): fewer guardians than intended can start a recovery.`,
    });
  }
  if (recovery.pending) {
    const p = recovery.pending;
    const ready = now >= p.executeAfter;
    out.push({
      severity: "danger",
      code: "recovery_pending",
      message: `A guardian recovery is pending: ${ready ? "since" : "from"} ${formatTimestamp(p.executeAfter)} anyone can finalize it, replacing the owners with [${p.newOwners.join(", ")}] (threshold ${p.newThreshold}). If you did not ask for this, cancel it now with an owner transaction calling cancelRecovery() on ${recovery.module}.`,
    });
  }
  return out;
}

/**
 * What Agent Bank's ERC-7579 executors and hook may still do through the Safe7579 adapter (they all
 * stop working once the adapter is disabled), and treasury-sweep fund shares the account holds.
 */
async function executorFindings(
  client: PublicClient,
  report: AccountReport,
  contracts: AgentBankContracts,
  blockNumber: bigint,
): Promise<void> {
  const account = report.account;
  const initialized = async (
    address: Address | undefined,
    abi: typeof topUpExecutorAbi | typeof sweepExecutorAbi | typeof agentPolicyHookAbi,
  ) =>
    address
      ? ((await client
          .readContract({
            address,
            abi: abi as typeof topUpExecutorAbi,
            functionName: "isInitialized",
            args: [account],
            blockNumber,
          })
          .catch(() => false)) as boolean)
      : false;
  if (await initialized(contracts.topUpExecutor, topUpExecutorAbi)) {
    report.findings.push({
      severity: "warning",
      code: "topup_executor",
      message:
        "The TopUpExecutor is installed: keepers can move funds from this account to its agent accounts (within its daily caps) until the Safe7579 adapter is disabled.",
    });
  }
  if (await initialized(contracts.policyHook, agentPolicyHookAbi)) {
    report.findings.push({
      severity: "info",
      code: "policy_hook",
      message:
        "The AgentPolicyHook limits agent operations; it never applies to the owner's execTransaction path.",
    });
  }
  if (contracts.sweepExecutor && (await initialized(contracts.sweepExecutor, sweepExecutorAbi))) {
    const config = await client.readContract({
      address: contracts.sweepExecutor,
      abi: sweepExecutorAbi,
      functionName: "getConfig",
      args: [account],
      blockNumber,
    });
    const fund = await readTokenInfo(client, config.fund);
    const balance = await client.readContract({
      address: config.fund,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account],
      blockNumber,
    });
    report.fundShares = { fund, balance };
    report.findings.push({
      severity: "warning",
      code: "sweep_executor",
      message: `The SweepExecutor is installed (fund ${config.fund}): keepers can move USDC into that fund until the Safe7579 adapter is disabled. The account holds ${formatAmount(balance, fund.decimals)} ${fund.symbol} fund shares; exit leaves them in place unless you add --extra-token ${config.fund} (or redeem them with the fund).`,
    });
  }
}

/** Whether `address` holds exactly the CompatibilityFallbackHandler v1.4.1 code. */
export async function isCanonicalFallbackHandler(client: PublicClient, address: Address): Promise<boolean> {
  if (!isAddressEqual(address, SAFE_V141.compatibilityFallbackHandler)) return false;
  const code = await client.getCode({ address });
  return code !== undefined && code !== "0x" && keccak256(code) === COMPATIBILITY_FALLBACK_HANDLER_CODEHASH;
}

/** Throws a clear error when the account cannot be operated by the given signer. */
export function assertOperable(report: AccountReport): void {
  if (!report.safe.deployed) {
    throw new ExitToolError(
      "not_deployed",
      `No Safe is deployed at ${report.account} on ${report.chain.label}. Check the address and --chain/--rpc-url.`,
    );
  }
}
