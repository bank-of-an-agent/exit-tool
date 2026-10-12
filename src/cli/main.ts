import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createWalletClient,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  isAddressEqual,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { safeAbi, timeLockVaultsAbi } from "../core/abis/index";
import { parseAmount } from "../core/amounts";
import { txUrl, type ChainConfig } from "../core/chains";
import { SAFE7579_ADAPTER, SIMULATION_SENDER, ZERO_ADDRESS } from "../core/constants";
import type { Deployments } from "../core/deployments";
import { ExitToolError } from "../core/errors";
import {
  executeMaterialized,
  executePlan,
  type ExecuteOptions,
  type ExecutedStep,
  type ProgressEvent,
  type TransactionSender,
} from "../core/execute";
import { assertOperable, inspectAccount, type AccountReport } from "../core/inspect";
import {
  recoveryKeptNote,
  planCancelStreams,
  planExit,
  planRefundEscrows,
  planRevoke,
  planSweepSpendKeys,
  planWithdrawStep,
  planWithdrawVaults,
  type CommandName,
  type Plan,
} from "../core/plan";
import { buildPlanFile, parsePlanFile, type PlanFile } from "../core/planfile";
import { readTokenInfo } from "../core/positions";
import { describeError, describeRevertData } from "../core/revert";
import {
  encodeExecTransaction,
  normalizeEcdsaSignature,
  packSignatures,
  recoverSafeTxSigner,
  type OwnerSignature,
} from "../core/safe";
import {
  materializeAndSimulate,
  pickSimulationSigners,
  type MaterializedStep,
  type SimulationResult,
} from "../core/simulate";
import { summarizeRecovery } from "../core/summary";
import { earlyWithdrawalTypedData } from "../core/vaults";
import { VERSION } from "../version";
import {
  HELP,
  parseAddressOption,
  parseBigintOption,
  parseCliArgs,
  parseIds,
  type Command,
  type Values,
} from "./args";
import { connect, redactRpcUrl, resolveDeployments, type Connection } from "./context";
import { confirm, Printer, processIo, type Io } from "./io";
import { ownerKeySource, senderKeySource, type KeySource } from "./keys";
import { renderExecution, renderReport, renderSimulation, tokenAmount } from "./render";

/** CLI entry point. Returns the process exit code (0 ok, 1 failure, 2 usage error). */
export async function main(argv: readonly string[], io: Io = processIo()): Promise<number> {
  const printer = new Printer(io, argv.includes("--json"));
  try {
    const { command, values } = parseCliArgs(argv);
    if (values.version) {
      io.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (command === "help" || values.help) {
      io.stdout.write(HELP);
      return 0;
    }
    return await run(command, values, io, printer);
  } catch (err) {
    return reportError(err, printer);
  }
}

function reportError(err: unknown, printer: Printer): number {
  if (err instanceof ExitToolError) {
    if (printer.isJson) {
      printer.document({
        error: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) },
      });
    } else {
      printer.info(`error: ${err.message}`);
      if (err.hint) printer.info(`hint: ${err.hint}`);
    }
    return err.code === "invalid_argument" ? 2 : 1;
  }
  // Library errors (viem) can embed request details such as the RPC URL, which may carry an API
  // key: print the short, decoded form only.
  const message = describeError(err);
  if (printer.isJson) printer.document({ error: { code: "internal_error", message } });
  else printer.info(`error: ${message}`);
  return 1;
}

interface Context {
  io: Io;
  printer: Printer;
  values: Values;
  conn: Connection;
  deployments: Deployments;
}

async function run(command: Command, values: Values, io: Io, printer: Printer): Promise<number> {
  const conn = await connect(values, io);
  const deployments = await resolveDeployments(values, io, conn.chain);
  printer.info(
    `Connected to ${conn.chain.label} (chain id ${conn.chain.id}) via ${redactRpcUrl(conn.rpcUrl)}`,
  );
  const ctx: Context = { io, printer, values, conn, deployments };
  if (command === "submit" || (values.signature !== undefined && values["plan-file"] !== undefined)) {
    return runSubmit(ctx);
  }
  if (values.signature !== undefined) {
    throw new ExitToolError(
      "invalid_argument",
      "--signature needs --plan-file: the plan written by --signer-only.",
      {
        hint: "Run the command with --signer-only first, sign the payloads, then `agentbank-exit submit --plan-file <file> --signature …`.",
      },
    );
  }
  if (values["plan-file"] !== undefined && !values["signer-only"]) {
    throw new ExitToolError(
      "invalid_argument",
      "--plan-file is used with --signer-only (to write a plan) or with --signature (to submit one).",
    );
  }
  return runCommand(command as Exclude<Command, "submit" | "help">, ctx);
}

