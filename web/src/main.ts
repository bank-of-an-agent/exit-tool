/**
 * Static owner exit page: the same inspect / withdraw / exit flow as the CLI, driven by an injected
 * wallet (EIP-1193). Everything goes through the wallet's own RPC: the page makes no other network
 * request (its Content-Security-Policy has `connect-src 'none'`), has no backend and no
 * dependencies at runtime. On-chain strings are only ever written with textContent.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  formatEther,
  getAddress,
  isAddress,
  isAddressEqual,
  type Address,
  type Chain,
  type EIP1193Provider,
  type Hex,
  type PublicClient,
} from "viem";
import { formatAmount, parseAmount } from "../../src/core/amounts";
import { assertSupportedChainId, txUrl, type ChainConfig } from "../../src/core/chains";
import { ZERO_ADDRESS } from "../../src/core/constants";
import { mergeDeployments, parseDeployments, type Deployments } from "../../src/core/deployments";
import { describeCall } from "../../src/core/describe";
import { ExitToolError } from "../../src/core/errors";
import { executePlan, type ExecutedStep, type ProgressEvent } from "../../src/core/execute";
import { inspectAccount, type AccountReport } from "../../src/core/inspect";
import { planExit, planRevoke, planWithdrawStep, type Plan } from "../../src/core/plan";
import { readTokenInfo } from "../../src/core/positions";
import { describeError } from "../../src/core/revert";
import {
  materializeAndSimulate,
  pickSimulationSigners,
  type SimulationResult,
} from "../../src/core/simulate";
import { summarizeRecovery } from "../../src/core/summary";
import { VERSION } from "../../src/version";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

interface State {
  provider?: EIP1193Provider;
  chain?: ChainConfig;
  viemChain?: Chain;
  client?: PublicClient;
  wallet?: Address;
  report?: AccountReport;
  plan?: Plan;
  sim?: SimulationResult;
  busy: boolean;
}

const state: State = { busy: false };

// ----------------------------------------------------------------------------------------------
// Tiny DOM helpers (textContent only: chain data is untrusted)
// ----------------------------------------------------------------------------------------------

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function input(id: string): HTMLInputElement {
  return $(id) as HTMLInputElement;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function link(href: string, text: string): HTMLAnchorElement {
  const a = el("a", text);
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function status(message: string, kind: "info" | "error" | "ok" = "info"): void {
  const box = $("status");
  box.textContent = message;
  box.className = `status ${kind}`;
}

function errorText(err: unknown): string {
  if (err instanceof ExitToolError) return err.hint ? `${err.message} ${err.hint}` : err.message;
  return describeError(err);
}

async function guarded(label: string, fn: () => Promise<void>): Promise<void> {
  if (state.busy) return;
  state.busy = true;
  document.body.classList.add("busy");
  status(`${label}…`);
  try {
    await fn();
  } catch (err) {
    status(errorText(err), "error");
  } finally {
    state.busy = false;
    document.body.classList.remove("busy");
  }
}

function tokenAmount(report: AccountReport, token: Address | "ETH", amount: bigint): string {
  if (token === "ETH") return `${formatEther(amount)} ETH`;
  const info = report.tokens[token.toLowerCase()];
  return info ? `${formatAmount(amount, info.decimals)} ${info.symbol}` : `${amount} units of ${token}`;
}

function addressField(id: string, label: string): Address {
  const value = input(id).value.trim();
  if (!isAddress(value, { strict: false }))
    throw new ExitToolError("invalid_argument", `${label} is not a valid address.`);
  if (value !== value.toLowerCase() && !isAddress(value, { strict: true })) {
    throw new ExitToolError(
      "invalid_argument",
      `${label} has an invalid checksum: check it character by character.`,
    );
  }
  return getAddress(value);
}

// ----------------------------------------------------------------------------------------------
// Wallet and chain
// ----------------------------------------------------------------------------------------------

async function connect(): Promise<void> {
  const provider = window.ethereum;
  if (!provider) {
    throw new ExitToolError(
      "missing_key",
      "No browser wallet found. Install one (MetaMask, Rabby, Frame…) and open this page over http(s): wallets do not inject into file:// pages.",
    );
  }
  const [account] = (await provider.request({ method: "eth_requestAccounts" })) as Address[];
  if (!account) throw new ExitToolError("missing_key", "The wallet did not share an account.");
  const chainId = Number.parseInt((await provider.request({ method: "eth_chainId" })) as string, 16);
  const chain = assertSupportedChainId(chainId); // refuses mainnet
  const viemChain = defineChain({
    id: chain.id,
    name: chain.label,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [] } },
  });
  state.provider = provider;
  state.chain = chain;
  state.viemChain = viemChain;
  state.client = createPublicClient({
    chain: viemChain,
    transport: custom(provider),
    pollingInterval: 1_000,
  }) as PublicClient;
  state.wallet = getAddress(account);
  $("wallet").textContent = `${state.wallet} on ${chain.label} (chain id ${chain.id})`;
  if (chain.usdc && !input("usdc").value) input("usdc").value = chain.usdc;
  status("Wallet connected. Enter your Agent Bank account (Safe) address and inspect it.", "ok");
}

async function switchToBaseSepolia(): Promise<void> {
  const provider = window.ethereum;
  if (!provider) throw new ExitToolError("missing_key", "No browser wallet found.");
  await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x14a34" }] });
  await connect();
}

function deploymentsFromForm(): Deployments {
  const parts: Deployments[] = [];
  const raw = (input("deployments") as unknown as HTMLTextAreaElement).value.trim();
  if (raw) {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new ExitToolError("invalid_argument", "The Agent Bank deployments box must contain JSON.");
    }
    const parsed = parseDeployments(json);
    if (parsed.chainId !== undefined && parsed.chainId !== state.chain?.id) {
      throw new ExitToolError(
        "chain_mismatch",
        `The deployments JSON is for chain ${parsed.chainId}, the wallet is on ${state.chain?.id}.`,
      );
    }
    parts.push(parsed);
  }
  const usdc = input("usdc").value.trim();
  if (usdc) parts.push({ contracts: {}, usdc: addressField("usdc", "USDC address") });
  return mergeDeployments(...parts);
}

// ----------------------------------------------------------------------------------------------
// Inspect
// ----------------------------------------------------------------------------------------------

async function inspect(): Promise<void> {
  if (!state.client || !state.chain) await connect();
  const client = state.client!;
  const chain = state.chain!;
  const account = addressField("account", "Account address");
  const deployments = deploymentsFromForm();
  const report = await inspectAccount(client, {
    chain,
    account,
    ...(deployments.usdc ? { usdc: deployments.usdc } : {}),
    compatibilityFallbackHandler:
      deployments.compatibilityFallbackHandler ?? chain.compatibilityFallbackHandler,
    contracts: deployments.contracts,
    ...(deployments.fromBlock !== undefined ? { fromBlock: deployments.fromBlock } : {}),
    ...(state.wallet ? { signer: state.wallet } : {}),
    discovery: { mode: "auto", maxLogRequests: 200 },
  });
  state.report = report;
  state.plan = undefined;
  state.sim = undefined;
  renderReport(report);
  clear($("plan"));
  $("actions").hidden = !report.safe.deployed;
  if (!input("to").value && state.wallet) input("to").value = state.wallet;
  status(
    report.signer?.isOwner
      ? "Inspected. Choose an action below: every step is simulated before anything is sent."
      : "Inspected. The connected wallet is NOT an owner of this account: you can look, but not act.",
    report.signer?.isOwner ? "ok" : "error",
  );
}

function row(table: HTMLTableElement, label: string, value: string | Node): void {
  const tr = el("tr");
  tr.append(el("th", label));
  const td = el("td");
  if (typeof value === "string") td.textContent = value;
  else td.append(value);
  tr.append(td);
  table.append(tr);
}

function renderReport(report: AccountReport): void {
  const box = $("report");
  clear(box);
  box.append(el("h2", "Account"));
  const t = el("table");
  const s = report.safe;
  row(t, "Account", report.account);
  row(t, "Safe", s.deployed ? `version ${s.version ?? "unknown"}, nonce ${s.nonce}` : "NOT DEPLOYED");
  row(t, "Owners", `${s.threshold} of ${s.owners.length}: ${s.owners.join(", ")}`);
  row(
    t,
    "Modules",
    s.modules.length === 0
      ? "none"
      : s.modules
          .map((m) => `${m}${report.labels[m.toLowerCase()] ? ` (${report.labels[m.toLowerCase()]})` : ""}`)
          .join("; "),
  );
  row(
    t,
    "Fallback handler",
    isAddressEqual(s.fallbackHandler, ZERO_ADDRESS)
      ? "none"
      : `${s.fallbackHandler}${report.labels[s.fallbackHandler.toLowerCase()] ? ` (${report.labels[s.fallbackHandler.toLowerCase()]})` : ""}`,
  );
  row(t, "Guard", isAddressEqual(s.guard, ZERO_ADDRESS) ? "none" : s.guard);
  const balances = [
    `${formatEther(report.eth)} ETH`,
    ...Object.entries(report.tokens).map(
      ([k, info]) => `${formatAmount(report.balances[k] ?? 0n, info.decimals)} ${info.symbol}`,
    ),
  ];
  row(t, "Balances", balances.join(", "));
  box.append(t);

  if (report.findings.length > 0) {
    box.append(el("h3", "Findings"));
    const ul = el("ul");
    for (const f of report.findings) ul.append(el("li", f.message, f.severity));
    box.append(ul);
  }

  const summary = summarizeRecovery(report);
  box.append(el("h3", "What you can recover now"));
  const now = el("ul");
  if (summary.now.length === 0) now.append(el("li", "nothing"));
  for (const item of summary.now)
    now.append(
      el(
        "li",
        `${item.approximate ? "~" : ""}${tokenAmount(report, item.token, item.amount)}: ${item.label}`,
      ),
    );
  box.append(now);
  if (summary.pending.length > 0) {
    box.append(el("h3", "Not recoverable yet"));
    const ul = el("ul");
    for (const item of summary.pending)
      ul.append(el("li", `${tokenAmount(report, item.token, item.amount)}: ${item.label}`));
    box.append(ul);
  }
  if (!report.agentBankConfigured) {
    box.append(
      el(
        "p",
        "Escrows, streams and vaults were not checked: paste the Agent Bank deployments JSON above to include them.",
        "muted",
      ),
    );
  }
}

// ----------------------------------------------------------------------------------------------
// Plan, simulate, execute
// ----------------------------------------------------------------------------------------------

async function preview(kind: "withdraw" | "exit" | "revoke"): Promise<void> {
  const report = state.report;
  const client = state.client;
  if (!report || !client) throw new ExitToolError("invalid_argument", "Inspect the account first.");
  let plan: Plan;
  if (kind === "revoke") {
    plan = {
      command: "disable-modules",
      chainId: report.chain.id,
      account: report.account,
      steps: planRevoke(report),
      skipped: [],
    };
  } else {
    const to = addressField("to", "Destination");
    if (isAddressEqual(to, report.account))
      throw new ExitToolError("invalid_argument", "The destination is the account itself.");
    if (kind === "exit") {
      plan = planExit(report, { to, ...(state.wallet ? { signer: state.wallet } : {}) });
    } else {
      const tokenChoice = (input("token") as unknown as HTMLSelectElement).value;
      const all = input("all").checked;
      if (tokenChoice === "eth") {
        const amount = all ? "all" : parseAmount(input("amount").value, 18);
        plan = {
          command: "withdraw",
          chainId: report.chain.id,
          account: report.account,
          destination: to,
          steps: [planWithdrawStep(report, { to, token: "eth", amount })],
          skipped: [],
        };
      } else {
        const token =
          tokenChoice === "usdc" ? report.usdc?.address : addressField("custom-token", "Token address");
        if (!token) throw new ExitToolError("missing_config", "No USDC address: fill it in above.");
        const info = report.tokens[token.toLowerCase()] ?? (await readTokenInfo(client, token));
        report.tokens[token.toLowerCase()] = info;
        const amount = all ? "all" : parseAmount(input("amount").value, info.decimals);
        plan = {
          command: "withdraw",
          chainId: report.chain.id,
          account: report.account,
          destination: to,
          steps: [planWithdrawStep(report, { to, token, amount, symbol: info.symbol })],
          skipped: [],
        };
      }
    }
  }
  if (plan.steps.length === 0) {
    clear($("plan"));
    status("Nothing to do.", "ok");
    return;
  }
  const sim = await materializeAndSimulate(client, report, plan, {
    simulatedSigners: pickSimulationSigners(report, state.wallet),
    vaultSignatureTtl: 3_600n,
    tokens: Object.values(report.tokens).map((t) => t.address),
  });
  state.plan = plan;
  state.sim = sim;
  renderPlan(report, plan, sim);
  status(
    sim.ok
      ? "Simulated. Review every step, then sign and send."
      : "The simulation failed: nothing can be sent. See the failing step.",
    sim.ok ? "ok" : "error",
  );
}

function renderPlan(report: AccountReport, plan: Plan, sim: SimulationResult): void {
  const box = $("plan");
  clear(box);
  box.append(el("h2", `Plan: ${plan.command}${plan.destination ? ` to ${plan.destination}` : ""}`));
  const results = new Map(sim.results.map((r) => [r.index, r]));
  const ol = el("ol");
  for (const step of sim.steps) {
    const li = el("li");
    li.append(el("strong", step.title));
    const r = results.get(step.index);
    const statusText = step.skipped
      ? `skipped: ${step.skipped}`
      : r?.status === "success"
        ? `simulated OK (${r.gasUsed ?? 0n} gas)`
        : `SIMULATION FAILED: ${r?.error ?? "unknown"}`;
    li.append(
      el(
        "div",
        `${step.via === "safe" ? "Safe transaction you sign" : "public call"}; ${statusText}`,
        r?.status === "failure" ? "danger" : "muted",
      ),
    );
    if (step.amount !== undefined && step.moves)
      li.append(el("div", `amount: ${tokenAmount(report, step.moves.token, step.amount)}`));
    if (!step.skipped) {
      li.append(
        el(
          "code",
          step.vault
            ? `${step.call.to}.withdrawWithSignature(${step.vault.message.vaultId}, ${step.vault.message.amount}, …, <your signature>)`
            : `${step.call.to}.${describeCall(step.call)}`,
        ),
      );
      if (step.safeTxHash)
        li.append(el("div", `SafeTx nonce ${step.safeTx!.nonce}, hash ${step.safeTxHash}`, "muted"));
    }
    ol.append(li);
  }
  box.append(ol);
  if (sim.note) box.append(el("p", sim.note, "muted"));
  if (sim.balances?.after.destination && sim.balances.before.destination) {
    const before = sim.balances.before.destination;
    const gains = Object.entries(sim.balances.after.destination)
      .map(([k, v]) => [k, v - (before[k] ?? 0n)] as const)
      .filter(([, d]) => d > 0n)
      .map(([k, d]) => tokenAmount(report, k === "ETH" ? "ETH" : report.tokens[k]!.address, d));
    box.append(
      el("p", `Simulated result: the destination receives ${gains.length ? gains.join(", ") : "nothing"}.`),
    );
  }
  const pending = summarizeRecovery(report).pending;
  if (plan.command === "exit" && pending.length > 0) {
    box.append(
      el(
        "p",
        `Not recoverable yet: ${pending.map((p) => `${tokenAmount(report, p.token, p.amount)} (${p.label})`).join("; ")}`,
        "muted",
      ),
    );
  }
  const count = sim.steps.filter((s) => !s.skipped).length;
  const button = el("button", `Sign and send ${count} transaction${count === 1 ? "" : "s"}`);
  button.disabled = !sim.ok || !report.signer?.isOwner || report.safe.threshold > 1n;
  if (report.safe.threshold > 1n)
    box.append(
      el("p", "This Safe needs several owner signatures: use the CLI's --signer-only flow.", "danger"),
    );
  button.addEventListener("click", () => {
    // One run per preview: after sending, inspect and preview again for anything left.
    button.disabled = true;
    void guarded("Sending", execute);
  });
  box.append(button);
  box.append(el("div", "", "log"));
}

async function execute(): Promise<void> {
  const { report, plan, client, provider, viemChain, chain, wallet } = state;
  if (!report || !plan || !client || !provider || !viemChain || !chain || !wallet)
    throw new ExitToolError("invalid_argument", "Preview a plan first.");
  if (
    !window.confirm(
      `Send ${plan.steps.length} step(s) on ${chain.label}? Your wallet asks you to sign each Safe transaction and to send each transaction.`,
    )
  )
    return;
  const walletClient = createWalletClient({ chain: viemChain, transport: custom(provider) });
  const log = $("plan").querySelector(".log") as HTMLElement;
  const write = (text: string, href?: string): void => {
    const line = el("div", text);
    if (href) {
      line.append(" ");
      line.append(link(href, "view"));
    }
    log.append(line);
  };
  const onProgress = (e: ProgressEvent): void => {
    if (e.type === "start") write(`[${e.index}/${e.total}] ${e.title}`);
    else if (e.type === "skipped") write(`    skipped: ${e.reason}`);
    else if (e.type === "sent") write(`    sent ${e.hash}`, txUrl(chain, e.hash));
    else write(`    confirmed in block ${e.blockNumber}`);
  };
  const results: ExecutedStep[] = await executePlan(client, plan, {
    chainId: chain.id,
    account: report.account,
    owners: report.safe.owners,
    threshold: report.safe.threshold,
    signers: [
      {
        address: wallet,
        signTypedData: (typedData) =>
          walletClient.signTypedData({
            account: wallet,
            ...(typedData as unknown as Omit<Parameters<typeof walletClient.signTypedData>[0], "account">),
          }) as Promise<Hex>,
      },
    ],
    sender: {
      address: wallet,
      sendTransaction: (tx) =>
        walletClient.sendTransaction({
          account: wallet,
          chain: viemChain,
          to: tx.to,
          data: tx.data,
          value: tx.value,
          gas: tx.gas,
        }),
    },
    vaultSignatureTtl: 3_600n,
    onProgress,
  });
  const done = results.filter((r) => r.status === "confirmed").length;
  status(`Done: ${done} transaction(s) confirmed. Inspect again to see what is left.`, "ok");
}

// ----------------------------------------------------------------------------------------------
// Wiring
// ----------------------------------------------------------------------------------------------

function init(): void {
  $("version").textContent = `v${VERSION}`;
  $("connect").addEventListener("click", () => void guarded("Connecting", connect));
  $("switch").addEventListener("click", () => void guarded("Switching network", switchToBaseSepolia));
  $("inspect").addEventListener(
    "click",
    () => void guarded("Inspecting (reading the chain through your wallet)", inspect),
  );
  $("preview-withdraw").addEventListener(
    "click",
    () => void guarded("Planning and simulating", () => preview("withdraw")),
  );
  $("preview-exit").addEventListener(
    "click",
    () => void guarded("Planning and simulating", () => preview("exit")),
  );
  $("preview-revoke").addEventListener(
    "click",
    () => void guarded("Planning and simulating", () => preview("revoke")),
  );
  $("token").addEventListener("change", () => {
    $("custom-token-row").hidden = (input("token") as unknown as HTMLSelectElement).value !== "custom";
  });
  $("all").addEventListener("change", () => {
    input("amount").disabled = input("all").checked;
  });
  window.ethereum?.on?.("chainChanged", () => {
    state.client = undefined;
    state.report = undefined;
    status("The wallet switched networks: connect again.", "info");
  });
  status(
    window.ethereum
      ? "Connect your owner wallet to start."
      : "No browser wallet detected (open this page over http(s) with a wallet installed).",
    window.ethereum ? "info" : "error",
  );
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();
