import { SERVER_ORIGIN } from "./constants.js";
import { AppError } from "./errors.js";
import type { NoteReference } from "./types.js";

const RESERVED = new Set(["auth", "api", "new", "uploads", "features", "me", "history"]);

export function parseNoteUrl(input: string, expectedOrigin = SERVER_ORIGIN): NoteReference {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new AppError("USAGE", `Invalid note URL: ${input}`);
  }
  if (parsed.origin !== expectedOrigin) {
    throw new AppError("USAGE", `Only ${expectedOrigin} note URLs are supported.`);
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if ((parts[0] === "s" || parts[0] === "p") && parts.length >= 2) parts.shift();
  const id = parts[0];
  if (!id || RESERVED.has(id) || parts.length !== 1) {
    throw new AppError("USAGE", `Could not identify a note in URL: ${input}`);
  }
  return { id: decodeURIComponent(id), url: `${expectedOrigin}/${encodeURIComponent(decodeURIComponent(id))}` };
}

export function noteReferenceFromLocation(location: string, expectedOrigin = SERVER_ORIGIN): NoteReference {
  return parseNoteUrl(new URL(location, expectedOrigin).href, expectedOrigin);
}

export function isManagedRemoteImage(value: string, knownUrls: Set<string>): boolean {
  if (knownUrls.has(value)) return true;
  try {
    const url = new URL(value);
    return url.origin === SERVER_ORIGIN && url.pathname.startsWith("/uploads/");
  } catch {
    return false;
  }
}
