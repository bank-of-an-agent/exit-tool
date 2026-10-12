/**
 * Rhinestone OwnableValidator (ERC-7579 validator, `core-modules`): the parts the exit tool reads and
 * the owner-management functions `sync-owner` calls. It keeps one owner list and threshold per
 * account, keyed by `msg.sender`, so the account itself must make the changes. Selectors and error
 * selectors were checked against the deployed code on Base Sepolia (module release V1 and beta).
 */
export const ownableValidatorAbi = [
  {
    type: "function",
    name: "isInitialized",
    stateMutability: "view",
    inputs: [{ name: "smartAccount", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "getOwners",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "ownersArray", type: "address[]" }],
  },
  {
    type: "function",
    name: "threshold",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "ownerCount",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "addOwner",
    stateMutability: "nonpayable",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "removeOwner",
    stateMutability: "nonpayable",
    inputs: [
      { name: "prevOwner", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setThreshold",
    stateMutability: "nonpayable",
    inputs: [{ name: "_threshold", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "onInstall",
    stateMutability: "nonpayable",
    inputs: [{ name: "data", type: "bytes" }],
    outputs: [],
  },
  { type: "error", name: "NotInitialized", inputs: [{ name: "smartAccount", type: "address" }] },
  { type: "error", name: "ThresholdNotSet", inputs: [] },
  { type: "error", name: "InvalidThreshold", inputs: [] },
  { type: "error", name: "NotSortedAndUnique", inputs: [] },
  { type: "error", name: "MaxOwnersReached", inputs: [] },
  { type: "error", name: "InvalidOwner", inputs: [{ name: "owner", type: "address" }] },
  { type: "error", name: "CannotRemoveOwner", inputs: [] },
  { type: "error", name: "LinkedList_InvalidEntry", inputs: [{ name: "entry", type: "address" }] },
  { type: "error", name: "LinkedList_EntryAlreadyInList", inputs: [{ name: "entry", type: "address" }] },
  { type: "error", name: "LinkedList_InvalidPage", inputs: [] },
  { type: "error", name: "LinkedList_AlreadyInitialized", inputs: [] },
] as const;

/** Safe7579 adapter view, called on the account (the adapter answers as its fallback handler). */
export const safe7579ValidatorsAbi = [
  {
    type: "function",
    name: "getValidatorsPaginated",
    stateMutability: "view",
    inputs: [
      { name: "cursor", type: "address" },
      { name: "pageSize", type: "uint256" },
    ],
    outputs: [
      { name: "array", type: "address[]" },
      { name: "next", type: "address" },
    ],
  },
] as const;
