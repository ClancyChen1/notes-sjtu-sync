import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { browserLogin, parseImportedCookie } from "../src/auth.js";
import { deleteSession, loadSession, saveSession, sessionFilePath } from "../src/session.js";

const previous = { path: process.env.PATH, xdg: process.env.XDG_CONFIG_HOME };
const temporary: string[] = [];

afterEach(async () => {
  process.env.PATH = previous.path;
  if (previous.xdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previous.xdg;
  delete process.env.TEST_SECRET_STORE;
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it("accepts a raw session value or Cookie header without exposing other cookies", () => {
  expect(parseImportedCookie("raw-value")).toBe("raw-value");
  expect(parseImportedCookie("s%3Asigned-value==")).toBe("s%3Asigned-value==");
  expect(parseImportedCookie("foo=bar; connect.sid=session-value; theme=dark")).toBe("session-value");
  expect(() => parseImportedCookie("foo=bar")).toThrowError(/connect\.sid/);
});

it.skipIf(process.platform !== "linux")("falls back to a user-only file when Secret Service is unavailable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "notes-sjtu-session-test-"));
  temporary.push(directory);
  process.env.XDG_CONFIG_HOME = directory;
  process.env.PATH = "";
  const saved = await saveSession("secret-cookie");
  expect(saved.backend).toBe("file");
  expect((await stat(sessionFilePath())).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(sessionFilePath(), "utf8"))).toMatchObject({ cookie: "secret-cookie" });
  expect((await loadSession())?.cookie).toBe("secret-cookie");
  await deleteSession();
  expect(await loadSession()).toBeUndefined();
});

it.skipIf(process.platform !== "linux")("uses Secret Service when secret-tool is available", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "notes-sjtu-keyring-test-"));
  temporary.push(directory);
  const script = path.join(directory, "secret-tool");
  const store = path.join(directory, "stored-secret");
  await writeFile(script, "#!/bin/sh\nif [ \"$1\" = store ]; then /bin/cat > \"$TEST_SECRET_STORE\"; else /bin/cat \"$TEST_SECRET_STORE\"; fi\n");
  await chmod(script, 0o755);
  process.env.PATH = directory;
  process.env.TEST_SECRET_STORE = store;
  const saved = await saveSession("keyring-cookie");
  expect(saved.backend).toBe("secret-service");
  expect((await loadSession())?.cookie).toBe("keyring-cookie");
  delete process.env.TEST_SECRET_STORE;
});

it("captures connect.sid through an isolated browser adapter", async () => {
  let visited = "";
  let captured = "";
  const session = await browserLogin(process.execPath, 1_000, {
    launch: async () => ({
      pages: () => [{
        goto: async (url) => { visited = url; },
        waitForTimeout: async () => undefined,
      }],
      newPage: async () => { throw new Error("unexpected new page"); },
      cookies: async () => [{ name: "connect.sid", value: "browser-cookie" }],
      close: async () => undefined,
    }),
    validate: async (cookie) => {
      captured = cookie;
      return { cookie, createdAt: "now", backend: "file" };
    },
  });
  expect(visited).toBe("https://notes.sjtu.edu.cn/auth/oauth2");
  expect(captured).toBe("browser-cookie");
  expect(session.cookie).toBe("browser-cookie");
});
