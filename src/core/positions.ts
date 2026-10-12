import {
  AbiDecodingZeroDataError,
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  getAddress,
  isAddressEqual,
  type Address,
  type PublicClient,
} from "viem";
import { agentEscrowAbi, erc20Abi, paymentStreamsAbi, timeLockVaultsAbi } from "./abis/index";
import { mapLimit } from "./limit";

/** Parallel reads per batch of positions (public RPCs rate-limit bursts). */
const READ_CONCURRENCY = 6;

/** ERC-20 metadata (with safe fallbacks for tokens that do not implement the optional views). */
export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
}

/** True when a call failed because the contract does not implement the function (not a network error). */
function isMissingFunction(err: unknown): boolean {
  return (
    err instanceof BaseError &&
    Boolean(
      err.walk(
        (e) =>
          e instanceof ContractFunctionRevertedError ||
          e instanceof ContractFunctionZeroDataError ||
          e instanceof AbiDecodingZeroDataError,
      ),
    )
  );
}

export async function readTokenInfo(client: PublicClient, token: Address): Promise<TokenInfo> {
  const address = getAddress(token);
  // Optional views may be missing (fall back); network errors must surface, not turn into wrong decimals.
  const optional = <T>(p: Promise<T>): Promise<T | undefined> =>
    p.catch((err: unknown) => {
      if (isMissingFunction(err)) return undefined;
      throw err;
    });
  const [symbol, decimals] = await Promise.all([
    optional(client.readContract({ address, abi: erc20Abi, functionName: "symbol" })),
    optional(client.readContract({ address, abi: erc20Abi, functionName: "decimals" })),
  ]);
  return {
    address,
    symbol: symbol && symbol.length <= 32 ? symbol : `token ${address.slice(0, 8)}…`,
    // Unknown decimals: show raw units rather than guess.
    decimals: decimals ?? 0,
  };
}

export const ESCROW_STATUS = ["None", "Active", "Disputed", "Released", "Refunded", "Resolved"] as const;
export type EscrowStatus = (typeof ESCROW_STATUS)[number];

export interface EscrowPosition {
  id: bigint;
  /** The account's side: `payer` (it locked the funds) or `payee` (it is owed them). */
  role: "payer" | "payee";
  status: EscrowStatus;
  payer: Address;
  payee: Address;
  token: Address;
  amount: bigint;
  expiresAt: bigint;
  arbiter: Address;
  validator: Address;
  /** Earliest time anyone may refund the payer (0 when not refundable by third parties). */
  refundableAt: bigint;
  /** Payer side: anyone can refund it to the account now. */
  refundableNow: boolean;
  /** Payee side: anyone can release it to the account now (validator approved). */
  releasableNow: boolean;
}

export async function readEscrows(
  client: PublicClient,
  escrow: Address,
  ids: readonly bigint[],
  account: Address,
  now: bigint,
): Promise<EscrowPosition[]> {
  return mapLimit(ids, READ_CONCURRENCY, async (id) => {
    const [e, refundableAt] = await Promise.all([
      client.readContract({ address: escrow, abi: agentEscrowAbi, functionName: "getEscrow", args: [id] }),
      client.readContract({
        address: escrow,
        abi: agentEscrowAbi,
        functionName: "refundableAt",
        args: [id],
      }),
    ]);
    const status = ESCROW_STATUS[e.status] ?? "None";
    const open = status === "Active" || status === "Disputed";
    const role = isAddressEqual(e.payer, account) ? "payer" : "payee";
    let releasableNow = false;
    if (
      role === "payee" &&
      status === "Active" &&
      e.validator !== "0x0000000000000000000000000000000000000000"
    ) {
      const [satisfied] = await client
        .readContract({ address: escrow, abi: agentEscrowAbi, functionName: "checkValidation", args: [id] })
        .catch(() => [false] as const);
      releasableNow = satisfied;
    }
    return {
      id,
      role,
      status,
      payer: getAddress(e.payer),
      payee: getAddress(e.payee),
      token: getAddress(e.token),
      amount: e.amount,
      expiresAt: BigInt(e.expiresAt),
      arbiter: getAddress(e.arbiter),
      validator: getAddress(e.validator),
      refundableAt,
      refundableNow: role === "payer" && open && refundableAt !== 0n && now >= refundableAt,
      releasableNow,
    } satisfies EscrowPosition;
  });
}