function requireAccount(ctx: Context): Address {
  const account = parseAddressOption("account", ctx.values.account ?? ctx.io.env.AGENTBANK_ACCOUNT);
  if (!account)
    throw new ExitToolError("invalid_argument", "--account <address> is required (the Safe to exit).");
  return account;
}

async function inspect(
  ctx: Context,
  account: Address,
  signer: Address | undefined,
  positions: boolean,
): Promise<AccountReport> {
  const { values, deployments, conn } = ctx;
  const spendKeys = (values["spend-key"] ?? []).map((k) => parseAddressOption("spend-key", k)!);
  const mode = values.discovery ?? "auto";
  if (!["auto", "events", "enumerate"].includes(mode)) {
    throw new ExitToolError("invalid_argument", "--discovery must be auto, events or enumerate.");
  }
  const maxLogRequests = Number(parseBigintOption("max-log-requests", values["max-log-requests"]) ?? 500n);
  return inspectAccount(conn.client, {
    chain: conn.chain,
    account,
    ...(deployments.usdc ? { usdc: deployments.usdc } : {}),
    compatibilityFallbackHandler:
      deployments.compatibilityFallbackHandler ?? conn.chain.compatibilityFallbackHandler,
    contracts: deployments.contracts,
    ...(deployments.fromBlock !== undefined ? { fromBlock: deployments.fromBlock } : {}),
    ...(signer ? { signer } : {}),
    spendKeys,
    positions,
    discovery: { mode: mode as "auto" | "events" | "enumerate", maxLogRequests },
  });
}

/** The address that will sign, without unlocking anything. */
async function signerAddressFor(
  ctx: Context,
  keySource: KeySource | undefined,
): Promise<Address | undefined> {
  const explicit = parseAddressOption("signer", ctx.values.signer);
  if (explicit) return explicit;
  return keySource?.address;
}

