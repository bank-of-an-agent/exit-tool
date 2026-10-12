import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

/** Where the CLI reads and writes. Tests inject their own streams. */
export interface Io {
  stdout: Writable;
  stderr: Writable;
  stdin: Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  env: Record<string, string | undefined>;
  /** Whether stdin is an interactive terminal (confirmation and passphrase prompts need one). */
  interactive: boolean;
}

export function processIo(): Io {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env,
    interactive: Boolean(process.stdin.isTTY),
  };
}

export class Printer {
  constructor(
    private readonly io: Io,
    private readonly json: boolean,
  ) {}

  /** Human output (suppressed in --json mode, where only the final JSON document goes to stdout). */
  line(text = ""): void {
    if (!this.json) this.io.stdout.write(`${text}\n`);
  }

  /** Progress and warnings: stderr, so stdout stays clean for --json. */
  info(text: string): void {
    this.io.stderr.write(`${text}\n`);
  }

  /** The final machine-readable document in --json mode. */
  document(value: unknown): void {
    if (this.json) this.io.stdout.write(`${JSON.stringify(value, jsonReplacer, 2)}\n`);
  }

  get isJson(): boolean {
    return this.json;
  }
}

/** JSON.stringify replacer: bigints as decimal strings. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** Asks a yes/no question on the terminal; only an explicit "yes" confirms. */
export async function confirm(io: Io, question: string): Promise<boolean> {
  const rl = createInterface({ input: io.stdin, output: io.stderr, terminal: io.interactive });
  try {
    const answer = await rl.question(`${question} Type "yes" to continue: `);
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

/**
 * Reads a secret from the terminal without echoing it. Requires a TTY (use --password-file in
 * scripts).
 */
export async function promptHidden(io: Io, question: string): Promise<string> {
  const stdin = io.stdin;
  if (!io.interactive || typeof stdin.setRawMode !== "function") {
    throw new Error("cannot prompt for a passphrase: stdin is not a terminal (use --password-file)");
  }
  io.stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (err?: Error): void => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      io.stderr.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const ch of text) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish();
        if (ch === "\u0003") return finish(new Error("aborted"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}
