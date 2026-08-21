import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodimdClient } from "../src/client.js";
import { AppError } from "../src/errors.js";
import { diff, download, link, pull, push, status, unlink, upload } from "../src/sync.js";
import type { NoteReference, RemoteDocument } from "../src/types.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const temporary: string[] = [];

class FakeClient extends CodimdClient {
  readonly notes = new Map<string, string>();
  readonly images = new Map<string, Buffer>();
  next = 1;
  failUpdate = false;

  constructor() { super("test", 30_000, "http://127.0.0.1"); }

  override async createNote(markdown: string): Promise<NoteReference> {
    const id = `note-${this.next++}`;
    this.notes.set(id, markdown);
    return { id, url: `https://notes.sjtu.edu.cn/${id}` };
  }

  override async getNote(reference: NoteReference): Promise<RemoteDocument> {
    const markdown = this.notes.get(reference.id);
    if (markdown === undefined) throw new AppError("NOT_FOUND", "missing");
    return { reference, markdown, suggestedFilename: "Remote Note.md" };
  }

  override async updateNote(reference: NoteReference, markdown: string): Promise<void> {
    if (this.failUpdate) throw new AppError("SERVER", "simulated update failure");
    this.notes.set(reference.id, markdown);
  }

  override async uploadImage(bytes: Uint8Array): Promise<string> {
    const url = `https://notes.sjtu.edu.cn/uploads/image-${this.images.size + 1}.png`;
    this.images.set(url, Buffer.from(bytes));
    return url;
  }

  override async downloadImage(url: string): Promise<{ bytes: Buffer; mime: string }> {
    const bytes = this.images.get(url);
    if (!bytes) throw new Error(`missing image ${url}`);
    return { bytes, mime: "image/png" };
  }
}

async function workspace(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "notes-sjtu-sync-test-"));
  temporary.push(directory);
  return directory;
}

afterEach(async () => Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("single-document synchronization", () => {
  it("uploads images without rewriting local Markdown, then pushes and pulls changes", async () => {
    const directory = await workspace();
    const file = path.join(directory, "note.md");
    await writeFile(path.join(directory, "image.png"), PNG);
    await writeFile(file, "# Note\n\n![image](image.png)\n");
    const client = new FakeClient();

    const preflight = await upload(file, client, { dryRun: true });
    expect(preflight.dryRun).toBe(true);
    expect(client.notes.size).toBe(0);

    const created = await upload(file, client);
    const id = (created.note as NoteReference).id;
    expect(client.notes.get(id)).toContain("https://notes.sjtu.edu.cn/uploads/");
    expect(await readFile(file, "utf8")).toContain("](image.png)");
    expect((await status(file, client)).status).toBe("clean");

    await writeFile(file, "# Local edit\n\n![image](image.png)\n");
    expect((await status(file, client)).status).toBe("local_modified");
    await push(file, client);
    expect(client.notes.get(id)).toContain("# Local edit");

    client.notes.set(id, client.notes.get(id)!.replace("# Local edit", "# Remote edit"));
    expect((await status(file, client)).status).toBe("remote_modified");
    await pull(file, client);
    expect(await readFile(file, "utf8")).toContain("# Remote edit");
    expect(await readFile(file, "utf8")).toContain("](./image.png)");
  });

  it("creates a hidden conflict bundle without overwriting the Local Markdown", async () => {
    const directory = await workspace();
    const file = path.join(directory, "note.md");
    await writeFile(file, "base");
    const client = new FakeClient();
    const created = await upload(file, client);
    const id = (created.note as NoteReference).id;
    await writeFile(file, "local");
    client.notes.set(id, "remote");
    await expect(pull(file, client)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await readFile(file, "utf8")).toBe("local");
    const conflicts = path.join(directory, ".notes-sjtu-sync", "conflicts");
    expect(await import("node:fs/promises").then(({ readdir }) => readdir(conflicts))).toHaveLength(1);
  });

  it("downloads managed images into a stable local asset directory", async () => {
    const directory = await workspace();
    const file = path.join(directory, "downloaded.md");
    const client = new FakeClient();
    const reference = await client.createNote("![remote](https://notes.sjtu.edu.cn/uploads/original.png)");
    client.images.set("https://notes.sjtu.edu.cn/uploads/original.png", PNG);
    await download(reference.url, file, client);
    const markdown = await readFile(file, "utf8");
    expect(markdown).toMatch(/\.\/downloaded\.assets\/image-[a-f0-9]{12}\.png/);
    expect((await status(file, client)).status).toBe("clean");
  });

  it("requires a direction for different content and can unlink after the file moved", async () => {
    const directory = await workspace();
    const oldFile = path.join(directory, "old.md");
    const newFile = path.join(directory, "new.md");
    await writeFile(oldFile, "local");
    const client = new FakeClient();
    const reference = await client.createNote("remote");
    await expect(link(oldFile, reference.url, undefined, client)).rejects.toMatchObject({ code: "REFUSED" });
    const preview = await link(oldFile, reference.url, "pull", client, { dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect(await readFile(oldFile, "utf8")).toBe("local");
    await link(oldFile, reference.url, "pull", client);
    expect(await readFile(oldFile, "utf8")).toBe("remote");
    expect((await diff(oldFile, client)).localPatch).toBe("");
    await rename(oldFile, newFile);
    expect((await unlink(oldFile)).unlinked).toBe(true);
  });

  it("requires force for diverged content and makes the selected side authoritative", async () => {
    const directory = await workspace();
    const file = path.join(directory, "force.md");
    await writeFile(file, "base");
    const client = new FakeClient();
    const created = await upload(file, client);
    const id = (created.note as NoteReference).id;
    await writeFile(file, "local wins");
    client.notes.set(id, "remote loses");
    await expect(push(file, client, { dryRun: true })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(client.notes.get(id)).toBe("remote loses");
    await push(file, client, { force: true });
    expect(client.notes.get(id)).toBe("local wins");
    expect((await status(file, client)).status).toBe("clean");
  });

  it("reports missing local and remote sides without guessing a replacement", async () => {
    const directory = await workspace();
    const file = path.join(directory, "missing.md");
    await writeFile(file, "base");
    const client = new FakeClient();
    const created = await upload(file, client);
    const id = (created.note as NoteReference).id;
    await rm(file);
    expect((await status(file, client)).status).toBe("missing_local");
    await writeFile(file, "local after remote deletion");
    client.notes.delete(id);
    const missing = await status(file, client);
    expect(missing.status).toBe("remote_missing");
    expect(missing.localChanged).toBe(true);
    expect((await diff(file, client)).localPatch).toContain("local after remote deletion");
  });

  it("persists a successful image upload across a failed note update", async () => {
    const directory = await workspace();
    const file = path.join(directory, "retry.md");
    await writeFile(file, "base");
    await writeFile(path.join(directory, "retry.png"), PNG);
    const client = new FakeClient();
    await upload(file, client);
    await writeFile(file, "changed\n\n![retry](retry.png)\n");
    client.failUpdate = true;
    await expect(push(file, client)).rejects.toMatchObject({ code: "SERVER" });
    expect(client.images.size).toBe(1);
    client.failUpdate = false;
    await push(file, client);
    expect(client.images.size).toBe(1);
    expect((await status(file, client)).status).toBe("clean");
  });
});
