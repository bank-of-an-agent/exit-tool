import {
  concatHex,
  decodeFunctionData,
  encodeFunctionData,
  encodePacked,
  getAddress,
  hexToBigInt,
  isAddressEqual,
  keccak256,
  size,
  slice,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { SAFE_V141 } from "./constants";
import type { Call } from "./safe";

/** Canonical Safe v1.4.1 MultiSendCallOnly: batches CALLs, can never DELEGATECALL. */
export const MULTISEND_CALL_ONLY: Address = SAFE_V141.multiSendCallOnly;

/**
 * keccak256 of its runtime code, identical on every chain (verified on Base Sepolia and in
 * `@safe-global/safe-deployments`). The tool only delegatecalls an address whose code matches.
 */
export const MULTISEND_CALL_ONLY_CODEHASH: Hex =
  "0xecd5bd14a08c5d2122379900b2f272bdf107a7e92423c10dd5fe3254386c9939";

export const multiSendAbi = [
  {
    type: "function",
    name: "multiSend",
    stateMutability: "payable",
    inputs: [{ name: "transactions", type: "bytes" }],
    outputs: [],
  },
] as const;

/** `multiSend(transactions)` calldata for CALLs (operation 0 each, packed as MultiSend expects). */
export function encodeMultiSend(calls: readonly Call[]): Hex {
  const packed = concatHex(
    calls.map((c) =>
      encodePacked(
        ["uint8", "address", "uint256", "uint256", "bytes"],
        [0, getAddress(c.to), c.value, BigInt(size(c.data)), c.data],
      ),
    ),
  );
  return encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [packed] });
}

/** The CALLs inside `multiSend` calldata, or `undefined` if it is malformed or contains a DELEGATECALL. */
export function decodeMultiSend(data: Hex): Call[] | undefined {
  let packed: Hex;
  try {
    const decoded = decodeFunctionData({ abi: multiSendAbi, data });
    packed = decoded.args[0];
  } catch {
    return undefined;
  }
  const calls: Call[] = [];
  const total = size(packed);
  let offset = 0;
  while (offset < total) {
    if (offset + 85 > total) return undefined;
    const operation = Number(hexToBigInt(slice(packed, offset, offset + 1)));
    if (operation !== 0) return undefined;
    const to = getAddress(slice(packed, offset + 1, offset + 21));
    const value = hexToBigInt(slice(packed, offset + 21, offset + 53));
    const length = Number(hexToBigInt(slice(packed, offset + 53, offset + 85)));
    if (offset + 85 + length > total) return undefined;
    const callData: Hex = length === 0 ? "0x" : slice(packed, offset + 85, offset + 85 + length);
    calls.push({ to, value, data: callData });
    offset += 85 + length;
  }
  return calls.length > 0 ? calls : undefined;
}

/** Whether `address` holds exactly the canonical MultiSendCallOnly code on this chain. */
export async function isCanonicalMultiSendCallOnly(
  client: PublicClient,
  address: Address = MULTISEND_CALL_ONLY,
) {
  if (!isAddressEqual(address, MULTISEND_CALL_ONLY)) return false;
  const code = await client.getCode({ address });
  return code !== undefined && code !== "0x" && keccak256(code) === MULTISEND_CALL_ONLY_CODEHASH;
}
