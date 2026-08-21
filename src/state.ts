import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { MANIFEST_VERSION, STATE_DIR_NAME } from "./constants.js";
import { AppError } from "./errors.js";
import { atomicWrite, pathExists } from "./fs-utils.js";
import type { Manifest, TrackingRecord } from "./types.js";

export interface StateLocation {
  file: string;
  directory: string;
  manifestPath: string;
  documentKey: string;
}

export function stateLocation(markdownPath: string): StateLocation {
  const file = path.resolve(markdownPath);
  const directory = path.join(path.dirname(file), STATE_DIR_NAME);
  return {
    file,
    directory,
    manifestPath: path.join(directory, "manifest.json"),
    documentKey: path.basename(file),
  };
}

export function emptyManifest(): Manifest {
  return { schemaVersion: MANIFEST_VERSION, documents: {} };
}

function isTrackingRecord(value: unknown): value is TrackingRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<TrackingRecord>;
  return Boolean(record.remote?.id && record.remote.url && record.baseline && record.assets && record.pendingAssets);
}

export async function loadManifest(location: StateLocation): Promise<Manifest> {
  if (!(await pathExists(location.manifestPath))) return emptyManifest();
  try {
    const parsed = JSON.parse(await readFile(location.manifestPath, "utf8")) as Partial<Manifest>;
    if (parsed.schemaVersion !== MANIFEST_VERSION || !parsed.documents || typeof parsed.documents !== "object") {
      throw new AppError("INVALID_STATE", `Unsupported state schema in ${location.manifestPath}.`);
    }
    for (const record of Object.values(parsed.documents)) {
      if (!isTrackingRecord(record)) throw new AppError("INVALID_STATE", `Invalid tracking record in ${location.manifestPath}.`);
    }
    return parsed as Manifest;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("INVALID_STATE", `Could not parse ${location.manifestPath}: ${(error as Error).message}`);
  }
}

export async function saveManifest(location: StateLocation, manifest: Manifest): Promise<void> {
  await mkdir(location.directory, { recursive: true, mode: 0o700 });
  await atomicWrite(location.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function ensureStateIgnored(markdownFile: string): Promise<boolean> {
  const ignorePath = path.join(path.dirname(path.resolve(markdownFile)), ".gitignore");
  const rule = `/${STATE_DIR_NAME}/`;
  let existing = "";
  if (await pathExists(ignorePath)) existing = await readFile(ignorePath, "utf8");
  const lines = existing.split(/\r?\n/);
  if (lines.includes(rule)) return false;
  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  await atomicWrite(ignorePath, `${existing}${separator}${rule}\n`, 0o644);
  return true;
}

export function logicalHash(logical: string): string {
  return createHash("sha256").update(logical).digest("hex");
}

export async function getTracking(markdownPath: string): Promise<{ location: StateLocation; manifest: Manifest; record: TrackingRecord }> {
  const location = stateLocation(markdownPath);
  const manifest = await loadManifest(location);
  const record = manifest.documents[location.documentKey];
  if (!record) throw new AppError("NOT_TRACKED", `Not tracked: ${location.file}`);
  return { location, manifest, record };
}

export async function putTracking(markdownPath: string, record: TrackingRecord): Promise<void> {
  const location = stateLocation(markdownPath);
  const manifest = await loadManifest(location);
  manifest.documents[location.documentKey] = record;
  await saveManifest(location, manifest);
  await ensureStateIgnored(location.file);
}

export async function removeTracking(markdownPath: string): Promise<boolean> {
  const location = stateLocation(markdownPath);
  const manifest = await loadManifest(location);
  if (!manifest.documents[location.documentKey]) return false;
  delete manifest.documents[location.documentKey];
  await saveManifest(location, manifest);
  return true;
}
