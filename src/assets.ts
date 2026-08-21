import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { AppError } from "./errors.js";
import { isWithin, toPosixPath } from "./fs-utils.js";
import type { AssetRecord, ImageReference } from "./types.js";

interface Replacement {
  start: number;
  end: number;
  value: string;
}

function mark(mask: Uint8Array, start: number, end: number): void {
  mask.fill(1, start, end);
}

function codeMask(markdown: string): Uint8Array {
  const mask = new Uint8Array(markdown.length);
  let offset = 0;
  let fence: { character: string; length: number } | undefined;
  for (const line of markdown.split(/(?<=\n)/)) {
    const body = line.replace(/\r?\n$/, "");
    const opening = body.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!fence && opening) {
      fence = { character: opening[1][0], length: opening[1].length };
      mark(mask, offset, offset + line.length);
    } else if (fence) {
      mark(mask, offset, offset + line.length);
      const closing = body.match(/^ {0,3}(`+|~+)\s*$/);
      if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length) fence = undefined;
    }
    offset += line.length;
  }

  for (let start = markdown.indexOf("<!--"); start >= 0; start = markdown.indexOf("<!--", start + 4)) {
    if (mask[start]) continue;
    const end = markdown.indexOf("-->", start + 4);
    mark(mask, start, end < 0 ? markdown.length : end + 3);
  }

  for (let index = 0; index < markdown.length; index += 1) {
    if (mask[index] || markdown[index] !== "`") continue;
    let length = 1;
    while (markdown[index + length] === "`") length += 1;
    const delimiter = "`".repeat(length);
    const end = markdown.indexOf(delimiter, index + length);
    if (end >= 0 && !mask[end]) {
      mark(mask, index, end + length);
      index = end + length - 1;
    }
  }
  return mask;
}

function findClosing(markdown: string, start: number, open: string, close: string, mask: Uint8Array): number {
  let depth = 1;
  for (let index = start; index < markdown.length; index += 1) {
    if (mask[index]) return -1;
    if (markdown[index] === "\\") {
      index += 1;
      continue;
    }
    if (markdown[index] === open) depth += 1;
    if (markdown[index] === close) depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function destinationRange(markdown: string, start: number, mask: Uint8Array): { start: number; end: number } | undefined {
  let cursor = start;
  while (cursor < markdown.length && /[ \t\n]/.test(markdown[cursor])) cursor += 1;
  if (markdown[cursor] === "<") {
    const end = markdown.indexOf(">", cursor + 1);
    if (end < 0 || mask[end]) return undefined;
    return { start: cursor + 1, end };
  }
  const valueStart = cursor;
  let nested = 0;
  for (; cursor < markdown.length; cursor += 1) {
    if (mask[cursor]) return undefined;
    const character = markdown[cursor];
    if (character === "\\") {
      cursor += 1;
      continue;
    }
    if (character === "(" ) nested += 1;
    if (character === ")") {
      if (nested === 0) break;
      nested -= 1;
    }
    if (/\s/.test(character) && nested === 0) break;
  }
  if (cursor === valueStart) return undefined;
  return { start: valueStart, end: cursor };
}

function normalizeLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function isEscaped(markdown: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && markdown[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function markdownReferences(markdown: string, mask: Uint8Array): ImageReference[] {
  const references: ImageReference[] = [];
  const labels = new Set<string>();
  for (let index = 0; index < markdown.length - 2; index += 1) {
    if (mask[index] || isEscaped(markdown, index) || markdown[index] !== "!" || markdown[index + 1] !== "[") continue;
    const altEnd = findClosing(markdown, index + 2, "[", "]", mask);
    if (altEnd < 0) continue;
    const alt = markdown.slice(index + 2, altEnd);
    let cursor = altEnd + 1;
    if (markdown[cursor] === "(") {
      const destination = destinationRange(markdown, cursor + 1, mask);
      if (destination) {
        references.push({ ...destination, value: markdown.slice(destination.start, destination.end), syntax: "markdown" });
      }
    } else if (markdown[cursor] === "[") {
      const labelEnd = findClosing(markdown, cursor + 1, "[", "]", mask);
      if (labelEnd >= 0) labels.add(normalizeLabel(markdown.slice(cursor + 1, labelEnd) || alt));
    } else {
      labels.add(normalizeLabel(alt));
    }
    index = altEnd;
  }

  let offset = 0;
  for (const line of markdown.split(/(?<=\n)/)) {
    if (!mask[offset]) {
      const match = line.match(/^ {0,3}\[([^\]\n]+)\]:[ \t]*/);
      if (match && labels.has(normalizeLabel(match[1]))) {
        const range = destinationRange(markdown, offset + match[0].length, mask);
        if (range) references.push({ ...range, value: markdown.slice(range.start, range.end), syntax: "reference" });
      }
    }
    offset += line.length;
  }
  return references;
}

function htmlReferences(markdown: string, mask: Uint8Array): ImageReference[] {
  const references: ImageReference[] = [];
  for (let index = 0; index < markdown.length - 4; index += 1) {
    if (mask[index] || isEscaped(markdown, index) || markdown[index] !== "<" || markdown.slice(index + 1, index + 4).toLowerCase() !== "img") continue;
    if (!/[\s/>]/.test(markdown[index + 4] ?? "")) continue;
    let quote = "";
    let end = index + 4;
    for (; end < markdown.length; end += 1) {
      if (mask[end]) break;
      const character = markdown[end];
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }
    if (markdown[end] !== ">") continue;
    const tag = markdown.slice(index, end + 1);
    const source = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (source) {
      const value = source[1] ?? source[2] ?? source[3] ?? "";
      const sourceOffset = source.index + source[0].indexOf(value);
      references.push({ start: index + sourceOffset, end: index + sourceOffset + value.length, value, syntax: "html" });
    }
    index = end;
  }
  return references;
}

export function findImageReferences(markdown: string): ImageReference[] {
  const mask = codeMask(markdown);
  const seen = new Set<string>();
  return [...markdownReferences(markdown, mask), ...htmlReferences(markdown, mask)]
    .sort((left, right) => left.start - right.start)
    .filter((reference) => {
      const key = `${reference.start}:${reference.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function replaceImageReferences(markdown: string, replacements: Map<number, string>): string {
  const references = findImageReferences(markdown);
  const edits: Replacement[] = [];
  for (const reference of references) {
    const value = replacements.get(reference.start);
    if (value !== undefined && value !== reference.value) edits.push({ start: reference.start, end: reference.end, value });
  }
  return edits.sort((left, right) => right.start - left.start).reduce(
    (result, edit) => `${result.slice(0, edit.start)}${edit.value}${result.slice(edit.end)}`,
    markdown,
  );
}

export function isLocalImageReference(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//") || path.isAbsolute(trimmed)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || /^[a-z]:[\\/]/i.test(trimmed)) return false;
  return true;
}

function decodeMarkdownPath(value: string): string {
  const unescaped = value.replace(/\\([\\`*{}\[\]()#+\-.!_>])/g, "$1");
  try {
    return decodeURIComponent(unescaped);
  } catch {
    return unescaped;
  }
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

export function detectedMime(buffer: Buffer): string | undefined {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (buffer.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
  if (["II*\u0000", "MM\u0000*"].includes(buffer.subarray(0, 4).toString("binary"))) return "image/tiff";
  const prefix = buffer.subarray(0, 4096).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(prefix)) return "image/svg+xml";
  return undefined;
}

export interface LocalAsset {
  absolutePath: string;
  localPath: string;
  hash: string;
  mime: string;
  extension: string;
  bytes: Buffer;
}

export async function loadLocalAsset(markdownFile: string, referenceValue: string): Promise<LocalAsset> {
  const root = await realpath(path.dirname(path.resolve(markdownFile)));
  const unresolved = path.resolve(root, decodeMarkdownPath(referenceValue));
  let resolved: string;
  try {
    resolved = await realpath(unresolved);
  } catch {
    throw new AppError("NOT_FOUND", `Referenced image not found: ${referenceValue}`);
  }
  if (!isWithin(root, resolved)) {
    throw new AppError("REFUSED", `Image path escapes the Markdown directory: ${referenceValue}`);
  }
  const metadata = await stat(resolved);
  if (!metadata.isFile()) throw new AppError("REFUSED", `Referenced image is not a file: ${referenceValue}`);
  const extension = path.extname(resolved).toLowerCase();
  const expectedMime = MIME_BY_EXTENSION[extension];
  if (!expectedMime) throw new AppError("REFUSED", `Unsupported image extension: ${extension || "(none)"}`);
  const bytes = await readFile(resolved);
  const mime = detectedMime(bytes);
  if (mime !== expectedMime) {
    throw new AppError("REFUSED", `Image content does not match its extension: ${referenceValue}`);
  }
  return {
    absolutePath: resolved,
    localPath: toPosixPath(path.relative(root, resolved)),
    hash: createHash("sha256").update(bytes).digest("hex"),
    mime,
    extension,
    bytes,
  };
}

function token(hash: string): string {
  return `notes-sjtu-asset://sha256/${hash}`;
}

export async function localLogicalMarkdown(markdownFile: string, markdown: string): Promise<string> {
  const replacements = new Map<number, string>();
  for (const reference of findImageReferences(markdown)) {
    if (!isLocalImageReference(reference.value)) continue;
    const asset = await loadLocalAsset(markdownFile, reference.value);
    replacements.set(reference.start, token(asset.hash));
  }
  return replaceImageReferences(markdown, replacements);
}

export function remoteLogicalMarkdown(markdown: string, assets: Record<string, AssetRecord>): string {
  const urlToHash = new Map(Object.values(assets).map((asset) => [asset.remoteUrl, asset.hash]));
  const replacements = new Map<number, string>();
  for (const reference of findImageReferences(markdown)) {
    const hash = urlToHash.get(reference.value);
    if (hash) replacements.set(reference.start, token(hash));
  }
  return replaceImageReferences(markdown, replacements);
}

export function extensionForMime(mime: string, url: string): string {
  const found = Object.entries(MIME_BY_EXTENSION).find(([, value]) => value === mime)?.[0];
  if (found) return found === ".jpeg" ? ".jpg" : found;
  try {
    const extension = path.extname(new URL(url).pathname).toLowerCase();
    if (MIME_BY_EXTENSION[extension]) return extension;
  } catch {
    // The caller will report the unsupported response below.
  }
  throw new AppError("SERVER", `Downloaded URL did not return a supported image: ${url}`);
}
