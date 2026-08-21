import path from "node:path";
import { SERVER_ORIGIN } from "./constants.js";
import { AppError } from "./errors.js";
import { noteReferenceFromLocation } from "./url.js";
import type { NoteReference, RemoteDocument } from "./types.js";

const USER_AGENT = "notes-sjtu-sync/0.1.0 Node.js";

function filenameFromDisposition(value: string | null): string | undefined {
  if (!value) return undefined;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  const ordinary = /filename="?([^";]+)"?/i.exec(value)?.[1];
  const candidate = encoded ?? ordinary;
  if (!candidate) return undefined;
  try {
    return decodeURIComponent(candidate);
  } catch {
    return candidate;
  }
}

export class CodimdClient {
  private readonly origin: string;

  constructor(private readonly cookie?: string, private readonly timeoutMs = 30_000, origin = SERVER_ORIGIN) {
    this.origin = new URL(origin).origin;
    if (this.origin === SERVER_ORIGIN && process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
      throw new AppError(
        "REFUSED",
        "Refusing to contact SJTU Notes while NODE_TLS_REJECT_UNAUTHORIZED=0. Unset it to restore TLS verification.",
      );
    }
  }

  private async request(pathname: string, init: RequestInit = {}, followRedirects = true): Promise<Response> {
    let url = new URL(pathname, this.origin);
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const headers = new Headers(init.headers);
      headers.set("User-Agent", USER_AGENT);
      if (this.cookie) headers.set("Cookie", `connect.sid=${this.cookie}`);
      let response: Response;
      try {
        response = await fetch(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (error) {
        throw new AppError("NETWORK", `Could not reach ${this.origin}: ${(error as Error).message}`);
      }
      if (![301, 302, 303, 307, 308].includes(response.status) || !followRedirects) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      const next = new URL(location, url);
      if (next.origin !== this.origin) throw new AppError("SERVER", `Refused cross-origin redirect to ${next.origin}.`);
      url = next;
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && init.method === "POST")) {
        init = { method: "GET", headers: init.headers };
      }
    }
    throw new AppError("SERVER", "Too many redirects from SJTU Notes.");
  }

  private async requireOk(response: Response, operation: string): Promise<Response> {
    if (response.ok) {
      const version = response.headers.get("CodiMD-Version");
      if (version && version !== "2.4.1") {
        throw new AppError("UNSUPPORTED_SERVER", `Expected CodiMD 2.4.1 but server reported ${version}.`);
      }
      return response;
    }
    if (response.status === 401) throw new AppError("AUTH_REQUIRED", `${operation} requires login.`);
    if (response.status === 403) {
      const body = await response.text();
      if (operation === "Update note" && /Update API can only be used when no users is online/i.test(body)) {
        throw new AppError(
          "REFUSED",
          "Update note was refused because the remote note is currently open by one or more users. Close it in every browser or device (including yours), ask collaborators to do the same, wait a few seconds for the realtime session to clear, then retry.",
        );
      }
      throw new AppError("REFUSED", `${operation} was forbidden by SJTU Notes.`);
    }
    if (response.status === 404) throw new AppError("NOT_FOUND", `${operation} could not find the remote note.`);
    const body = (await response.text()).slice(0, 300).replace(/\s+/g, " ");
    throw new AppError("SERVER", `${operation} failed with HTTP ${response.status}${body ? `: ${body}` : ""}.`);
  }

  async me(): Promise<Record<string, unknown>> {
    const response = await this.requireOk(await this.request("/me"), "Authentication check");
    let data: Record<string, unknown>;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new AppError("AUTH_FAILED", "SJTU Notes returned an invalid authentication response.");
    }
    if (data.status !== "ok") throw new AppError("AUTH_REQUIRED", "The saved SJTU Notes session is not logged in.");
    return data;
  }

  async createNote(markdown: string): Promise<NoteReference> {
    const response = await this.request("/new", {
      method: "POST",
      body: markdown,
      headers: { "Content-Type": "text/markdown; charset=UTF-8" },
    }, false);
    if ([301, 302, 303].includes(response.status)) {
      const location = response.headers.get("location");
      if (location) return noteReferenceFromLocation(location, this.origin);
    }
    await this.requireOk(response, "Create note");
    return noteReferenceFromLocation(response.url, this.origin);
  }

  async getNote(reference: NoteReference): Promise<RemoteDocument> {
    const response = await this.requireOk(
      await this.request(`/${encodeURIComponent(reference.id)}/download`),
      "Download note",
    );
    return {
      reference,
      markdown: await response.text(),
      suggestedFilename: filenameFromDisposition(response.headers.get("content-disposition")),
      version: response.headers.get("CodiMD-Version") ?? undefined,
    };
  }

  async updateNote(reference: NoteReference, markdown: string): Promise<void> {
    await this.requireOk(
      await this.request(`/api/notes/${encodeURIComponent(reference.id)}`, {
        method: "PUT",
        body: JSON.stringify({ content: markdown }),
        headers: { "Content-Type": "application/json" },
      }),
      "Update note",
    );
  }

  async uploadImage(bytes: Uint8Array, filename: string, mime: string): Promise<string> {
    const body = new FormData();
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    body.append("image", new Blob([copy.buffer], { type: mime }), path.basename(filename));
    const response = await this.requireOk(await this.request("/uploadimage", { method: "POST", body }), "Upload image");
    const data = (await response.json().catch(() => undefined)) as { link?: unknown } | undefined;
    if (!data || typeof data.link !== "string") throw new AppError("SERVER", "Image upload returned no link.");
    const link = new URL(data.link, this.origin);
    if (link.protocol !== "https:" && link.origin !== this.origin) throw new AppError("SERVER", "Image upload returned a non-HTTPS URL.");
    return link.href;
  }

  async downloadImage(url: string): Promise<{ bytes: Buffer; mime: string }> {
    let current: URL;
    try {
      current = new URL(url);
    } catch {
      throw new AppError("SERVER", `Invalid image URL: ${url}`);
    }
    if (current.protocol !== "https:" && current.origin !== this.origin) throw new AppError("REFUSED", `Refused non-HTTPS image URL: ${url}`);
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      let response: Response;
      try {
        response = await fetch(current, {
          headers: { "User-Agent": USER_AGENT },
          redirect: "manual",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        throw new AppError("NETWORK", `Could not download image ${current.href}: ${(error as Error).message}`);
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new AppError("SERVER", `Image redirect had no location: ${current.href}`);
        current = new URL(location, current);
        if (current.protocol !== "https:" && current.origin !== this.origin) throw new AppError("REFUSED", "Refused image redirect to non-HTTPS URL.");
        continue;
      }
      if (!response.ok) throw new AppError("SERVER", `Image download failed with HTTP ${response.status}: ${current.href}`);
      const mime = (response.headers.get("content-type") ?? "").split(";", 1)[0].toLowerCase();
      if (!mime.startsWith("image/")) throw new AppError("SERVER", `URL did not return an image: ${current.href}`);
      return { bytes: Buffer.from(await response.arrayBuffer()), mime };
    }
    throw new AppError("SERVER", `Too many image redirects: ${url}`);
  }
}