async function runCommand(command: Exclude<Command, "submit" | "help">, ctx: Context): Promise<number> {
  const { values, printer, conn } = ctx;
  const account = requireAccount(ctx);
  const signerOnly = values["signer-only"] === true;
  if (signerOnly && values.execute) {
    throw new ExitToolError(
      "invalid_argument",
      "--signer-only never broadcasts; drop --execute (submit the signed plan later).",
    );
  }
  const keySource = signerOnly
    ? undefined
    : await ownerKeySource(ctx.io, {
        ...(values.keystore ? { keystore: values.keystore } : {}),
        ...(values["password-file"] ? { passwordFile: values["password-file"] } : {}),
      });
  let signer = await signerAddressFor(ctx, keySource);
  const needsPositions = command !== "withdraw" && command !== "disable-modules";
  const report = await inspect(ctx, account, signer, command === "inspect" || needsPositions);
  const summary = summarizeRecovery(report);

  if (command === "inspect") {
    printer.line(renderReport(report, summary, conn.chain).join("\n"));
    if (report.safe.deployed) {
      printer.line("");
      printer.line(
        `Next: agentbank-exit exit --account ${account} --to <your address> [same connection options]`,
      );
      printer.line("      That is a dry run: it prints and simulates every step. Add --execute to send.");
    }
    printer.document({ command, report, recovery: summary });
    return 0;
  }

  assertOperable(report);
  if (!signer && report.safe.owners.length === 1) signer = report.safe.owners[0]!;
  if (signer && !report.safe.owners.some((o) => isAddressEqual(o, signer!))) {
    if (values.execute || signerOnly) {
      throw new ExitToolError(
        "not_an_owner",
        `${signer} is not an owner of ${account} (owners: ${report.safe.owners.join(", ")}).`,
      );
    }
    printer.info(
      `warning: ${signer} is not an owner of this Safe; this dry run simulates as if an owner signed.`,
    );
  }

  const plan = await buildPlan(command as CommandName, report, ctx, signer);
  await checkPlanTargets(ctx, report, plan);

  const deferred: string[] = [];
  if (signerOnly && command === "exit" && plan.steps.some((s) => s.category === "recover")) {
    // Amounts that come back during the exit are only known once those steps ran: sign them in a second round.
    const kept = plan.steps.filter((s) => !(s.category === "withdraw" && s.amount.kind === "erc20Balance"));
    for (const s of plan.steps) {
      if (s.category === "withdraw" && s.amount.kind === "erc20Balance") {
        const symbol = report.tokens[s.amount.token.toLowerCase()]?.symbol ?? s.amount.token;
        deferred.push(
          `agentbank-exit withdraw --account ${account} --to ${plan.destination} --token ${s.amount.token} --amount all --signer-only   (${symbol})`,
        );
      }
    }
    plan.steps = kept;
  }

  if (plan.steps.length === 0) {
    printer.line("Nothing to do.");
    for (const s of plan.skipped) printer.line(`  - ${s}`);
    printer.document({
      command,
      plan: { steps: [], skipped: plan.skipped },
      simulation: null,
      execution: null,
    });
    return 0;
  }

  const simulatedSigners = pickSimulationSigners(report, signer);
  const ttl =
    parseBigintOption("vault-signature-ttl", values["vault-signature-ttl"]) ??
    (signerOnly ? 86_400n : 3_600n);
  const sim = await materializeAndSimulate(conn.client, report, plan, {
    simulatedSigners,
    vaultSignatureTtl: ttl,
    tokens: Object.values(report.tokens).map((t) => t.address),
  });
  const gasPrice = await conn.client.getGasPrice().catch(() => undefined);
  const payerAddress = signerOnly ? undefined : (keySource?.address ?? signer);
  const payer = payerAddress
    ? { address: payerAddress, balance: await conn.client.getBalance({ address: payerAddress }) }
    : undefined;

  const mode = signerOnly
    ? "signer-only (nothing is signed or sent)"
    : values.execute
      ? "execute"
      : "dry run (nothing is signed or sent)";
  const header = `Plan: ${command} for ${account} on ${conn.chain.label}${plan.destination ? ` → ${plan.destination}` : ""} — ${mode}`;
  printer.line(
    renderSimulation(report, sim, header, {
      ...(gasPrice !== undefined ? { gasPrice } : {}),
      ...(payer ? { payer } : {}),
    }).join("\n"),
  );
  const pending = summary.pending;
  if (command === "exit") {
    if (pending.length > 0) {
      printer.line("Not recoverable yet (run exit again once these become available):");
      for (const p of pending) printer.line(`  - ${tokenAmount(report, p.token, p.amount)}: ${p.label}`);
    }
    for (const note of plan.skipped.filter((s) => s.startsWith("guardian recovery module"))) {
      printer.line(`Kept: ${note}.`);
    }
  } else if (plan.skipped.length > 0) {
    printer.line("Left alone:");
    for (const s of plan.skipped) printer.line(`  - ${s}`);
  }

  const baseDoc = {
    command,
    chain: { id: conn.chain.id, name: conn.chain.name },
    account,
    destination: plan.destination ?? null,
    plan: { steps: sim.steps, skipped: plan.skipped },
    simulation: {
      ok: sim.ok,
      method: sim.method,
      results: sim.results,
      gasTotal: sim.gasTotal,
      balances: sim.balances ?? null,
      note: sim.note ?? null,
    },
    pending,
  };

  if (!sim.ok) {
    printer.line("");
    printer.line("The simulation failed: fix the problem above before executing. Nothing was sent.");
    printer.document({ ...baseDoc, dryRun: !values.execute, execution: null });
    return 1;
  }

  if (signerOnly) {
    const file = buildPlanFile({
      chainId: conn.chain.id,
      account,
      command,
      ...(plan.destination ? { destination: plan.destination } : {}),
      safe: { nonce: report.safe.nonce, threshold: report.safe.threshold, owners: report.safe.owners },
      steps: sim.steps,
      notes: [
        ...plan.skipped.map((s) => `left alone: ${s}`),
        ...(deferred.length > 0
          ? ["After these steps are confirmed, sign the final withdrawals with:", ...deferred]
          : []),
      ],
    });
    const written = await writePlanFile(ctx, file, account);
    printSignerOnly(ctx, file, written, deferred);
    printer.document({
      ...baseDoc,
      dryRun: true,
      execution: null,
      signerOnly: {
        planFile: written.planPath,
        payloadFiles: written.payloadPaths,
        payloads: file.payloads,
        deferred,
      },
    });
    return 0;
  }

  if (!values.execute) {
    printer.line("");
    printer.line(
      "Dry run: nothing was signed or sent. Re-run with --execute to broadcast (you will be asked to confirm).",
    );
    printer.document({ ...baseDoc, dryRun: true, execution: null });
    return 0;
  }

  // ---- execute ----
  if (report.safe.threshold > 1n) {
    throw new ExitToolError(
      "signature_mismatch",
      `This Safe needs ${report.safe.threshold} owner signatures per transaction.`,
      {
        hint: "Use --signer-only, have the owners sign the payloads, then `agentbank-exit submit --plan-file … --signature … --execute`.",
      },
    );
  }
  if (!keySource) {
    throw new ExitToolError("missing_key", "--execute needs the owner key.", {
      hint: "Set OWNER_PRIVATE_KEY or pass --keystore <file>; with a hardware wallet use --signer-only.",
    });
  }
  const ownerAccount = await keySource.load();
  if (!report.safe.owners.some((o) => isAddressEqual(o, ownerAccount.address))) {
    throw new ExitToolError("not_an_owner", `The key ${ownerAccount.address} is not an owner of ${account}.`);
  }
  await checkGasFunds(ctx, ownerAccount.address, sim.gasTotal, gasPrice);
  const count = sim.steps.filter((s) => !s.skipped).length;
  await confirmOrAbort(
    ctx,
    `About to send ${count} transaction(s) on ${conn.chain.label} from ${ownerAccount.address}${plan.destination ? `, moving funds to ${plan.destination}` : ""}.`,
  );

  const sender = walletSender(ctx, ownerAccount);
  const results = await executePlan(conn.client, plan, {
    ...executeBase(ctx, report, sender),
    signers: [ownerAccount],
    vaultSignatureTtl: ttl,
  });
  printer.line("");
  printer.line("Executed:");
  printer.line(renderExecution(results, conn.chain).join("\n"));
  const after = await finalState(ctx, account, signer, needsPositions);
  printer.document({ ...baseDoc, dryRun: false, execution: results, after });
  return 0;
}

