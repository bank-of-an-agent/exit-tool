/**
 * The parts of Safe v1.4.1 (and the SafeProxy) the exit tool uses. Signatures match the canonical
 * contracts (`@safe-global/safe-contracts@1.4.1`); the test suite checks every selector against the
 * full artifact ABI.
 */
export const safeAbi = [
  { type: "function", name: "VERSION", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  {
    type: "function",
    name: "getOwners",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
  {
    type: "function",
    name: "getThreshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "nonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "isOwner",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "isModuleEnabled",
    stateMutability: "view",
    inputs: [{ name: "module", type: "address" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "getModulesPaginated",
    stateMutability: "view",
    inputs: [
      { name: "start", type: "address" },
      { name: "pageSize", type: "uint256" },
    ],
    outputs: [
      { name: "array", type: "address[]" },
      { name: "next", type: "address" },
    ],
  },
  {
    type: "function",
    name: "getTransactionHash",
    stateMutability: "view",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "_nonce", type: "uint256" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "execTransaction",
    stateMutability: "payable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "signatures", type: "bytes" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
  {
    type: "function",
    name: "disableModule",
    stateMutability: "nonpayable",
    inputs: [
      { name: "prevModule", type: "address" },
      { name: "module", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setFallbackHandler",
    stateMutability: "nonpayable",
    inputs: [{ name: "handler", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setGuard",
    stateMutability: "nonpayable",
    inputs: [{ name: "guard", type: "address" }],
    outputs: [],
  },
  {
    type: "event",
    name: "ExecutionSuccess",
    inputs: [
      { name: "txHash", type: "bytes32", indexed: false },
      { name: "payment", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "ExecutionFailure",
    inputs: [
      { name: "txHash", type: "bytes32", indexed: false },
      { name: "payment", type: "uint256", indexed: false },
    ],
  },
  { type: "event", name: "DisabledModule", inputs: [{ name: "module", type: "address", indexed: true }] },
  {
    type: "event",
    name: "ChangedFallbackHandler",
    inputs: [{ name: "handler", type: "address", indexed: false }],
  },
  { type: "event", name: "ChangedGuard", inputs: [{ name: "guard", type: "address", indexed: false }] },
] as const;

/** Human explanations of Safe v1.4.1 `GSxxx` revert codes. */
export const SAFE_ERROR_CODES: Readonly<Record<string, string>> = {
  GS000: "Could not finish initialization",
  GS001: "Threshold needs to be defined",
  GS010: "Not enough gas to execute the Safe transaction",
  GS011: "Could not pay gas costs with ether",
  GS012: "Could not pay gas costs with token",
  GS013:
    "The Safe transaction's inner call failed (safeTxGas and gasPrice are 0, so the whole transaction reverts)",
  GS020: "Signatures data too short",
  GS021: "Invalid contract signature location: inside static part",
  GS022: "Invalid contract signature location: length not present",
  GS023: "Invalid contract signature location: data not complete",
  GS024: "Invalid contract signature provided",
  GS025: "Hash has not been approved",
  GS026:
    "Invalid owner provided (the signature does not come from an owner of this Safe, or signatures are not sorted)",
  GS030: "Only owners can approve a hash",
  GS031: "Method can only be called from this contract",
  GS100: "Modules have already been initialized",
  GS101: "Invalid module address provided",
  GS102: "Module has already been added",
  GS103: "Invalid prevModule, module pair provided",
  GS104: "Method can only be called from an enabled module",
  GS105: "Invalid starting point for fetching paginated modules",
  GS106: "Invalid page size for fetching paginated modules",
  GS200: "Owners have already been set up",
  GS201: "Threshold cannot exceed owner count",
  GS202: "Threshold needs to be greater than 0",
  GS203: "Invalid owner address provided",
  GS204: "Address is already an owner",
  GS205: "Invalid prevOwner, owner pair provided",
  GS300: "Guard does not implement IERC165",
  GS400: "Fallback handler cannot be set to self",
};
