/** Stable error codes: scripts can branch on them (`--json` prints `{ "error": { "code", "message" } }`). */
export type ExitErrorCode =
  | "mainnet_refused"
  | "unsupported_chain"
  | "chain_mismatch"
  | "invalid_argument"
  | "not_deployed"
  | "not_a_safe"
  | "not_an_owner"
  | "missing_key"
  | "invalid_key"
  | "missing_config"
  | "simulation_failed"
  | "execution_failed"
  | "signature_mismatch"
  | "insufficient_gas_funds"
  | "plan_mismatch"
  | "rpc_error"
  | "aborted";

export class ExitToolError extends Error {
  readonly code: ExitErrorCode;
  readonly hint?: string;

  constructor(code: ExitErrorCode, message: string, options?: { hint?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ExitToolError";
    this.code = code;
    if (options?.hint !== undefined) this.hint = options.hint;
  }
}
