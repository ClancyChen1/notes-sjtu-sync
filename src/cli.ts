#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { AppError } from "./errors.js";
import { emitError, emitSuccess } from "./output.js";
import {
  authenticationStatus,
  browserLogin,
  logout,
  parseImportedCookie,
  readSecretFromTty,
  requireSession,
  validateAndSaveSession,
} from "./auth.js";
import { CodimdClient } from "./client.js";
import { diff, download, link, pull, push, status, unlink, upload } from "./sync.js";

const program = new Command();
let activeCommand = "notes-sjtu-sync";

program
  .name("notes-sjtu-sync")
  .description("Synchronize one Markdown file with SJTU Notes.")
  .version("0.1.0")
  .option("--json", "emit stable JSON output")
  .showHelpAfterError()
  .exitOverride();

program.configureOutput({
  writeErr: (text) => {
    if (!process.argv.includes("--json")) process.stderr.write(text);
  },
});

function jsonEnabled(): boolean {
  return Boolean(program.opts().json || process.argv.includes("--json"));
}

async function client(): Promise<CodimdClient> {
  const session = await requireSession();
  return new CodimdClient(session.cookie);
}

function commandAction(name: string, action: (...args: any[]) => Promise<void>): (...args: any[]) => Promise<void> {
  return async (...args: any[]): Promise<void> => {
    activeCommand = name;
    await action(...args);
  };
}

const auth = program.command("auth").description("Manage the SJTU Notes login session.");

auth.command("login")
  .description("Log in through a visible system Chrome or Chromium window.")
  .option("--browser <path>", "path to a system Chrome or Chromium executable")
  .action(commandAction("auth login", async (options: { browser?: string }) => {
    const session = await browserLogin(options.browser);
    emitSuccess("auth login", { authenticated: true, backend: session.backend },
      `Authenticated with SJTU Notes (${session.backend}).`, { json: jsonEnabled() });
  }));

auth.command("import")
  .description("Import connect.sid from a hidden prompt or standard input.")
  .option("--stdin", "read the cookie from standard input")
  .action(commandAction("auth import", async (options: { stdin?: boolean }) => {
    const input = options.stdin
      ? await new Promise<string>((resolve, reject) => {
          let value = "";
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", (chunk) => { value += chunk; });
          process.stdin.once("end", () => resolve(value));
          process.stdin.once("error", reject);
        })
      : await readSecretFromTty();
    const session = await validateAndSaveSession(parseImportedCookie(input));
    const warning = session.backend === "file" ? " The session is stored in a user-only 0600 file." : "";
    emitSuccess("auth import", { authenticated: true, backend: session.backend, warning: warning.trim() || undefined },
      `Authenticated with SJTU Notes (${session.backend}).${warning}`, { json: jsonEnabled() });
  }));

auth.command("status")
  .description("Check the saved session against SJTU Notes.")
  .action(commandAction("auth status", async () => {
    const result = await authenticationStatus();
    emitSuccess("auth status", result, result.authenticated ? `Authenticated (${result.backend}).` : "Not authenticated.", { json: jsonEnabled() });
  }));

auth.command("logout")
  .description("Delete the locally saved session.")
  .action(commandAction("auth logout", async () => {
    await logout();
    emitSuccess("auth logout", { authenticated: false }, "Local session deleted.", { json: jsonEnabled() });
  }));

program.command("upload")
  .description("Create a Remote Note from one Local Markdown.")
  .argument("<file.md>")
  .option("--no-track", "do not establish tracking")
  .option("--dry-run", "inspect without uploading or changing state")
  .action(commandAction("upload", async (file: string, options: { track: boolean; dryRun?: boolean }) => {
    const result = await upload(file, await client(), { track: options.track, dryRun: options.dryRun });
    emitSuccess("upload", result, options.dryRun ? "Upload preflight complete; nothing changed." : `Uploaded ${result.file as string}.`, { json: jsonEnabled() });
  }));

