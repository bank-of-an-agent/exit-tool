import {
  decodeFunctionResult,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  hexToBigInt,
  isAddressEqual,
  numberToHex,
  pad,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { agentEscrowAbi, erc20Abi, multicall3Abi, paymentStreamsAbi, timeLockVaultsAbi } from "./abis/index";
import { MULTICALL3, SAFE_V141 } from "./constants";
import type { AgentBankContracts } from "./deployments";
import { ExitToolError } from "./errors";
import { describeError } from "./revert";

/** A raw `eth_getLogs` entry (only the fields the tool needs). */
export interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
}

export interface LogScanOptions {
  /** Most `eth_getLogs` requests one scan may make (public RPCs often cap ranges at a few hundred blocks). */
  maxRequests: number;
  /** Parallel requests once the RPC's range limit is known. */
  concurrency?: number;
}

export class LogScanBudgetExceeded extends ExitToolError {
  readonly blockRange: number;
  readonly requestsNeeded: number;

  constructor(blockRange: number, requestsNeeded: number, maxRequests: number) {
    super(
      "rpc_error",
      `The RPC limits eth_getLogs to ${blockRange} blocks per request; this scan would need about ${requestsNeeded} requests (budget ${maxRequests}).`,
    );
    this.blockRange = blockRange;
    this.requestsNeeded = requestsNeeded;
  }
}

interface LogFilter {
  address: Address | Address[];
  topics: (Hex | Hex[] | null)[];
}

const RANGE_HINTS = [
  /limited to (?:a )?(\d+)(?:[- ]block)? range/i,
  /block range (?:is )?(?:too large|exceeded)?[^\d]{0,40}(\d+)/i,
  /maximum (?:block )?range(?: of| is|:)? ?(\d+)/i,
  /range (?:should|must) (?:not )?(?:exceed|be less than|be at most) (\d+)/i,
  /up to (?:a )?(\d+) block range/i,
];

function parseRangeLimit(err: unknown): bigint | undefined {
  const text =
    err instanceof Error
      ? `${err.message} ${String((err as { details?: unknown }).details ?? "")}`
      : String(err);
  for (const re of RANGE_HINTS) {
    const m = re.exec(text);
    if (m?.[1]) {
      const n = BigInt(m[1]);
      if (n > 0n) return n;
    }
  }
  return undefined;
}

async function rawGetLogs(
  client: PublicClient,
  filter: LogFilter,
  from: bigint,
  to: bigint,
): Promise<RawLog[]> {
  const logs = (await client.request({
    method: "eth_getLogs",
    params: [
      {
        address: filter.address,
        topics: filter.topics,
        fromBlock: numberToHex(from),
        toBlock: numberToHex(to),
      },
    ],
  })) as { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex }[];
  return logs.map((l) => ({
    address: getAddress(l.address),
    topics: l.topics,
    data: l.data,
    blockNumber: hexToBigInt(l.blockNumber),
  }));
}

/**
 * `eth_getLogs` over `[from, to]`, working around per-request range limits: one request for the
 * whole range first; on failure, learn the limit (from the error text, or by halving), check the
 * request budget, then scan in parallel chunks (splitting any chunk the RPC still refuses).
 */
export async function scanLogs(
  client: PublicClient,
  filter: LogFilter,
  from: bigint,
  to: bigint,
  options: LogScanOptions,
): Promise<{ logs: RawLog[]; requests: number }> {
  if (to < from) return { logs: [], requests: 0 };
  let requests = 0;
  const attempt = async (a: bigint, b: bigint): Promise<RawLog[]> => {
    requests += 1;
    return rawGetLogs(client, filter, a, b);
  };

  let firstError: unknown;
  try {
    return { logs: await attempt(from, to), requests };
  } catch (err) {
    firstError = err;
  }

  // Learn the range the RPC accepts.
  let chunk = parseRangeLimit(firstError) ?? (to - from + 1n) / 2n;
  const head: RawLog[] = [];
  let probed = false;
  while (chunk >= 1n) {
    const end = from + chunk - 1n < to ? from + chunk - 1n : to;
    const needed = Number((to - from + chunk) / chunk);
    if (requests + needed > options.maxRequests) {
      throw new LogScanBudgetExceeded(Number(chunk), needed, options.maxRequests);
    }
    try {
      head.push(...(await attempt(from, end)));
      probed = true;
      break;
    } catch (err) {
      const hinted = parseRangeLimit(err);
      chunk = hinted !== undefined && hinted < chunk ? hinted : chunk / 2n;
    }
  }
  if (!probed) {
    throw new ExitToolError("rpc_error", "eth_getLogs failed even for a single block.", {
      cause: firstError,
    });
  }

  const ranges: [bigint, bigint][] = [];
  for (let start = from + chunk; start <= to; start += chunk) {
    ranges.push([start, start + chunk - 1n < to ? start + chunk - 1n : to]);
  }
  const results: RawLog[][] = new Array(ranges.length);
  const fetchRange = async (a: bigint, b: bigint, depth: number): Promise<RawLog[]> => {
    if (requests >= options.maxRequests) {
      throw new LogScanBudgetExceeded(Number(chunk), requests + ranges.length, options.maxRequests);
    }
    try {
      return await attempt(a, b);
    } catch (err) {
      if (a === b || depth > 16) throw err;
      const mid = a + (b - a) / 2n;
      return [...(await fetchRange(a, mid, depth + 1)), ...(await fetchRange(mid + 1n, b, depth + 1))];
    }
  };
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < ranges.length) {
      const i = next++;
      const [a, b] = ranges[i]!;
      results[i] = await fetchRange(a, b, 0);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 4) }, worker));
  return { logs: [...head, ...results.flat()], requests };
}