async function buildPlan(
  command: CommandName,
  report: AccountReport,
  ctx: Context,
  signer: Address | undefined,
): Promise<Plan> {
  const { values, deployments } = ctx;
  const base = { command, chainId: report.chain.id, account: report.account };
  const ids = parseIds(values.ids);
  switch (command) {
    case "withdraw": {
      const to = requireDestination(values, report);
      if (!values.token)
        throw new ExitToolError("invalid_argument", "withdraw needs --token usdc|eth|<erc20 address>.");
      if (!values.amount)
        throw new ExitToolError("invalid_argument", "withdraw needs --amount <decimal> or --amount all.");
      const tokenArg = values.token.toLowerCase();
      if (tokenArg === "eth") {
        const amount = values.amount === "all" ? "all" : parseAmount(values.amount, 18);
        return {
          ...base,
          destination: to,
          steps: [planWithdrawStep(report, { to, token: "eth", amount })],
          skipped: [],
        };
      }
      let token: Address;
      if (tokenArg === "usdc") {
        if (!deployments.usdc) {
          throw new ExitToolError("missing_config", "No USDC address is configured for this chain.", {
            hint: "Pass --usdc <address> or --deployments <file>.",
          });
        }
        token = deployments.usdc;
      } else {
        token = parseAddressOption("token", values.token)!;
      }
      const info = report.tokens[token.toLowerCase()] ?? (await readTokenInfo(ctx.conn.client, token));
      report.tokens[token.toLowerCase()] = info;
      const amount = values.amount === "all" ? "all" : parseAmount(values.amount, info.decimals);
      return {
        ...base,
        destination: to,
        steps: [planWithdrawStep(report, { to, token, amount, symbol: info.symbol })],
        skipped: [],
      };
    }
    case "disable-modules": {
      const options = {
        keepGuard: values["keep-guard"] === true,
        includeRecovery: values["include-recovery"] === true,
      };
      return { ...base, steps: planRevoke(report, options), skipped: recoveryKeptNote(report, options) };
    }
    case "refund-escrows": {
      requireAgentBank(report, "escrow");
      const r = planRefundEscrows(report, ids ? { ids } : {});
      return { ...base, ...r };
    }
    case "cancel-streams": {
      requireAgentBank(report, "streams");
      const r = planCancelStreams(report, ids ? { ids } : {});
      return { ...base, ...r };
    }
    case "withdraw-vaults": {
      requireAgentBank(report, "vaults");
      const r = planWithdrawVaults(report, {
        ...(ids ? { ids } : {}),
        unlockedOnly: values["unlocked-only"] === true,
        ...(signer ? { signer } : {}),
      });
      return { ...base, ...r };
    }
    case "sweep-spend-keys": {
      const r = planSweepSpendKeys(report);
      if (report.spendKeys.length === 0) r.skipped.push("no spend keys found: pass --spend-key <address>");
      return { ...base, ...r };
    }
    case "exit": {
      const to = requireDestination(values, report);
      const extraTokens = (values["extra-token"] ?? []).map((t) => parseAddressOption("extra-token", t)!);
      for (const t of extraTokens) {
        if (!report.tokens[t.toLowerCase()])
          report.tokens[t.toLowerCase()] = await readTokenInfo(ctx.conn.client, t);
      }
      return planExit(report, {
        to,
        keepGuard: values["keep-guard"] === true,
        includeRecovery: values["include-recovery"] === true,
        unlockedOnly: values["unlocked-only"] === true,
        skipSpendKeys: values["skip-spend-keys"] === true,
        extraTokens,
        ...(signer ? { signer } : {}),
      });
    }
  }
}