program.command("download")
  .description("Download one Remote Note to a new Local Markdown.")
  .argument("<url>")
  .argument("[file.md]")
  .option("--no-track", "do not establish tracking")
  .option("--dry-run", "inspect without downloading or changing state")
  .action(commandAction("download", async (url: string, file: string | undefined, options: { track: boolean; dryRun?: boolean }) => {
    const result = await download(url, file, await client(), { track: options.track, dryRun: options.dryRun });
    emitSuccess("download", result, options.dryRun ? "Download preflight complete; nothing changed." : `Downloaded to ${result.file as string}.`, { json: jsonEnabled() });
  }));

program.command("link")
  .description("Pair an existing Local Markdown with one Remote Note.")
  .argument("<file.md>")
  .argument("<url>")
  .option("--pull", "replace local content and establish the baseline")
  .option("--push", "replace remote content and establish the baseline")
  .option("--dry-run", "inspect without changing content or state")
  .action(commandAction("link", async (file: string, url: string, options: { pull?: boolean; push?: boolean; dryRun?: boolean }) => {
    if (options.pull && options.push) throw new AppError("USAGE", "Choose either --pull or --push, not both.");
    const direction = options.pull ? "pull" : options.push ? "push" : undefined;
    const result = await link(file, url, direction, await client(), { dryRun: options.dryRun });
    emitSuccess("link", result, options.dryRun ? "Link preflight complete; nothing changed." : `Tracking established for ${result.file as string}.`, { json: jsonEnabled() });
  }));

program.command("unlink")
  .description("Remove tracking without deleting local or remote content.")
  .argument("<file.md>")
  .action(commandAction("unlink", async (file: string) => {
    const result = await unlink(file);
    if (!result.unlinked) throw new AppError("NOT_TRACKED", `Not tracked: ${result.file}`);
    emitSuccess("unlink", result, `Tracking removed for ${result.file}.`, { json: jsonEnabled() });
  }));

program.command("pull")
  .description("Bring remote changes into one tracked Local Markdown.")
  .argument("<file.md>")
  .option("--force", "replace local content even when it changed")
  .option("--dry-run", "inspect without changing local content or state")
  .action(commandAction("pull", async (file: string, options: { force?: boolean; dryRun?: boolean }) => {
    const result = await pull(file, await client(), options);
    emitSuccess("pull", result, options.dryRun ? "Pull preflight complete; nothing changed." : result.changed ? `Pulled into ${result.file as string}.` : "Nothing to pull.", { json: jsonEnabled() });
  }));

program.command("push")
  .description("Send local changes from one tracked Markdown to its Remote Note.")
  .argument("<file.md>")
  .option("--force", "replace remote content even when it changed")
  .option("--dry-run", "inspect without changing remote content or state")
  .action(commandAction("push", async (file: string, options: { force?: boolean; dryRun?: boolean }) => {
    const result = await push(file, await client(), options);
    emitSuccess("push", result, options.dryRun ? "Push preflight complete; nothing changed." : result.changed ? `Pushed ${result.file as string}.` : "Nothing to push.", { json: jsonEnabled() });
  }));

program.command("status")
  .description("Compare one Local Markdown and Remote Note with their baseline.")
  .argument("<file.md>")
  .action(commandAction("status", async (file: string) => {
    const result = await status(file, await client());
    const publicResult = {
      status: result.status,
      localExists: result.localExists,
      localChanged: result.localChanged,
      remoteChanged: result.remoteChanged,
      ...(result.record ? { note: result.record.remote } : {}),
    };
    emitSuccess("status", publicResult, `Status: ${result.status}`, { json: jsonEnabled() });
  }));

program.command("diff")
  .description("Show baseline-to-local and baseline-to-remote differences.")
  .argument("<file.md>")
  .action(commandAction("diff", async (file: string) => {
    const result = await diff(file, await client());
    if (jsonEnabled()) emitSuccess("diff", result, "", { json: true });
    else {
      process.stdout.write(`Status: ${result.status}\n`);
      if (result.localPatch) process.stdout.write(`\nLocal changes:\n${result.localPatch}`);
      if (result.remotePatch) process.stdout.write(`\nRemote changes:\n${result.remotePatch}`);
      if (!result.localPatch && !result.remotePatch) process.stdout.write("No differences.\n");
    }
  }));

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) {
    process.exitCode = 0;
  } else {
    const normalized = error instanceof CommanderError ? new AppError("USAGE", error.message) : error;
    process.exitCode = emitError(normalized, jsonEnabled());
  }
}