/**
 * First block at which `address` has code (Safe proxies never self-destruct, so presence of code is
 * monotonic). Needs an RPC that serves historical state; returns `undefined` if it does not.
 */
export async function findDeploymentBlock(
  client: PublicClient,
  address: Address,
  lo: bigint,
  hi: bigint,
): Promise<bigint | undefined> {
  const hasCode = async (block: bigint): Promise<boolean> => {
    const code = await client.getCode({ address, blockNumber: block });
    return code !== undefined && code !== "0x";
  };
  try {
    if (!(await hasCode(hi))) return undefined;
    if (await hasCode(lo)) return lo;
    // Some pruned nodes answer "no code" for old blocks instead of failing. Only trust the search if
    // the node shows a contract that certainly existed at `lo` (the canonical Safe singleton).
    const history = await client.getCode({ address: SAFE_V141.safeL2, blockNumber: lo });
    if (history === undefined || history === "0x") return undefined;
    let low = lo; // no code
    let high = hi; // code
    while (high - low > 1n) {
      const mid = low + (high - low) / 2n;
      if (await hasCode(mid)) high = mid;
      else low = mid;
    }
    return high;
  } catch {
    return undefined;
  }
}

/** Escrow, stream and vault ids that involve an account. */
export interface PositionIds {
  escrows: bigint[];
  streams: bigint[];
  vaults: bigint[];
  method: "events" | "enumeration";
  /** For `events`: the scanned block range. */
  fromBlock?: bigint;
  toBlock?: bigint;
  requests: number;
  notes: string[];
  /** Enumeration only: records that could not be read (positions may be missing). */
  failedReads: number;
}

export interface DiscoveryOptions {
  mode: "auto" | "events" | "enumerate";
  /** Where scans for INCOMING positions start (they may predate the account's deployment). */
  fromBlock: bigint;
  /**
   * Where scans for positions the account CREATED start: they need the account to exist, so its
   * deployment block is safe here. Defaults to `fromBlock`.
   */
  outgoingFromBlock?: bigint;
  toBlock: bigint;
  maxLogRequests: number;
  /** Use Multicall3 at its canonical address when it has code. */
  multicall?: boolean;
}

const uniqSorted = (ids: bigint[]): bigint[] =>
  [...new Set(ids.map((i) => i.toString()))]
    .map((s) => BigInt(s))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

