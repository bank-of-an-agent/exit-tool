import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

export interface AnvilInstance {
  rpcUrl: string;
  port: number;
  /** How anvil was found (for logs). */
  source: string;
  stop(): Promise<void>;
  logs(): string;
}

/** A free TCP port on 127.0.0.1 (random, chosen by the OS). */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function works(command: string, args: string[]): boolean {
  const res = spawnSync(command, [...args, "--version"], { stdio: "ignore", timeout: 300_000 });
  return res.status === 0;
}

/**
 * How to run anvil here: $ANVIL_BIN, then `anvil` on PATH (CI installs it with
 * foundry-rs/foundry-toolchain), then `nix shell nixpkgs#foundry -c anvil`.
 */
export function findAnvil(): { command: string; prefix: string[]; source: string } | undefined {
  const fromEnv = process.env.ANVIL_BIN;
  if (fromEnv && works(fromEnv, [])) return { command: fromEnv, prefix: [], source: `ANVIL_BIN=${fromEnv}` };
  if (works("anvil", [])) return { command: "anvil", prefix: [], source: "anvil on PATH" };
  if (works("nix", ["shell", "nixpkgs#foundry", "-c", "anvil"])) {
    return {
      command: "nix",
      prefix: ["shell", "nixpkgs#foundry", "-c", "anvil"],
      source: "nix shell nixpkgs#foundry",
    };
  }
  return undefined;
}

async function rpcReady(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Starts a fresh anvil (on a random port unless one is given). Extra args are passed through. */
export async function startAnvil(extraArgs: string[] = [], fixedPort?: number): Promise<AnvilInstance> {
  const found = findAnvil();
  if (!found) throw new Error("anvil not found (set ANVIL_BIN, install Foundry, or have nix available)");
  const port = fixedPort ?? (await freePort());
  const args = [...found.prefix, "--host", "127.0.0.1", "--port", String(port), ...extraArgs];
  const child: ChildProcess = spawn(found.command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", (d: Buffer) => {
    output += d.toString();
    if (output.length > 200_000) output = output.slice(-100_000);
  });
  child.stderr?.on("data", (d: Buffer) => {
    output += d.toString();
  });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`anvil exited early (code ${child.exitCode}):\n${output}`);
    if (await rpcReady(rpcUrl)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!(await rpcReady(rpcUrl))) {
    child.kill("SIGKILL");
    throw new Error(`anvil did not start on ${rpcUrl}:\n${output}`);
  }
  return {
    rpcUrl,
    port,
    source: found.source,
    logs: () => output,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 3_000).unref();
      }),
  };
}
