import { parseArgs } from "node:util";
import { getAddress, isAddress, type Address } from "viem";
import { ExitToolError } from "../core/errors";

export const COMMANDS = [
  "inspect",
  "withdraw",
  "disable-modules",
  "refund-escrows",
  "cancel-streams",
  "withdraw-vaults",
  "sweep-spend-keys",
  "exit",
  "submit",
  "help",
] as const;
export type Command = (typeof COMMANDS)[number];

const OPTIONS = {
  // connection and configuration
  "rpc-url": { type: "string" },
  chain: { type: "string" },
  account: { type: "string" },
  deployments: { type: "string" },
  usdc: { type: "string" },
  escrow: { type: "string" },
  streams: { type: "string" },
  vaults: { type: "string" },
  "fallback-handler": { type: "string" },
  "from-block": { type: "string" },
  discovery: { type: "string" },
  "max-log-requests": { type: "string" },
  "spend-key": { type: "string", multiple: true },
  json: { type: "boolean" },
  // keys and signing
  keystore: { type: "string" },
  "password-file": { type: "string" },
  "sender-keystore": { type: "string" },
  "sender-password-file": { type: "string" },
  "signer-only": { type: "boolean" },
  signer: { type: "string" },
  signature: { type: "string", multiple: true },
  "plan-file": { type: "string" },
  "vault-signature-ttl": { type: "string" },
  execute: { type: "boolean" },
  yes: { type: "boolean" },
  // command specific
  to: { type: "string" },
  token: { type: "string" },
  amount: { type: "string" },
  ids: { type: "string" },
  "keep-guard": { type: "boolean" },
  "include-recovery": { type: "boolean" },
  "unlocked-only": { type: "boolean" },
  "skip-spend-keys": { type: "boolean" },
  "extra-token": { type: "string", multiple: true },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

type OptionName = keyof typeof OPTIONS;

const GLOBAL: OptionName[] = [
  "rpc-url",
  "chain",
  "account",
  "deployments",
  "usdc",
  "escrow",
  "streams",
  "vaults",
  "fallback-handler",
  "from-block",
  "discovery",
  "max-log-requests",
  "spend-key",
  "json",
  "help",
  "version",
];
const SIGNING: OptionName[] = [
  "keystore",
  "password-file",
  "sender-keystore",
  "sender-password-file",
  "signer-only",
  "signer",
  "signature",
  "plan-file",
  "vault-signature-ttl",
  "execute",
  "yes",
];

const PER_COMMAND: Record<Command, OptionName[]> = {
  inspect: ["keystore", "signer"],
  withdraw: [...SIGNING, "to", "token", "amount"],
  "disable-modules": [...SIGNING, "keep-guard", "include-recovery"],
  "refund-escrows": [...SIGNING, "ids"],
  "cancel-streams": [...SIGNING, "ids"],
  "withdraw-vaults": [...SIGNING, "ids", "unlocked-only"],
  "sweep-spend-keys": [...SIGNING],
  exit: [
    ...SIGNING,
    "to",
    "keep-guard",
    "include-recovery",
    "unlocked-only",
    "skip-spend-keys",
    "extra-token",
  ],
  submit: [...SIGNING],
  help: [],
};

export type Values = {
  [K in OptionName]?: (typeof OPTIONS)[K] extends { multiple: true }
    ? string[]
    : (typeof OPTIONS)[K] extends { type: "boolean" }
      ? boolean
      : string;
};

export interface ParsedArgs {
  command: Command;
  values: Values;
}

/** Parses argv (without node and script). Unknown options, and options a command does not take, are errors. */
export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new ExitToolError("invalid_argument", err instanceof Error ? err.message : String(err), {
      hint: "Run `agentbank-exit help` for usage.",
    });
  }
  const values = parsed.values as Values;
  const [first, ...rest] = parsed.positionals;
  if (rest.length > 0) {
    throw new ExitToolError("invalid_argument", `Unexpected argument "${rest[0]}".`, {
      hint: "Run `agentbank-exit help`.",
    });
  }
  if (first === undefined) return { command: "help", values };
  if (!(COMMANDS as readonly string[]).includes(first)) {
    throw new ExitToolError("invalid_argument", `Unknown command "${first}".`, {
      hint: "Run `agentbank-exit help`.",
    });
  }
  const command = first as Command;
  const allowed = new Set<OptionName>([...GLOBAL, ...PER_COMMAND[command]]);
  for (const name of Object.keys(values) as OptionName[]) {
    if (!allowed.has(name)) {
      throw new ExitToolError("invalid_argument", `--${name} is not an option of "${command}".`, {
        hint: `Run \`agentbank-exit help\` for the options of each command.`,
      });
    }
  }
  return { command, values };
}