async function discoverByEvents(
  client: PublicClient,
  account: Address,
  contracts: AgentBankContracts,
  options: DiscoveryOptions,
): Promise<PositionIds> {
  const accountTopic = pad(account, { size: 32 }).toLowerCase() as Hex;
  const locked = encodeEventTopics({ abi: agentEscrowAbi, eventName: "Locked" })[0];
  const streamCreated = encodeEventTopics({ abi: paymentStreamsAbi, eventName: "StreamCreated" })[0];
  const vaultCreated = encodeEventTopics({ abi: timeLockVaultsAbi, eventName: "VaultCreated" })[0];

  const asPayer: { address: Address; topic: Hex }[] = [];
  if (contracts.escrow) asPayer.push({ address: contracts.escrow, topic: locked });
  if (contracts.streams) asPayer.push({ address: contracts.streams, topic: streamCreated });
  if (contracts.vaults) asPayer.push({ address: contracts.vaults, topic: vaultCreated });
  const asPayee = asPayer.filter((c) => c.topic !== vaultCreated);

  let requests = 0;
  const logs: RawLog[] = [];
  const budget = (): number => options.maxLogRequests - requests;
  if (asPayer.length > 0) {
    // Locked / StreamCreated: topic2 = payer; VaultCreated: topic2 = parent account.
    const res = await scanLogs(
      client,
      { address: asPayer.map((c) => c.address), topics: [asPayer.map((c) => c.topic), null, accountTopic] },
      options.outgoingFromBlock ?? options.fromBlock,
      options.toBlock,
      { maxRequests: budget() },
    );
    requests += res.requests;
    logs.push(...res.logs);
  }
  if (asPayee.length > 0) {
    // Locked / StreamCreated: topic3 = payee.
    const res = await scanLogs(
      client,
      {
        address: asPayee.map((c) => c.address),
        topics: [asPayee.map((c) => c.topic), null, null, accountTopic],
      },
      options.fromBlock,
      options.toBlock,
      { maxRequests: budget() },
    );
    requests += res.requests;
    logs.push(...res.logs);
  }

  const ids = { escrows: [] as bigint[], streams: [] as bigint[], vaults: [] as bigint[] };
  for (const log of logs) {
    const id = log.topics[1] ? hexToBigInt(log.topics[1]) : undefined;
    if (id === undefined) continue;
    if (contracts.escrow && isAddressEqual(log.address, contracts.escrow) && log.topics[0] === locked)
      ids.escrows.push(id);
    if (
      contracts.streams &&
      isAddressEqual(log.address, contracts.streams) &&
      log.topics[0] === streamCreated
    ) {
      ids.streams.push(id);
    }
    if (contracts.vaults && isAddressEqual(log.address, contracts.vaults) && log.topics[0] === vaultCreated)
      ids.vaults.push(id);
  }
  return {
    escrows: uniqSorted(ids.escrows),
    streams: uniqSorted(ids.streams),
    vaults: uniqSorted(ids.vaults),
    method: "events",
    fromBlock: options.fromBlock,
    toBlock: options.toBlock,
    requests,
    notes: [],
    failedReads: 0,
  };
}