function requireAgentBank(report: AccountReport, which: "escrow" | "streams" | "vaults"): void {
  if (!report.contracts[which]) {
    const name =
      which === "escrow" ? "AgentEscrow" : which === "streams" ? "PaymentStreams" : "TimeLockVaults";
    throw new ExitToolError(
      "missing_config",
      `The ${name} address is not configured for ${report.chain.label}.`,
      {
        hint: `Pass --deployments <file> or --${which} <address>.`,
      },
    );
  }
}

function requireDestination(values: Values, report: AccountReport): Address {
  const to = parseAddressOption("to", values.to);
  if (!to)
    throw new ExitToolError("invalid_argument", "--to <address> is required: where your funds should go.");
  if (isAddressEqual(to, ZERO_ADDRESS))
    throw new ExitToolError("invalid_argument", "--to cannot be the zero address.");
  if (isAddressEqual(to, report.account))
    throw new ExitToolError("invalid_argument", "--to is the account itself.");
  const forbidden = [
    SAFE7579_ADAPTER,
    ...report.safe.modules,
    ...Object.values(report.contracts).filter((a): a is Address => Boolean(a)),
    ...Object.values(report.tokens).map((t) => t.address),
  ];
  if (forbidden.some((a) => isAddressEqual(a, to))) {
    throw new ExitToolError(
      "invalid_argument",
      `--to ${to} is a module, token or Agent Bank contract, not a wallet you control.`,
    );
  }
  return to;
}

/** Checks the destination and the fallback handler the plan relies on. */
async function checkPlanTargets(ctx: Context, report: AccountReport, plan: Plan): Promise<void> {
  if (plan.steps.some((s) => s.id.startsWith("set-fallback-handler"))) {
    const code = await ctx.conn.client.getCode({ address: report.compatibilityFallbackHandler });
    if (!code || code === "0x") {
      throw new ExitToolError(
        "missing_config",
        `The CompatibilityFallbackHandler ${report.compatibilityFallbackHandler} has no code on ${report.chain.label}.`,
        { hint: "Pass --fallback-handler <address> (a deployed Safe CompatibilityFallbackHandler)." },
      );
    }
  }
  if (plan.destination) {
    const code = await ctx.conn.client.getCode({ address: plan.destination });
    if (code && code !== "0x") {
      ctx.printer.info(
        `note: the destination ${plan.destination} is a contract; make sure it can receive ETH and tokens and that you control it.`,
      );
    }
  }
}

async function checkGasFunds(
  ctx: Context,
  payer: Address,
  gas: bigint,
  gasPrice: bigint | undefined,
): Promise<void> {
  if (gasPrice === undefined) return;
  const balance = await ctx.conn.client.getBalance({ address: payer });
  const needed = (gas * gasPrice * 15n) / 10n;
  if (balance < needed) {
    throw new ExitToolError(
      "insufficient_gas_funds",
      `${payer} has ${formatEther(balance)} ETH but the plan needs about ${formatEther(needed)} ETH of gas.`,
      {
        hint: `Send a little ETH to ${payer} (it pays the gas; the account's own ETH is withdrawn, not spent).`,
      },
    );
  }
}

async function confirmOrAbort(ctx: Context, message: string): Promise<void> {
  if (ctx.values.yes) return;
  if (!ctx.io.interactive) {
    throw new ExitToolError(
      "aborted",
      "Refusing to broadcast without confirmation: stdin is not a terminal.",
      {
        hint: "Pass --yes to confirm non-interactively.",
      },
    );
  }
  if (!(await confirm(ctx.io, message))) throw new ExitToolError("aborted", "Aborted: nothing was sent.");
}