export function parseAddressOption(name: string, value: string | undefined): Address | undefined {
  if (value === undefined) return undefined;
  if (!isAddress(value, { strict: false })) {
    throw new ExitToolError(
      "invalid_argument",
      `--${name} must be an address (0x followed by 40 hex characters).`,
    );
  }
  // Mixed-case input must carry a valid checksum: a typo in a destination must not go unnoticed.
  if (
    value !== value.toLowerCase() &&
    value.slice(2) !== value.slice(2).toUpperCase() &&
    !isAddress(value, { strict: true })
  ) {
    throw new ExitToolError(
      "invalid_argument",
      `--${name} ${value} has an invalid checksum. Check the address.`,
    );
  }
  return getAddress(value);
}

export function parseIds(value: string | undefined): bigint[] | undefined {
  if (value === undefined) return undefined;
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new ExitToolError(
      "invalid_argument",
      "--ids must be a comma-separated list of ids, e.g. --ids 1,4,7.",
    );
  }
  return parts.map((p) => BigInt(p));
}

export function parseBigintOption(name: string, value: string | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value))
    throw new ExitToolError("invalid_argument", `--${name} must be a non-negative integer.`);
  return BigInt(value);
}

export const HELP = `agentbank-exit — withdraw everything from your Agent Bank account with only an RPC URL and your owner key.
No Agent Bank service is used: every action is a Safe transaction you sign (execTransaction), or a
public call that can only pay your account.

Usage: agentbank-exit <command> [options]

Commands
  inspect            Show owners, modules, fallback handler, guard, balances, escrows, streams,
                     vaults and spend-key floats, and what can be recovered now.
  withdraw           Send USDC, ETH or another ERC-20 from the account:
                       --to <address> --token usdc|eth|<erc20> --amount <decimal>|all
  disable-modules    Remove every Safe module (incl. the Safe7579 adapter), reset the fallback
                     handler to the plain CompatibilityFallbackHandler, remove the guard
                     (--keep-guard to keep it). Revokes every agent and bank power. The guardian
                     recovery module is kept unless --include-recovery.
  refund-escrows     Refund expired escrows the account paid into [--ids 1,2]
  cancel-streams     Cancel streams the account pays (the payee keeps what it earned) [--ids …]
  withdraw-vaults    Return time-lock vaults to the account; locked ones with your owner's
                     EIP-712 signature [--ids …] [--unlocked-only]
  sweep-spend-keys   Pull agent spend-key floats back with their permit allowance [--spend-key …]
  exit               All of the above in a safe order, then withdraw every token and all ETH:
                       --to <address> [--keep-guard] [--include-recovery] [--unlocked-only]
                       [--skip-spend-keys] [--extra-token <erc20>]…
  submit             Execute a --signer-only plan file with its signatures:
                       --plan-file <file> --signature <hex>… [--execute]

Connection
  --account <address>        The Safe account (required)
  --rpc-url <url>            JSON-RPC endpoint (default: the chain's public RPC)
  --chain base-sepolia|anvil Expected chain (default: detected from the RPC). Mainnet is refused.
  --deployments <file>       Agent Bank contract addresses (JSON). Or --escrow/--streams/--vaults,
                             --usdc, --fallback-handler, --from-block
  --discovery auto|events|enumerate   How escrows/streams/vaults are found (default auto)
  --max-log-requests <n>     eth_getLogs budget before falling back to enumeration (default 500)
  --spend-key <address>      Agent spend key to sweep (repeatable; others are found from events)
  --json                     Machine-readable output on stdout

Keys and execution (dry run by default: nothing is signed or sent)
  OWNER_PRIVATE_KEY=0x…      Owner key from the environment, or
  --keystore <file>          Encrypted JSON keystore (passphrase prompted, not echoed;
                             --password-file <file> for scripts)
  --execute                  Broadcast after an interactive confirmation (--yes to skip it)
  --signer-only              Hardware wallets: write the plan and the EIP-712 payloads to sign
                             (--plan-file <file>, --signer <owner address>); then run \`submit\`
                             (or the same command) with --signature <hex> for each payload
  SENDER_PRIVATE_KEY / --sender-keystore   Any funded key to send signed steps (submit)
  --vault-signature-ttl <s>  Validity of early-withdrawal signatures (default 86400 for
                             --signer-only, 3600 otherwise)

Examples
  agentbank-exit inspect --account 0xYourSafe
  agentbank-exit exit --account 0xYourSafe --to 0xYourColdWallet --deployments agentbank.json
  OWNER_PRIVATE_KEY=… agentbank-exit exit --account 0xYourSafe --to 0xYourColdWallet --execute
`;