/** Batched `eth_call`s: Multicall3 when available, otherwise a small pool of parallel calls. */
async function batchCall(
  client: PublicClient,
  calls: { to: Address; data: Hex }[],
  useMulticall: boolean,
  blockNumber: bigint,
): Promise<(Hex | undefined)[]> {
  if (useMulticall) {
    const out: (Hex | undefined)[] = [];
    for (let i = 0; i < calls.length; i += 250) {
      const slice = calls.slice(i, i + 250);
      const data = encodeFunctionData({
        abi: multicall3Abi,
        functionName: "aggregate3",
        args: [slice.map((c) => ({ target: c.to, allowFailure: true, callData: c.data }))],
      });
      const res = await client.call({ to: MULTICALL3, data, blockNumber });
      const decoded = decodeFunctionResult({
        abi: multicall3Abi,
        functionName: "aggregate3",
        data: res.data ?? "0x",
      });
      for (const r of decoded) out.push(r.success ? r.returnData : undefined);
    }
    return out;
  }
  const out: (Hex | undefined)[] = new Array(calls.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < calls.length) {
      const i = next++;
      const c = calls[i]!;
      try {
        out[i] = (await client.call({ to: c.to, data: c.data, blockNumber })).data;
      } catch {
        out[i] = undefined;
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return out;
}

async function discoverByEnumeration(
  client: PublicClient,
  account: Address,
  contracts: AgentBankContracts,
  options: DiscoveryOptions,
): Promise<PositionIds> {
  const multicallCode =
    options.multicall === false ? undefined : await client.getCode({ address: MULTICALL3 });
  const useMulticall = multicallCode !== undefined && multicallCode !== "0x";
  const blockNumber = options.toBlock;
  const result: PositionIds = {
    escrows: [],
    streams: [],
    vaults: [],
    method: "enumeration",
    requests: 0,
    notes: [],
    failedReads: 0,
  };
  const range = (n: bigint): bigint[] => Array.from({ length: Number(n) }, (_, i) => BigInt(i + 1));

  if (contracts.escrow) {
    const escrow = contracts.escrow;
    const count = await client.readContract({
      address: escrow,
      abi: agentEscrowAbi,
      functionName: "escrowCount",
      blockNumber,
    });
    const ids = range(count);
    const data = await batchCall(
      client,
      ids.map((id) => ({
        to: escrow,
        data: encodeFunctionData({ abi: agentEscrowAbi, functionName: "getEscrow", args: [id] }),
      })),
      useMulticall,
      blockNumber,
    );
    ids.forEach((id, i) => {
      const raw = data[i];
      if (!raw) {
        result.failedReads += 1;
        return;
      }
      const e = decodeFunctionResult({ abi: agentEscrowAbi, functionName: "getEscrow", data: raw });
      if (isAddressEqual(e.payer, account) || isAddressEqual(e.payee, account)) result.escrows.push(id);
    });
    result.notes.push(`enumerated ${count} escrows`);
  }
  if (contracts.streams) {
    const streams = contracts.streams;
    const count = await client.readContract({
      address: streams,
      abi: paymentStreamsAbi,
      functionName: "streamCount",
      blockNumber,
    });
    const ids = range(count);
    const data = await batchCall(
      client,
      ids.map((id) => ({
        to: streams,
        data: encodeFunctionData({ abi: paymentStreamsAbi, functionName: "getStream", args: [id] }),
      })),
      useMulticall,
      blockNumber,
    );
    ids.forEach((id, i) => {
      const raw = data[i];
      if (!raw) {
        result.failedReads += 1;
        return;
      }
      const s = decodeFunctionResult({ abi: paymentStreamsAbi, functionName: "getStream", data: raw });
      if (isAddressEqual(s.payer, account) || isAddressEqual(s.payee, account)) result.streams.push(id);
    });
    result.notes.push(`enumerated ${count} streams`);
  }
  if (contracts.vaults) {
    const vaults = contracts.vaults;
    const count = await client.readContract({
      address: vaults,
      abi: timeLockVaultsAbi,
      functionName: "vaultCount",
      blockNumber,
    });
    const ids = range(count);
    const data = await batchCall(
      client,
      ids.map((id) => ({
        to: vaults,
        data: encodeFunctionData({ abi: timeLockVaultsAbi, functionName: "vaultAccount", args: [id] }),
      })),
      useMulticall,
      blockNumber,
    );
    ids.forEach((id, i) => {
      const raw = data[i];
      if (!raw) {
        result.failedReads += 1;
        return;
      }
      const parent = decodeFunctionResult({
        abi: timeLockVaultsAbi,
        functionName: "vaultAccount",
        data: raw,
      });
      if (isAddressEqual(parent, account)) result.vaults.push(id);
    });
    result.notes.push(`enumerated ${count} vaults`);
  }
  result.notes.push(
    useMulticall ? "via Multicall3" : "via individual eth_calls (no Multicall3 on this chain)",
  );
  return result;
}

/**
 * Finds every escrow, stream and vault involving `account`: from contract events when the RPC can
 * serve them within the request budget, otherwise by enumerating the contracts' records (which
 * works on any RPC, at a cost proportional to the total number of records).
 */
export async function discoverPositionIds(
  client: PublicClient,
  account: Address,
  contracts: AgentBankContracts,
  options: DiscoveryOptions,
): Promise<PositionIds> {
  if (!contracts.escrow && !contracts.streams && !contracts.vaults) {
    return {
      escrows: [],
      streams: [],
      vaults: [],
      method: "events",
      requests: 0,
      notes: ["no Agent Bank contracts configured"],
      failedReads: 0,
    };
  }
  if (options.mode === "enumerate") return discoverByEnumeration(client, account, contracts, options);
  try {
    return await discoverByEvents(client, account, contracts, options);
  } catch (err) {
    if (options.mode === "events") throw err;
    const fallback = await discoverByEnumeration(client, account, contracts, options);
    const reason = describeError(err);
    fallback.notes.unshift(`event scan not used (${reason})`);
    return fallback;
  }
}

/** Addresses that granted `account` a USDC allowance (agent spend keys, per ADR 0001). */
export interface SpendKeyDiscovery {
  candidates: Address[];
  complete: boolean;
  note?: string;
  requests: number;
}

/**
 * Agent spend keys sign an EIP-2612 permit to the parent account at provisioning (contracts ADR
 * 0001), which emits `Approval(spendKey, account, value)`. Scans those events within the request
 * budget; there is no enumeration fallback, so an incomplete scan is reported.
 */
export async function discoverSpendKeys(
  client: PublicClient,
  usdc: Address,
  account: Address,
  options: { fromBlock: bigint; toBlock: bigint; maxLogRequests: number },
): Promise<SpendKeyDiscovery> {
  const approval = encodeEventTopics({ abi: erc20Abi, eventName: "Approval" })[0];
  try {
    const { logs, requests } = await scanLogs(
      client,
      { address: usdc, topics: [approval, null, pad(account, { size: 32 }).toLowerCase() as Hex] },
      options.fromBlock,
      options.toBlock,
      { maxRequests: options.maxLogRequests },
    );
    const owners = new Map<string, Address>();
    for (const log of logs) {
      const topic = log.topics[1];
      if (!topic) continue;
      const owner = getAddress(`0x${topic.slice(26)}`);
      owners.set(owner.toLowerCase(), owner);
    }
    return { candidates: [...owners.values()], complete: true, requests };
  } catch (err) {
    const reason = describeError(err);
    return {
      candidates: [],
      complete: false,
      note: `spend-key discovery skipped: ${reason} Pass --spend-key <address> for each agent spend key.`,
      requests: 0,
    };
  }
}