function walletSender(ctx: Context, account: LocalAccount): TransactionSender {
  const wallet = createWalletClient({
    account,
    chain: ctx.conn.viemChain,
    transport: http(ctx.conn.rpcUrl, { retryCount: 0, timeout: 60_000 }),
  });
  return {
    address: account.address,
    sendTransaction: (tx) =>
      wallet.sendTransaction({
        account,
        chain: ctx.conn.viemChain,
        to: tx.to,
        data: tx.data,
        value: tx.value,
        gas: tx.gas,
      }),
  };
}

function progress(ctx: Context, chain: ChainConfig) {
  return (e: ProgressEvent): void => {
    if (e.type === "start") ctx.printer.info(`[${e.index}/${e.total}] ${e.title}`);
    else if (e.type === "skipped") ctx.printer.info(`      skipped: ${e.reason}`);
    else if (e.type === "sent")
      ctx.printer.info(`      sent ${e.hash}${txUrl(chain, e.hash) ? `  ${txUrl(chain, e.hash)}` : ""}`);
    else ctx.printer.info(`      confirmed in block ${e.blockNumber} (gas ${e.gasUsed})`);
  };
}

function executeBase(
  ctx: Context,
  report: AccountReport,
  sender: TransactionSender,
): Omit<ExecuteOptions, "signers"> {
  return {
    chainId: report.chain.id,
    account: report.account,
    owners: report.safe.owners,
    threshold: report.safe.threshold,
    sender,
    onProgress: progress(ctx, ctx.conn.chain),
  };
}

async function finalState(ctx: Context, account: Address, signer: Address | undefined, positions: boolean) {
  const report = await inspect(ctx, account, signer, positions);
  const summary = summarizeRecovery(report);
  ctx.printer.line("");
  ctx.printer.line("Account after execution:");
  ctx.printer.line(
    `  ETH ${formatEther(report.eth)}; ${Object.entries(report.tokens)
      .map(([k, t]) => tokenAmount(report, t.address, report.balances[k] ?? 0n))
      .join("; ")}`,
  );
  ctx.printer.line(
    `  modules: ${report.safe.modules.length === 0 ? "none" : report.safe.modules.join(", ")}; fallback handler ${report.safe.fallbackHandler}; guard ${report.safe.guard}`,
  );
  if (summary.pending.length > 0) {
    ctx.printer.line("  still pending:");
    for (const p of summary.pending) {
      ctx.printer.line(`    - ${tokenAmount(report, p.token, p.amount)}: ${p.label}`);
    }
  }
  return { safe: report.safe, eth: report.eth, balances: report.balances, recovery: summary };
}

// ------------------------------------------------------------------------------------------------
// Signer-only: plan files and payloads
// ------------------------------------------------------------------------------------------------

async function writePlanFile(ctx: Context, file: PlanFile, account: Address) {
  const stamp = file.createdAt.replace(/[-:]/g, "").replace(/\..*$/, "");
  const planPath =
    ctx.values["plan-file"] ??
    path.join(`agentbank-exit-${account.slice(2, 10).toLowerCase()}-${stamp}`, "plan.json");
  const dir = path.dirname(planPath);
  await mkdir(dir, { recursive: true });
  await writeFile(planPath, `${JSON.stringify(file, null, 2)}\n`);
  const payloadPaths: string[] = [];
  for (const p of file.payloads) {
    const name = path.join(dir, `step-${String(p.step).padStart(2, "0")}-${p.kind}.json`);
    await writeFile(name, `${JSON.stringify(p.typedData, null, 2)}\n`);
    payloadPaths.push(name);
  }
  return { planPath, payloadPaths };
}

function printSignerOnly(
  ctx: Context,
  file: PlanFile,
  written: { planPath: string; payloadPaths: string[] },
  deferred: string[],
): void {
  const { printer } = ctx;
  printer.line("");
  printer.line(`Plan written to ${written.planPath} (no secrets inside).`);
  printer.line(
    "Sign each payload below with the owner key (EIP-712 typed data), e.g. on a Ledger with Foundry:",
  );
  file.payloads.forEach((p, i) => {
    printer.line(`  step ${p.step} ${p.kind}: hash ${p.hash}`);
    printer.line(`    signer: ${p.signer === "owner" ? `an owner of ${file.account}` : p.signer}`);
    printer.line(`    cast wallet sign --ledger --data --from-file ${written.payloadPaths[i]}`);
  });
  printer.line(
    "Any wallet that supports eth_signTypedData_v4 works too; the hash must match what the device shows.",
  );
  printer.line("");
  printer.line(
    "Then submit (a funded SENDER_PRIVATE_KEY or --sender-keystore pays the gas; or print the transactions to send yourself):",
  );
  printer.line(
    `  agentbank-exit submit --plan-file ${written.planPath} ${file.payloads.map(() => "--signature 0x…").join(" ")} --execute`,
  );
  if (deferred.length > 0) {
    printer.line("");
    printer.line(
      "After these are confirmed, sign the final withdrawals (their amounts depend on what came back):",
    );
    for (const d of deferred) printer.line(`  ${d}`);
  }
}

