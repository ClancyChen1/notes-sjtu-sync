import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { getTracking, loadManifest, putTracking, removeTracking, stateLocation } from "../src/state.js";
import type { TrackingRecord } from "../src/types.js";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

function record(): TrackingRecord {
  return {
    remote: { id: "abc", url: "https://notes.sjtu.edu.cn/abc" },
    baseline: { logical: "hello", localText: "hello", remoteText: "hello", hash: "hash" },
    assets: {},
    pendingAssets: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

it("stores per-directory tracking state and adds an idempotent ignore rule", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "notes-sjtu-state-test-"));
  temporary.push(directory);
  const file = path.join(directory, "note.md");
  await writeFile(file, "hello");
  await putTracking(file, record());
  await putTracking(file, record());
  expect((await getTracking(file)).record.remote.id).toBe("abc");
  expect(await readFile(path.join(directory, ".gitignore"), "utf8")).toBe("/.notes-sjtu-sync/\n");
  expect((await loadManifest(stateLocation(file))).schemaVersion).toBe(1);
  expect(await removeTracking(file)).toBe(true);
  expect(await removeTracking(file)).toBe(false);
});

it("rejects unknown state schemas", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "notes-sjtu-state-test-"));
  temporary.push(directory);
  const file = path.join(directory, "note.md");
  const location = stateLocation(file);
  await writeFile(file, "hello");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(location.directory));
  await writeFile(location.manifestPath, JSON.stringify({ schemaVersion: 99, documents: {} }));
  await expect(loadManifest(location)).rejects.toMatchObject({ code: "INVALID_STATE" });
});
