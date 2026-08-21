import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findImageReferences,
  isLocalImageReference,
  loadLocalAsset,
  localLogicalMarkdown,
  replaceImageReferences,
} from "../src/assets.js";

const temporary: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "notes-sjtu-assets-test-"));
  temporary.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("image reference discovery", () => {
  it("finds CodiMD Markdown and HTML image targets without treating CSS or code as assets", () => {
    const markdown = [
      "![inline](./a.png \"title\" =200x100)",
      "![reference][logo]",
      "[logo]: <./logo.svg> \"Logo\"",
      "<img alt='x' src=\"./html.gif\">",
      "`![code](./ignored.png)`",
      "\\![escaped](./ignored-escaped.png)",
      "\\<img src='./ignored-escaped-html.png'>",
      "```md",
      "![fenced](./ignored-2.png)",
      "```",
      "<style>.x { background: url(./ignored.css.png); }</style>",
      "<!-- <img src='./comment.png'> -->",
    ].join("\n");

    expect(findImageReferences(markdown).map((reference) => reference.value)).toEqual([
      "./a.png",
      "./logo.svg",
      "./html.gif",
    ]);
  });

  it("replaces only destination bytes", () => {
    const markdown = "before ![alt](./image.png =20x30) after";
    const reference = findImageReferences(markdown)[0];
    const result = replaceImageReferences(markdown, new Map([[reference.start, "https://example.test/image.png"]]));
    expect(result).toBe("before ![alt](https://example.test/image.png =20x30) after");
  });

  it("classifies local paths conservatively", () => {
    expect(isLocalImageReference("./asset.png")).toBe(true);
    expect(isLocalImageReference("assets/a.png")).toBe(true);
    expect(isLocalImageReference("https://example.test/a.png")).toBe(false);
    expect(isLocalImageReference("data:image/png;base64,abc")).toBe(false);
    expect(isLocalImageReference("/tmp/a.png")).toBe(false);
    expect(isLocalImageReference("C:\\tmp\\a.png")).toBe(false);
  });
});

describe("local asset boundary", () => {
  it("hashes a supported image and creates a logical asset token", async () => {
    const directory = await tempDirectory();
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    await writeFile(path.join(directory, "image.png"), image);
    const markdownFile = path.join(directory, "note.md");
    await writeFile(markdownFile, "![x](image.png)");
    const asset = await loadLocalAsset(markdownFile, "image.png");
    expect(asset.mime).toBe("image/png");
    expect(asset.localPath).toBe("image.png");
    expect(await localLogicalMarkdown(markdownFile, "![x](image.png)")).toMatch(/notes-sjtu-asset:\/\/sha256\/[a-f0-9]{64}/);
  });

  it("rejects parent traversal and symlink escape", async () => {
    const parent = await tempDirectory();
    const directory = path.join(parent, "docs");
    await mkdir(directory);
    const outside = path.join(parent, "outside.png");
    await writeFile(outside, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const markdownFile = path.join(directory, "note.md");
    await writeFile(markdownFile, "x");
    await symlink(outside, path.join(directory, "escape.png"));
    await expect(loadLocalAsset(markdownFile, "../outside.png")).rejects.toMatchObject({ code: "REFUSED" });
    await expect(loadLocalAsset(markdownFile, "escape.png")).rejects.toMatchObject({ code: "REFUSED" });
  });
});