/** Matches supplied signatures to the plan's payloads and returns the final transaction for each step. */
async function finalizeSignedSteps(
  steps: readonly MaterializedStep[],
  file: PlanFile,
  signatures: readonly Hex[],
): Promise<{ step: MaterializedStep; to: Address; data: Hex; value: bigint }[]> {
  const owners = file.safe.owners.map((o) => getAddress(o));
  const threshold = BigInt(file.safe.threshold);
  const normalized = signatures.map((s) => {
    try {
      return normalizeEcdsaSignature(s);
    } catch (cause) {
      throw new ExitToolError(
        "invalid_argument",
        `Invalid --signature ${s.slice(0, 12)}…: ${(cause as Error).message}`,
      );
    }
  });
  const out: { step: MaterializedStep; to: Address; data: Hex; value: bigint }[] = [];
  for (const step of steps) {
    if (step.skipped) continue;
    if (step.safeTx) {
      const collected = new Map<string, OwnerSignature>();
      for (const sig of normalized) {
        const signer = await recoverSafeTxSigner(file.chainId, file.account, step.safeTx, sig).catch(
          () => undefined,
        );
        if (signer && owners.some((o) => isAddressEqual(o, signer)))
          collected.set(signer.toLowerCase(), { signer, kind: "ecdsa", data: sig });
      }
      if (BigInt(collected.size) < threshold) {
        throw new ExitToolError(
          "signature_mismatch",
          `Step ${step.index} (${step.title}) needs ${threshold} owner signature(s) over SafeTx ${step.safeTxHash}; got ${collected.size}.`,
        );
      }
      out.push({
        step,
        to: file.account,
        data: encodeExecTransaction(step.safeTx, packSignatures([...collected.values()])),
        value: 0n,
      });
    } else if (step.vault) {
      const typed = earlyWithdrawalTypedData(step.vault.domain, step.vault.message);
      let found: Hex | undefined;
      for (const sig of normalized) {
        const signer = await recoverTypedDataAddress({ ...typed, signature: sig }).catch(() => undefined);
        if (signer && isAddressEqual(signer, step.vault.owner)) found = sig;
      }
      if (!found) {
        throw new ExitToolError(
          "signature_mismatch",
          `Step ${step.index} needs the vault owner's (${step.vault.owner}) signature over ${step.vault.digest}.`,
        );
      }
      out.push({
        step,
        to: step.call.to,
        data: encodeFunctionData({
          abi: timeLockVaultsAbi,
          functionName: "withdrawWithSignature",
          args: [step.vault.message.vaultId, step.vault.message.amount, step.vault.message.deadline, found],
        }),
        value: 0n,
      });
    } else {
      out.push({ step, to: step.call.to, data: step.call.data, value: step.call.value });
    }
  }
  return out;
}

