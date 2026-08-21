import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { CodimdClient } from "./client.js";
import { AppError } from "./errors.js";
import { atomicWrite, pathExists, toPosixPath } from "./fs-utils.js";
import {
  detectedMime,
  extensionForMime,
  findImageReferences,
  isLocalImageReference,
  loadLocalAsset,
  localLogicalMarkdown,
  remoteLogicalMarkdown,
  replaceImageReferences,
} from "./assets.js";
import { getTracking, loadManifest, logicalHash, putTracking, removeTracking, stateLocation } from "./state.js";
import { isManagedRemoteImage, parseNoteUrl } from "./url.js";
import type { AssetRecord, NoteReference, RemoteDocument, SyncInspection, TrackingRecord } from "./types.js";

export interface OperationOptions {
  dryRun?: boolean;
  force?: boolean;
  track?: boolean;
}

interface PreparedRemote {
  markdown: string;
  assets: Record<string, AssetRecord>;
  pendingAssets: Record<string, AssetRecord>;
  uploads: Array<{ path: string; hash: string; bytes: number; reused: boolean }>;
}

interface MaterializedLocal {
  markdown: string;
  assets: Record<string, AssetRecord>;
  downloads: Array<{ url: string; path?: string; reused: boolean }>;
}

function combinedAssets(record?: TrackingRecord): Record<string, AssetRecord> {
  return { ...(record?.assets ?? {}), ...(record?.pendingAssets ?? {}) };
}

function newRecord(reference: NoteReference, localText: string, remoteText: string, assets: Record<string, AssetRecord>): TrackingRecord {
  const now = new Date().toISOString();
  const logical = remoteLogicalMarkdown(remoteText, assets);
  return {
    remote: reference,
    baseline: { logical, localText, remoteText, hash: logicalHash(logical) },
    assets,
    pendingAssets: {},
    createdAt: now,
    updatedAt: now,
  };
}

function updateBaseline(
  record: TrackingRecord,
  localText: string,
  remoteText: string,
  assets: Record<string, AssetRecord>,
): TrackingRecord {
  const logical = remoteLogicalMarkdown(remoteText, assets);
  return {
    ...record,
    baseline: { logical, localText, remoteText, hash: logicalHash(logical) },
    assets,
    pendingAssets: {},
    updatedAt: new Date().toISOString(),
  };
}

async function prepareRemote(
  markdownFile: string,
  markdown: string,
  client: CodimdClient,
  record: TrackingRecord | undefined,
  dryRun: boolean,
  persistPending?: (pending: Record<string, AssetRecord>) => Promise<void>,
): Promise<PreparedRemote> {
  const assets = { ...(record?.assets ?? {}) };
  const pendingAssets = { ...(record?.pendingAssets ?? {}) };
  const replacements = new Map<number, string>();
  const uploads: PreparedRemote["uploads"] = [];
  const plannedHashes = new Set<string>();
  for (const reference of findImageReferences(markdown)) {
    if (!isLocalImageReference(reference.value)) continue;
    const local = await loadLocalAsset(markdownFile, reference.value);
    const existing = assets[local.hash] ?? pendingAssets[local.hash];
    if (existing) {
      const updated = { ...existing, localPath: local.localPath };
      if (assets[local.hash]) assets[local.hash] = updated;
      else pendingAssets[local.hash] = updated;
      replacements.set(reference.start, existing.remoteUrl);
      uploads.push({ path: local.localPath, hash: local.hash, bytes: local.bytes.length, reused: true });
      continue;
    }
    uploads.push({ path: local.localPath, hash: local.hash, bytes: local.bytes.length, reused: false });
    if (dryRun) {
      const reused = plannedHashes.has(local.hash);
      plannedHashes.add(local.hash);
      uploads[uploads.length - 1].reused = reused;
      replacements.set(reference.start, `notes-sjtu-upload://sha256/${local.hash}`);
      continue;
    }
    const filename = `image-${local.hash.slice(0, 12)}${local.extension}`;
    const remoteUrl = await client.uploadImage(local.bytes, filename, local.mime);
    pendingAssets[local.hash] = {
      hash: local.hash,
      localPath: local.localPath,
      remoteUrl,
      mime: local.mime,
      extension: local.extension,
    };
    await persistPending?.(pendingAssets);
    replacements.set(reference.start, remoteUrl);
  }
  return { markdown: replaceImageReferences(markdown, replacements), assets, pendingAssets, uploads };
}

