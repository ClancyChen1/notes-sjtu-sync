import { access, chmod, mkdir, readFile, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { SESSION_ACCOUNT, SESSION_SERVICE } from "./constants.js";
import { atomicWrite, pathExists } from "./fs-utils.js";

const execFileAsync = promisify(execFile);

export interface StoredSession {
  cookie: string;
  createdAt: string;
  backend: "keychain" | "secret-service" | "file";
}

function configDirectory(): string {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", SESSION_SERVICE);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), SESSION_SERVICE);
}

export function sessionFilePath(): string {
  return path.join(configDirectory(), "session.json");
}

async function executableExists(command: string): Promise<boolean> {
  const paths = (process.env.PATH ?? "").split(path.delimiter);
  for (const entry of paths) {
    try {
      await access(path.join(entry, command), fsConstants.X_OK);
      return true;
    } catch {
      // Continue searching PATH.
    }
  }
  return false;
}

async function writeToProcess(command: string, args: string[], input: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
    child.stdin.end(input);
  });
}

async function saveKeychain(cookie: string): Promise<StoredSession["backend"] | undefined> {
  try {
    if (process.platform === "darwin") {
      await execFileAsync("security", ["add-generic-password", "-U", "-s", SESSION_SERVICE, "-a", SESSION_ACCOUNT, "-w", cookie]);
      return "keychain";
    }
    if (process.platform === "linux" && await executableExists("secret-tool")) {
      await writeToProcess("secret-tool", ["store", "--label=SJTU Notes Sync", "service", SESSION_SERVICE, "account", SESSION_ACCOUNT], cookie);
      return "secret-service";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function loadKeychain(): Promise<StoredSession | undefined> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", SESSION_SERVICE, "-a", SESSION_ACCOUNT, "-w"]);
      const cookie = stdout.trim();
      if (cookie) return { cookie, createdAt: "unknown", backend: "keychain" };
    }
    if (process.platform === "linux" && await executableExists("secret-tool")) {
      const { stdout } = await execFileAsync("secret-tool", ["lookup", "service", SESSION_SERVICE, "account", SESSION_ACCOUNT]);
      const cookie = stdout.trim();
      if (cookie) return { cookie, createdAt: "unknown", backend: "secret-service" };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function saveSession(cookie: string): Promise<StoredSession> {
  const backend = await saveKeychain(cookie);
  const createdAt = new Date().toISOString();
  if (backend) {
    await rm(sessionFilePath(), { force: true }).catch(() => undefined);
    return { cookie, createdAt, backend };
  }
  const target = sessionFilePath();
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await atomicWrite(target, `${JSON.stringify({ cookie, createdAt })}\n`, 0o600);
  await chmod(target, 0o600);
  return { cookie, createdAt, backend: "file" };
}

export async function loadSession(): Promise<StoredSession | undefined> {
  const keychain = await loadKeychain();
  if (keychain) return keychain;
  const target = sessionFilePath();
  if (!(await pathExists(target))) return undefined;
  try {
    const parsed = JSON.parse(await readFile(target, "utf8")) as { cookie?: unknown; createdAt?: unknown };
    if (typeof parsed.cookie !== "string" || !parsed.cookie) return undefined;
    return { cookie: parsed.cookie, createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "unknown", backend: "file" };
  } catch {
    return undefined;
  }
}

export async function deleteSession(): Promise<void> {
  await rm(sessionFilePath(), { force: true });
  try {
    if (process.platform === "darwin") {
      await execFileAsync("security", ["delete-generic-password", "-s", SESSION_SERVICE, "-a", SESSION_ACCOUNT]);
    } else if (process.platform === "linux" && await executableExists("secret-tool")) {
      await execFileAsync("secret-tool", ["clear", "service", SESSION_SERVICE, "account", SESSION_ACCOUNT]);
    }
  } catch {
    // Missing keychain entries already mean logged out.
  }
}
