import { access, mkdtemp, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { SERVER_ORIGIN } from "./constants.js";
import { AppError } from "./errors.js";
import { CodimdClient } from "./client.js";
import { deleteSession, loadSession, saveSession, type StoredSession } from "./session.js";

interface BrowserPageAdapter {
  goto(url: string, options: { waitUntil: "domcontentloaded" }): Promise<unknown>;
  waitForTimeout(milliseconds: number): Promise<unknown>;
}

interface BrowserContextAdapter {
  pages(): BrowserPageAdapter[];
  newPage(): Promise<BrowserPageAdapter>;
  cookies(url: string): Promise<Array<{ name: string; value: string }>>;
  close(): Promise<unknown>;
}

export interface BrowserLoginDependencies {
  launch(profile: string, options: { executablePath: string; headless: false }): Promise<BrowserContextAdapter>;
  validate(cookie: string): Promise<StoredSession>;
}

export function parseImportedCookie(input: string): string {
  const trimmed = input.trim();
  const match = /(?:^|;\s*)connect\.sid=([^;\s]+)/.exec(trimmed);
  const looksLikeAnotherCookie = /^[A-Za-z0-9_.-]{1,64}=/.test(trimmed);
  const cookie = match?.[1] ?? (trimmed.includes(";") || looksLikeAnotherCookie ? "" : trimmed);
  if (!cookie || /[\r\n]/.test(cookie)) throw new AppError("AUTH_FAILED", "Input did not contain a valid connect.sid cookie.");
  return cookie;
}

export async function validateAndSaveSession(cookie: string): Promise<StoredSession> {
  await new CodimdClient(cookie).me();
  return saveSession(cookie);
}

export async function authenticationStatus(): Promise<{ authenticated: boolean; backend?: string; user?: Record<string, unknown> }> {
  const session = await loadSession();
  if (!session) return { authenticated: false };
  try {
    const user = await new CodimdClient(session.cookie).me();
    return { authenticated: true, backend: session.backend, user };
  } catch (error) {
    if (error instanceof AppError && ["AUTH_REQUIRED", "AUTH_FAILED"].includes(error.code)) {
      return { authenticated: false, backend: session.backend };
    }
    throw error;
  }
}

export async function requireSession(): Promise<StoredSession> {
  const session = await loadSession();
  if (!session) throw new AppError("AUTH_REQUIRED", "Run `notes-sjtu-sync auth login` or `auth import` first.");
  return session;
}

async function executable(candidate: string): Promise<string | undefined> {
  try {
    await access(candidate, fsConstants.X_OK);
    return candidate;
  } catch {
    return undefined;
  }
}

export async function findSystemBrowser(explicit?: string): Promise<string> {
  if (explicit) {
    const found = await executable(path.resolve(explicit));
    if (!found) throw new AppError("NOT_FOUND", `Browser executable not found: ${explicit}`);
    return found;
  }
  const names = process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ]
    : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
  for (const name of names) {
    if (path.isAbsolute(name)) {
      const found = await executable(name);
      if (found) return found;
    } else {
      for (const entry of pathEntries) {
        const found = await executable(path.join(entry, name));
        if (found) return found;
      }
    }
  }
  throw new AppError("NOT_FOUND", "No system Chrome or Chromium was found. Use `auth import` instead.");
}

export async function browserLogin(
  browserPath?: string,
  timeoutMs = 300_000,
  dependencies: BrowserLoginDependencies = {
    launch: (profile, options) => chromium.launchPersistentContext(profile, options),
    validate: validateAndSaveSession,
  },
): Promise<StoredSession> {
  const executablePath = await findSystemBrowser(browserPath);
  const profile = await mkdtemp(path.join(os.tmpdir(), "notes-sjtu-sync-browser-"));
  let context;
  try {
    context = await dependencies.launch(profile, { executablePath, headless: false });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`${SERVER_ORIGIN}/auth/oauth2`, { waitUntil: "domcontentloaded" });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const cookies = await context.cookies(SERVER_ORIGIN);
      const session = cookies.find((cookie) => cookie.name === "connect.sid" && cookie.value);
      if (session) return await dependencies.validate(session.value);
      await page.waitForTimeout(750);
    }
    throw new AppError("AUTH_FAILED", "Timed out waiting for SJTU OAuth login.");
  } finally {
    await context?.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function logout(): Promise<void> {
  await deleteSession();
}

export async function readSecretFromTty(): Promise<string> {
  if (!process.stdin.isTTY) throw new AppError("USAGE", "Use --stdin when standard input is not a TTY.");
  process.stderr.write("Paste connect.sid (input hidden), then press Enter: ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (): void => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
      process.stderr.write("\n");
    };
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 3) {
          finish();
          reject(new AppError("AUTH_FAILED", "Cookie import cancelled."));
          return;
        }
        if (byte === 13 || byte === 10) {
          finish();
          resolve(value);
          return;
        }
        if (byte === 127 || byte === 8) value = value.slice(0, -1);
        else value += String.fromCharCode(byte);
      }
    };
    process.stdin.on("data", onData);
  });
}
