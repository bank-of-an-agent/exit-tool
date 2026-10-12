import { getAddress, isAddressEqual, keccak256, type Address, type Hex, type PublicClient } from "viem";

/**
 * Guardian recovery (contracts ADR 0002): Candide's audited SocialRecoveryModule v0.0.1, a plain Safe
 * module through which the principal's guardians can replace the owners after a fixed delay. It is
 * the owner's safety net, not an agent or bank power, so the exit tool keeps it unless asked to
 * remove it (`--include-recovery`).
 *
 * Deployed at the same addresses on every supported chain, one per delay. Runtime code hashes were
 * read on Base Sepolia (and match Ethereum Sepolia): a module is only recognised when both its
 * address and its code match, so no other contract can pass itself off as the recovery module.
 */
export const CANDIDE_RECOVERY_MODULES: readonly {
  address: Address;
  delaySeconds: bigint;
  label: string;
  codeHash: Hex;
}[] = [
  {
    address: "0x38275826E1933303E508433dD5f289315Da2541c",
    delaySeconds: 3n * 86_400n,
    label: "72 hours",
    codeHash: "0xdbebd5942589cb48bc55fd0d804e2a825ae485fa4eb771ec030e0ec4c330ae03",
  },
  {
    address: "0x088f6cfD8BB1dDb1BB069CCb3fc1A98927D233f2",
    delaySeconds: 7n * 86_400n,
    label: "7 days",
    codeHash: "0xd1d497d06956a300c318dd3df28e7cbaf64dc509bf9e8674753c4f69fd50746a",
  },
  {
    address: "0x9BacD92F4687Db306D7ded5d4513a51EA05df25b",
    delaySeconds: 14n * 86_400n,
    label: "14 days",
    codeHash: "0xf80b3e2f6c8149da85c8c40738b9d736f538bbf8f7d386c4318d13bd8f61b02e",
  },
  {
    address: "0x949d01d424bE050D09C16025dd007CB59b3A8c66",
    delaySeconds: 180n,
    label: "3 minutes (testing)",
    codeHash: "0x1a5e700fbb0533685dc9f9b28fc89bb496d480990e6c292f2abdd3e97485d245",
  },
];

/** The parts of SocialRecoveryModule v0.0.1 the tool reads (selectors checked against the deployed code). */
export const socialRecoveryModuleAbi = [
  { type: "function", name: "NAME", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "VERSION", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  {
    type: "function",
    name: "getGuardians",
    stateMutability: "view",
    inputs: [{ name: "wallet", type: "address" }],
    outputs: [{ type: "address[]" }],
  },
  {
    type: "function",
    name: "threshold",
    stateMutability: "view",
    inputs: [{ name: "wallet", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "nonce",
    stateMutability: "view",
    inputs: [{ name: "wallet", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getRecoveryRequest",
    stateMutability: "view",
    inputs: [{ name: "wallet", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "guardiansApprovalCount", type: "uint256" },
          { name: "newThreshold", type: "uint256" },
          { name: "executeAfter", type: "uint64" },
          { name: "newOwners", type: "address[]" },
        ],
      },
    ],
  },
  { type: "function", name: "cancelRecovery", stateMutability: "nonpayable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "addGuardianWithThreshold",
    stateMutability: "nonpayable",
    inputs: [
      { name: "guardian", type: "address" },
      { name: "threshold", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "confirmRecovery",
    stateMutability: "nonpayable",
    inputs: [
      { name: "wallet", type: "address" },
      { name: "newOwners", type: "address[]" },
      { name: "newThreshold", type: "uint256" },
      { name: "execute", type: "bool" },
    ],
    outputs: [],
  },
] as const;

export interface RecoveryState {
  module: Address;
  delayLabel: string;
  delaySeconds: bigint;
  guardians: Address[];
  threshold: bigint;
  /** A recovery that reached the guardian threshold and will replace the owners unless cancelled. */
  pending?: { newOwners: Address[]; newThreshold: bigint; executeAfter: bigint; approvals: bigint };
}

/** The known recovery module among `modules`, when its code is the audited deployment. */
export async function findRecoveryModule(client: PublicClient, modules: readonly Address[]) {
  for (const module of modules) {
    const known = CANDIDE_RECOVERY_MODULES.find((m) => isAddressEqual(m.address, module));
    if (!known) continue;
    const code = await client.getCode({ address: module });
    if (code && code !== "0x" && keccak256(code) === known.codeHash) return known;
  }
  return undefined;
}

/** Guardians, threshold and any pending recovery of `safe` in the recognised recovery module. */
export async function readRecoveryState(
  client: PublicClient,
  safe: Address,
  modules: readonly Address[],
  blockNumber?: bigint,
): Promise<RecoveryState | undefined> {
  const known = await findRecoveryModule(client, modules);
  if (!known) return undefined;
  const at = blockNumber !== undefined ? { blockNumber } : {};
  const [guardians, threshold, request] = await Promise.all([
    client.readContract({
      address: known.address,
      abi: socialRecoveryModuleAbi,
      functionName: "getGuardians",
      args: [safe],
      ...at,
    }),
    client.readContract({
      address: known.address,
      abi: socialRecoveryModuleAbi,
      functionName: "threshold",
      args: [safe],
      ...at,
    }),
    client.readContract({
      address: known.address,
      abi: socialRecoveryModuleAbi,
      functionName: "getRecoveryRequest",
      args: [safe],
      ...at,
    }),
  ]);
  const state: RecoveryState = {
    module: getAddress(known.address),
    delayLabel: known.label,
    delaySeconds: known.delaySeconds,
    guardians: guardians.map((g) => getAddress(g)),
    threshold,
  };
  if (request.executeAfter > 0n) {
    state.pending = {
      newOwners: request.newOwners.map((o) => getAddress(o)),
      newThreshold: request.newThreshold,
      executeAfter: BigInt(request.executeAfter),
      approvals: request.guardiansApprovalCount,
    };
  }
  return state;
}
