import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

it("exposes version and stable unauthenticated JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "notes-sjtu-cli-test-"));
  temporary.push(directory);
  const cli = path.resolve("dist/cli.js");
  expect((await execFileAsync(process.execPath, [cli, "--version"])).stdout.trim()).toBe("0.1.0");
  const { stdout } = await execFileAsync(process.execPath, [cli, "--json", "auth", "status"], {
    env: { ...process.env, XDG_CONFIG_HOME: directory, PATH: "" },
  });
  expect(JSON.parse(stdout)).toMatchObject({ ok: true, command: "auth status", result: { authenticated: false } });
});

it("returns a structured usage error when --json is present", async () => {
  const cli = path.resolve("dist/cli.js");
  try {
    await execFileAsync(process.execPath, [cli, "--json", "unknown-command"]);
    throw new Error("command unexpectedly succeeded");
  } catch (error) {
    const failure = error as { code: number; stderr: string };
    expect(failure.code).toBe(2);
    expect(JSON.parse(failure.stderr)).toMatchObject({ ok: false, error: { code: "USAGE" } });
  }
});