async function materializeRemote(
  targetFile: string,
  markdown: string,
  client: CodimdClient,
  existingAssets: Record<string, AssetRecord>,
  dryRun: boolean,
): Promise<MaterializedLocal> {
  const knownUrls = new Set(Object.values(existingAssets).map((asset) => asset.remoteUrl));
  const byUrl = new Map(Object.values(existingAssets).map((asset) => [asset.remoteUrl, asset]));
  const replacements = new Map<number, string>();
  const downloads: MaterializedLocal["downloads"] = [];
  const assets = { ...existingAssets };
  const root = path.dirname(path.resolve(targetFile));
  const assetDirectoryName = `${path.basename(targetFile, path.extname(targetFile))}.assets`;
  for (const reference of findImageReferences(markdown)) {
    if (!isManagedRemoteImage(reference.value, knownUrls)) continue;
    const existing = byUrl.get(reference.value);
    if (existing) {
      const existingPath = path.resolve(root, existing.localPath);
      if (await pathExists(existingPath)) {
        const rendered = `./${toPosixPath(existing.localPath)}`;
        replacements.set(reference.start, rendered);
        downloads.push({ url: reference.value, path: rendered, reused: true });
        continue;
      }
    }
    if (dryRun) {
      downloads.push({ url: reference.value, reused: false });
      continue;
    }
    const downloaded = await client.downloadImage(reference.value);
    const actualMime = detectedMime(downloaded.bytes);
    if (!actualMime || actualMime !== downloaded.mime) {
      throw new AppError("SERVER", `Downloaded image content did not match Content-Type: ${reference.value}`);
    }
    const hash = createHash("sha256").update(downloaded.bytes).digest("hex");
    const extension = extensionForMime(actualMime, reference.value);
    const relative = toPosixPath(path.join(assetDirectoryName, `image-${hash.slice(0, 12)}${extension}`));
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    if (!(await pathExists(absolute))) await atomicWrite(absolute, downloaded.bytes, 0o644);
    const asset: AssetRecord = { hash, localPath: relative, remoteUrl: reference.value, mime: actualMime, extension };
    assets[hash] = asset;
    byUrl.set(reference.value, asset);
    knownUrls.add(reference.value);
    const rendered = `./${relative}`;
    replacements.set(reference.start, rendered);
    downloads.push({ url: reference.value, path: rendered, reused: false });
  }
  return { markdown: replaceImageReferences(markdown, replacements), assets, downloads };
}

export async function inspect(markdownPath: string, client: CodimdClient): Promise<SyncInspection> {
  const { location, record } = await getTracking(markdownPath);
  const localExists = await pathExists(location.file);
  const localText = localExists ? await readFile(location.file, "utf8") : undefined;
  const allAssets = combinedAssets(record);
  const localLogical = localText === undefined ? undefined : await localLogicalMarkdown(location.file, localText);
  let remote: RemoteDocument;
  try {
    remote = await client.getNote(record.remote);
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") {
      return {
        status: "remote_missing",
        localExists,
        localChanged: localLogical !== undefined && localLogical !== record.baseline.logical,
        remoteChanged: true,
        localLogical,
        localText,
        record,
      };
    }
    throw error;
  }
  if (!localExists) {
    const remoteLogical = remoteLogicalMarkdown(remote.markdown, allAssets);
    return {
      status: "missing_local",
      localExists: false,
      localChanged: true,
      remoteChanged: remoteLogical !== record.baseline.logical,
      remoteLogical,
      remoteText: remote.markdown,
      record,
    };
  }
  const remoteLogical = remoteLogicalMarkdown(remote.markdown, allAssets);
  const localChanged = localLogical !== record.baseline.logical;
  const remoteChanged = remoteLogical !== record.baseline.logical;
  const status = localChanged && remoteChanged
    ? "diverged"
    : localChanged
      ? "local_modified"
      : remoteChanged
        ? "remote_modified"
        : "clean";
  return { status, localExists, localChanged, remoteChanged, localLogical, remoteLogical, localText, remoteText: remote.markdown, record };
}

export async function status(markdownPath: string, client: CodimdClient): Promise<SyncInspection> {
  try {
    return await inspect(markdownPath, client);
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_TRACKED") {
      return { status: "untracked", localExists: await pathExists(path.resolve(markdownPath)), localChanged: false, remoteChanged: false };
    }
    throw error;
  }
}

export async function diff(markdownPath: string, client: CodimdClient): Promise<{ status: string; localPatch: string; remotePatch: string }> {
  const result = await inspect(markdownPath, client);
  const baseline = result.record!.baseline;
  const localPatch = result.localText === undefined || result.localText === baseline.localText
    ? ""
    : createTwoFilesPatch("baseline", "local", baseline.localText, result.localText, "baseline", "local", { context: 3 });
  const remotePatch = result.remoteText === undefined || result.remoteText === baseline.remoteText
    ? ""
    : createTwoFilesPatch("baseline", "remote", baseline.remoteText, result.remoteText, "baseline", "remote", { context: 3 });
  return { status: result.status, localPatch, remotePatch };
}