async function runSubmit(ctx: Context): Promise<number> {
  const { values, printer, conn } = ctx;
  const planPath = values["plan-file"];
  if (!planPath)
    throw new ExitToolError(
      "invalid_argument",
      "submit needs --plan-file <file> (written by --signer-only).",
    );
  let json: unknown;
  try {
    json = JSON.parse(await readFile(planPath, "utf8"));
  } catch (cause) {
    throw new ExitToolError("invalid_argument", `Cannot read plan file ${planPath}.`, { cause });
  }
  const account = parseAddressOption("account", values.account ?? ctx.io.env.AGENTBANK_ACCOUNT);
  const { file, steps } = parsePlanFile(json, { chainId: conn.chain.id, ...(account ? { account } : {}) });
  const signatures = (values.signature ?? []) as Hex[];
  const safeNonce = await conn.client.readContract({
    address: file.account,
    abi: safeAbi,
    functionName: "nonce",
  });
  // Safe steps whose nonce is already used ran before (or were replaced): never resend them.
  const done = steps.filter((s) => !s.skipped && s.safeTx !== undefined && s.safeTx.nonce < safeNonce);
  for (const s of done) {
    s.skipped = `already executed or replaced (Safe nonce ${s.safeTx!.nonce} is used)`;
  }
  if (steps.every((s) => s.skipped)) {
    printer.line(
      `Nothing left to submit from ${planPath}: every step has already run (Safe nonce is ${safeNonce}).`,
    );
    printer.document({
      command: "submit",
      planFile: planPath,
      account: file.account,
      execution: [],
      alreadyExecuted: done.map((s) => s.index),
    });
    return 0;
  }
  const finals = await finalizeSignedSteps(steps, file, signatures);

  // Simulate exactly what will be sent, with the real signatures.
  const [block] = await conn.client.simulateBlocks({
    blocks: [
      { calls: finals.map((f) => ({ account: SIMULATION_SENDER, to: f.to, data: f.data, value: f.value })) },
    ],
    validation: false,
  });
  const results = (block?.calls ?? []).map((r, i) => ({
    index: finals[i]!.step.index,
    status: r.status,
    gasUsed: r.gasUsed,
    ...(r.status === "failure" ? { error: describeRevertData(r.data) } : {}),
  }));
  const sim: SimulationResult = {
    ok: results.every((r) => r.status === "success"),
    method: "eth_simulateV1",
    steps,
    results,
    gasTotal: results.reduce((a, r) => a + r.gasUsed, 0n),
  };
  const reportStub = await inspect(ctx, file.account, undefined, false);
  printer.line(
    renderSimulation(
      reportStub,
      sim,
      `Signed plan ${planPath}: ${file.command} for ${file.account} on ${conn.chain.label} (Safe nonce now ${safeNonce})`,
    ).join("\n"),
  );
  for (const note of file.notes) printer.line(`  note: ${note}`);
  const doc = {
    command: "submit",
    planFile: planPath,
    account: file.account,
    simulation: { ok: sim.ok, results, gasTotal: sim.gasTotal },
  };
  if (!sim.ok) {
    printer.line(
      "The signed plan no longer simulates cleanly (the account changed, or a signature is wrong): nothing was sent. Create a new plan with --signer-only.",
    );
    printer.document({ ...doc, execution: null });
    return 1;
  }
  if (!values.execute) {
    printer.line("");
    printer.line(
      "Ready. Send these transactions in order from any funded wallet (the signatures authorise them; the sender has no power over the funds),",
    );
    printer.line(
      "or re-run with --execute and SENDER_PRIVATE_KEY / --sender-keystore (or the owner key) to send them now:",
    );
    for (const f of finals) printer.line(`  ${f.step.index}. to ${f.to} value ${f.value} data ${f.data}`);
    printer.document({
      ...doc,
      transactions: finals.map((f) => ({ step: f.step.index, to: f.to, value: f.value, data: f.data })),
      execution: null,
    });
    return 0;
  }
  const senderSource =
    (await senderKeySource(ctx.io, {
      ...(values["sender-keystore"] ? { senderKeystore: values["sender-keystore"] } : {}),
      ...(values["sender-password-file"] ? { senderPasswordFile: values["sender-password-file"] } : {}),
    })) ??
    (await ownerKeySource(ctx.io, {
      ...(values.keystore ? { keystore: values.keystore } : {}),
      ...(values["password-file"] ? { passwordFile: values["password-file"] } : {}),
    }));
  if (!senderSource) {
    throw new ExitToolError(
      "missing_key",
      "submit --execute needs a key to send the transactions (it only pays gas).",
      {
        hint: "Set SENDER_PRIVATE_KEY or pass --sender-keystore; or drop --execute to print the transactions and send them with any wallet.",
      },
    );
  }
  const senderAccount = await senderSource.load();
  const gasPrice = await conn.client.getGasPrice().catch(() => undefined);
  await checkGasFunds(ctx, senderAccount.address, sim.gasTotal, gasPrice);
  await confirmOrAbort(
    ctx,
    `About to send ${finals.length} signed transaction(s) on ${conn.chain.label} from ${senderAccount.address}.`,
  );
  const executed: ExecutedStep[] = await executeMaterialized(conn.client, steps, {
    chainId: conn.chain.id,
    account: file.account,
    owners: file.safe.owners,
    threshold: BigInt(file.safe.threshold),
    signers: [],
    signatures,
    sender: walletSender(ctx, senderAccount),
    onProgress: progress(ctx, conn.chain),
  });
  printer.line("");
  printer.line("Executed:");
  printer.line(renderExecution(executed, conn.chain).join("\n"));
  printer.document({ ...doc, execution: executed });
  return 0;
}
