import { getAddress, hashTypedData, isAddressEqual, type Address, type Hex, type PublicClient } from "viem";
import { timeLockVaultsAbi } from "./abis/index";
import { ExitToolError } from "./errors";

export const EARLY_WITHDRAWAL_TYPES = {
  EarlyWithdrawal: [
    { name: "vaultId", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface VaultDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

export interface EarlyWithdrawal {
  vaultId: bigint;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
}

/**
 * Reads the TimeLockVaults EIP-712 domain (ERC-5267) and checks it belongs to the connected chain and
 * to the vaults contract itself, so an RPC cannot get the owner to sign a message valid elsewhere
 * (for example on mainnet, where the vault addresses are the same).
 */
export async function readVaultDomain(
  client: PublicClient,
  vaults: Address,
  expectedChainId: number,
): Promise<VaultDomain> {
  const [, name, version, chainId, verifyingContract] = await client.readContract({
    address: vaults,
    abi: timeLockVaultsAbi,
    functionName: "eip712Domain",
  });
  const domain = {
    name,
    version,
    chainId: Number(chainId),
    verifyingContract: getAddress(verifyingContract),
  };
  if (domain.chainId !== expectedChainId || !isAddressEqual(domain.verifyingContract, vaults)) {
    throw new ExitToolError(
      "signature_mismatch",
      `TimeLockVaults ${vaults} reports an EIP-712 domain for chain ${domain.chainId} / ${domain.verifyingContract}, not chain ${expectedChainId} / ${vaults}. Refusing to sign.`,
    );
  }
  return domain;
}

export function earlyWithdrawalTypedData(domain: VaultDomain, message: EarlyWithdrawal) {
  return { domain, types: EARLY_WITHDRAWAL_TYPES, primaryType: "EarlyWithdrawal" as const, message };
}

/** JSON for `eth_signTypedData_v4` / `cast wallet sign --data` / hardware wallets. */
export function earlyWithdrawalTypedDataJson(domain: VaultDomain, message: EarlyWithdrawal) {
  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      EarlyWithdrawal: EARLY_WITHDRAWAL_TYPES.EarlyWithdrawal,
    },
    primaryType: "EarlyWithdrawal",
    domain,
    message: {
      vaultId: message.vaultId.toString(),
      amount: message.amount.toString(),
      nonce: message.nonce.toString(),
      deadline: message.deadline.toString(),
    },
  };
}

export function hashEarlyWithdrawal(domain: VaultDomain, message: EarlyWithdrawal): Hex {
  return hashTypedData(earlyWithdrawalTypedData(domain, message));
}

/**
 * Cross-checks the locally computed digest with the contract's own `earlyWithdrawalDigest` view, so a
 * domain or type mismatch is caught before anyone signs.
 */
export async function verifyEarlyWithdrawalDigest(
  client: PublicClient,
  domain: VaultDomain,
  message: EarlyWithdrawal,
): Promise<Hex> {
  const local = hashEarlyWithdrawal(domain, message);
  const onchain = await client.readContract({
    address: domain.verifyingContract,
    abi: timeLockVaultsAbi,
    functionName: "earlyWithdrawalDigest",
    args: [message.vaultId, message.amount, message.nonce, message.deadline],
  });
  if (onchain.toLowerCase() !== local.toLowerCase()) {
    throw new ExitToolError(
      "signature_mismatch",
      `EarlyWithdrawal digest mismatch for vault #${message.vaultId}: local ${local}, contract ${onchain}. Refusing to sign.`,
    );
  }
  return local;
}