export interface StreamPosition {
  id: bigint;
  role: "payer" | "payee";
  payer: Address;
  payee: Address;
  token: Address;
  deposit: bigint;
  paid: bigint;
  refunded: bigint;
  canceled: boolean;
  start: bigint;
  stop: bigint;
  interval: bigint;
  amountPerInterval: bigint;
  /** Accrued to the payee so far (paid or not), at the inspected block. */
  accrued: bigint;
  /** Accrued but not yet paid to the payee. */
  settleable: bigint;
  /** Payer side: what cancelling now would refund to the account (`deposit - accrued`). */
  refundIfCanceled: bigint;
}

export async function readStreams(
  client: PublicClient,
  streams: Address,
  ids: readonly bigint[],
  account: Address,
): Promise<StreamPosition[]> {
  return mapLimit(ids, READ_CONCURRENCY, async (id) => {
    const [s, accrued, settleable] = await Promise.all([
      client.readContract({
        address: streams,
        abi: paymentStreamsAbi,
        functionName: "getStream",
        args: [id],
      }),
      client.readContract({
        address: streams,
        abi: paymentStreamsAbi,
        functionName: "accrued",
        args: [id],
      }),
      client.readContract({
        address: streams,
        abi: paymentStreamsAbi,
        functionName: "settleable",
        args: [id],
      }),
    ]);
    const role = isAddressEqual(s.payer, account) ? "payer" : "payee";
    return {
      id,
      role,
      payer: getAddress(s.payer),
      payee: getAddress(s.payee),
      token: getAddress(s.token),
      deposit: s.deposit,
      paid: s.paid,
      refunded: s.refunded,
      canceled: s.canceled,
      start: BigInt(s.start),
      stop: BigInt(s.stop),
      interval: BigInt(s.interval),
      amountPerInterval: s.amountPerInterval,
      accrued,
      settleable,
      refundIfCanceled: role === "payer" && !s.canceled ? s.deposit - accrued : 0n,
    } satisfies StreamPosition;
  });
}

export interface VaultPosition {
  id: bigint;
  token: Address;
  balance: bigint;
  unlockAt: bigint;
  owner: Address;
  nonce: bigint;
  unlocked: boolean;
}

export async function readVaults(
  client: PublicClient,
  vaults: Address,
  ids: readonly bigint[],
  now: bigint,
): Promise<VaultPosition[]> {
  return mapLimit(ids, READ_CONCURRENCY, async (id) => {
    const v = await client.readContract({
      address: vaults,
      abi: timeLockVaultsAbi,
      functionName: "getVault",
      args: [id],
    });
    return {
      id,
      token: getAddress(v.token),
      balance: v.balance,
      unlockAt: BigInt(v.unlockAt),
      owner: getAddress(v.owner),
      nonce: BigInt(v.nonce),
      unlocked: now >= BigInt(v.unlockAt),
    } satisfies VaultPosition;
  });
}

/** An agent spend key's USDC float that the account can pull back (ADR 0001 permit allowance). */
export interface SpendKeyFloat {
  address: Address;
  token: Address;
  balance: bigint;
  allowance: bigint;
  /** `min(balance, allowance)`: what `transferFrom(spendKey, account, …)` can recover now. */
  sweepable: bigint;
}

export async function readSpendKeys(
  client: PublicClient,
  token: Address,
  keys: readonly Address[],
  account: Address,
): Promise<SpendKeyFloat[]> {
  return mapLimit(keys, READ_CONCURRENCY, async (key) => {
    const [balance, allowance] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [key] }),
      client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "allowance",
        args: [key, account],
      }),
    ]);
    return {
      address: getAddress(key),
      token: getAddress(token),
      balance,
      allowance,
      sweepable: balance < allowance ? balance : allowance,
    };
  });
}
