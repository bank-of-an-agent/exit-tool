import type { Abi } from "viem";
import { erc20Abi } from "./erc20";
import {
  agentEscrowAbi,
  agentPolicyHookAbi,
  paymentStreamsAbi,
  sweepExecutorAbi,
  timeLockVaultsAbi,
  topUpExecutorAbi,
} from "./generated/agentbank";
import { safeAbi } from "./safe";

export { erc20Abi, multicall3Abi } from "./erc20";
export {
  agentBankAbiSource,
  agentEscrowAbi,
  agentPolicyHookAbi,
  paymentStreamsAbi,
  sweepExecutorAbi,
  timeLockVaultsAbi,
  topUpExecutorAbi,
} from "./generated/agentbank";
export { SAFE_ERROR_CODES, safeAbi } from "./safe";

/** Every custom error the tool may meet, de-duplicated by signature, for decoding revert data. */
export const knownErrorsAbi: Abi = (() => {
  const seen = new Set<string>();
  const out: Abi[number][] = [];
  const all = [
    ...erc20Abi,
    ...safeAbi,
    ...agentEscrowAbi,
    ...paymentStreamsAbi,
    ...timeLockVaultsAbi,
    ...topUpExecutorAbi,
    ...sweepExecutorAbi,
    ...agentPolicyHookAbi,
  ] as Abi;
  for (const item of all) {
    if (item.type !== "error") continue;
    const key = `${item.name}(${item.inputs.map((i) => i.type).join(",")})`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
})();