function sanitizeFilename(input: string | undefined, id: string): string {
  const raw = path.basename(input || `note-${id.slice(0, 8)}.md`);
  const safe = raw.replace(/[\u0000-\u001f\u007f/\\:]/g, "-").replace(/^\.+$/, "").trim();
  const base = safe || `note-${id.slice(0, 8)}.md`;
  return base.toLowerCase().endsWith(".md") ? base : `${base}.md`;
}

async function availableDownloadPath(suggested: string | undefined, id: string): Promise<string> {
  const filename = sanitizeFilename(suggested, id);
  const extension = path.extname(filename);
  const stem = path.basename(filename, extension);
  let candidate = path.resolve(filename);
  for (let suffix = 2; await pathExists(candidate); suffix += 1) {
    candidate = path.resolve(`${stem}-${suffix}${extension}`);
  }
  return candidate;
}

export async function upload(
  markdownPath: string,
  client: CodimdClient,
  options: OperationOptions = {},
): Promise<Record<string, unknown>> {
  const file = path.resolve(markdownPath);
  const existingManifest = await loadManifest(stateLocation(file));
  if (existingManifest.documents[path.basename(file)]) throw new AppError("REFUSED", "The document is already tracked; use push.");
  const localText = await readFile(file, "utf8");
  const prepared = await prepareRemote(file, localText, client, undefined, Boolean(options.dryRun));
  if (options.dryRun) return { dryRun: true, file, uploads: prepared.uploads, willTrack: options.track !== false };
  const reference = await client.createNote(prepared.markdown);
  const assets = { ...prepared.assets, ...prepared.pendingAssets };
  if (options.track !== false) await putTracking(file, newRecord(reference, localText, prepared.markdown, assets));
  return { dryRun: false, file, note: reference, uploads: prepared.uploads, tracked: options.track !== false };
}

export async function download(
  url: string,
  markdownPath: string | undefined,
  client: CodimdClient,
  options: OperationOptions = {},
): Promise<Record<string, unknown>> {
  const reference = parseNoteUrl(url);
  const remote = await client.getNote(reference);
  const file = markdownPath ? path.resolve(markdownPath) : await availableDownloadPath(remote.suggestedFilename, reference.id);
  if (markdownPath && await pathExists(file)) throw new AppError("REFUSED", `Target already exists: ${file}`);
  const materialized = await materializeRemote(file, remote.markdown, client, {}, Boolean(options.dryRun));
  if (options.dryRun) return { dryRun: true, file, downloads: materialized.downloads, willTrack: options.track !== false };
  await atomicWrite(file, materialized.markdown, 0o644);
  if (options.track !== false) await putTracking(file, newRecord(reference, materialized.markdown, remote.markdown, materialized.assets));
  return { dryRun: false, file, note: reference, downloads: materialized.downloads, tracked: options.track !== false };
}

export async function link(
  markdownPath: string,
  url: string,
  direction: "pull" | "push" | undefined,
  client: CodimdClient,
  options: OperationOptions = {},
): Promise<Record<string, unknown>> {
  const file = path.resolve(markdownPath);
  const location = stateLocation(file);
  const manifest = await loadManifest(location);
  if (manifest.documents[location.documentKey]) throw new AppError("REFUSED", "The document is already tracked.");
  const localText = await readFile(file, "utf8");
  const reference = parseNoteUrl(url);
  const remote = await client.getNote(reference);
  if (localText === remote.markdown && !direction) {
    if (!options.dryRun) await putTracking(file, newRecord(reference, localText, remote.markdown, {}));
    return { dryRun: Boolean(options.dryRun), file, note: reference, direction: "equal" };
  }
  if (!direction) throw new AppError("REFUSED", "Local and remote content differ; choose link --pull or link --push.");
  if (direction === "pull") {
    const materialized = await materializeRemote(file, remote.markdown, client, {}, Boolean(options.dryRun));
    if (!options.dryRun) {
      await atomicWrite(file, materialized.markdown, 0o644);
      await putTracking(file, newRecord(reference, materialized.markdown, remote.markdown, materialized.assets));
    }
    return { dryRun: Boolean(options.dryRun), file, note: reference, direction, downloads: materialized.downloads };
  }
  const prepared = await prepareRemote(file, localText, client, undefined, Boolean(options.dryRun));
  if (!options.dryRun) {
    await client.updateNote(reference, prepared.markdown);
    await putTracking(file, newRecord(reference, localText, prepared.markdown, { ...prepared.assets, ...prepared.pendingAssets }));
  }
  return { dryRun: Boolean(options.dryRun), file, note: reference, direction, uploads: prepared.uploads };
}

async function conflictBundle(markdownPath: string, inspection: SyncInspection, client: CodimdClient): Promise<string> {
  const location = stateLocation(markdownPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = path.join(location.directory, "conflicts", `${path.basename(location.file, path.extname(location.file))}-${stamp}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await atomicWrite(path.join(directory, "base.md"), inspection.record!.baseline.localText, 0o600);
  const remoteFile = path.join(directory, "remote.md");
  try {
    const materialized = await materializeRemote(remoteFile, inspection.remoteText!, client, combinedAssets(inspection.record), false);
    await atomicWrite(remoteFile, materialized.markdown, 0o600);
  } catch {
    await atomicWrite(remoteFile, inspection.remoteText!, 0o600);
  }
  return directory;
}

export async function pull(markdownPath: string, client: CodimdClient, options: OperationOptions = {}): Promise<Record<string, unknown>> {
  const file = path.resolve(markdownPath);
  const inspection = await inspect(file, client);
  if (inspection.status === "remote_missing") throw new AppError("NOT_FOUND", "The tracked Remote Note no longer exists.");
  if (inspection.status === "diverged" && !options.force) {
    if (options.dryRun) throw new AppError("CONFLICT", "Local and remote content both changed.", { dryRun: true });
    const bundle = await conflictBundle(file, inspection, client);
    throw new AppError("CONFLICT", "Local and remote content both changed; resolve manually or use --force.", { conflictBundle: bundle });
  }
  if ((inspection.status === "clean" || inspection.status === "local_modified") && !options.force) {
    return { dryRun: Boolean(options.dryRun), file, status: inspection.status, changed: false };
  }
  const materialized = await materializeRemote(file, inspection.remoteText!, client, combinedAssets(inspection.record), Boolean(options.dryRun));
  if (!options.dryRun) {
    await atomicWrite(file, materialized.markdown, 0o644);
    await putTracking(file, updateBaseline(inspection.record!, materialized.markdown, inspection.remoteText!, materialized.assets));
  }
  return { dryRun: Boolean(options.dryRun), file, status: inspection.status, changed: true, downloads: materialized.downloads, forced: Boolean(options.force) };
}

export async function push(markdownPath: string, client: CodimdClient, options: OperationOptions = {}): Promise<Record<string, unknown>> {
  const file = path.resolve(markdownPath);
  const inspection = await inspect(file, client);
  if (!inspection.localExists) throw new AppError("NOT_FOUND", `Local Markdown is missing: ${file}`);
  if (inspection.status === "remote_missing") throw new AppError("NOT_FOUND", "The tracked Remote Note no longer exists.");
  if (inspection.status === "diverged" && !options.force) {
    if (options.dryRun) throw new AppError("CONFLICT", "Local and remote content both changed.", { dryRun: true });
    const bundle = await conflictBundle(file, inspection, client);
    throw new AppError("CONFLICT", "Local and remote content both changed; resolve manually or use --force.", { conflictBundle: bundle });
  }
  if (inspection.status === "remote_modified" && !options.force) {
    throw new AppError("REFUSED", "Remote content changed; pull it before pushing or use --force.");
  }
  if (inspection.status === "clean" && !options.force) {
    return { dryRun: Boolean(options.dryRun), file, status: inspection.status, changed: false };
  }
  let workingRecord = inspection.record!;
  const persistPending = async (pendingAssets: Record<string, AssetRecord>): Promise<void> => {
    workingRecord = { ...workingRecord, pendingAssets, updatedAt: new Date().toISOString() };
    await putTracking(file, workingRecord);
  };
  const prepared = await prepareRemote(file, inspection.localText!, client, workingRecord, Boolean(options.dryRun), persistPending);
  if (!options.dryRun) {
    if (!options.force) {
      const latest = await client.getNote(workingRecord.remote);
      if (latest.markdown !== inspection.remoteText) throw new AppError("CONFLICT", "Remote content changed during push; run status again.");
    }
    await client.updateNote(workingRecord.remote, prepared.markdown);
    const assets = { ...prepared.assets, ...prepared.pendingAssets };
    await putTracking(file, updateBaseline(workingRecord, inspection.localText!, prepared.markdown, assets));
  }
  return { dryRun: Boolean(options.dryRun), file, status: inspection.status, changed: true, uploads: prepared.uploads, forced: Boolean(options.force) };
}

export async function unlink(markdownPath: string): Promise<{ file: string; unlinked: boolean }> {
  const file = path.resolve(markdownPath);
  return { file, unlinked: await removeTracking(file) };
}
