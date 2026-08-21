import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodimdClient } from "../src/client.js";

let server: ReturnType<typeof createServer>;
let origin: string;
let note = "# Initial";

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

beforeEach(async () => {
  note = "# Initial";
  server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("CodiMD-Version", "2.4.1");
    if (request.url === "/me") {
      response.setHeader("Content-Type", "application/json");
      response.end(request.headers.cookie === "connect.sid=test" ? JSON.stringify({ status: "ok", name: "Tester" }) : JSON.stringify({ status: "error" }));
      return;
    }
    if (request.url === "/new" && request.method === "POST") {
      note = (await body(request)).toString("utf8");
      response.statusCode = 302;
      response.setHeader("Location", `${origin}/note-1`);
      response.end();
      return;
    }
    if (request.url === "/note-1/download") {
      response.setHeader("Content-Type", "text/markdown; charset=UTF-8");
      response.setHeader("Content-Disposition", "attachment; filename=Example%20Note.md");
      response.end(note);
      return;
    }
    if (request.url === "/api/notes/note-1" && request.method === "PUT") {
      note = (JSON.parse((await body(request)).toString("utf8")) as { content: string }).content;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.url === "/uploadimage" && request.method === "POST") {
      await body(request);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ link: `${origin}/uploads/image.png` }));
      return;
    }
    if (request.url === "/uploads/image.png") {
      response.setHeader("Content-Type", "image/png");
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      return;
    }
    if (request.url === "/unauthorized/download") {
      response.statusCode = 401;
      response.end("unauthorized");
      return;
    }
    if (request.url === "/forbidden/download") {
      response.statusCode = 403;
      response.end("forbidden");
      return;
    }
    if (request.url === "/api/notes/online" && request.method === "PUT") {
      response.statusCode = 403;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ status: "error", message: "Update API can only be used when no users is online" }));
      return;
    }
    if (request.url === "/failure/download") {
      response.statusCode = 500;
      response.end("failed");
      return;
    }
    if (request.url === "/cross/download") {
      response.statusCode = 302;
      response.setHeader("Location", "https://example.com/stolen");
      response.end();
      return;
    }
    if (request.url === "/slow/download") {
      setTimeout(() => response.end("late"), 100);
      return;
    }
    response.statusCode = 404;
    response.end("missing");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test address");
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  server.close();
  await once(server, "close");
});

describe("CodiMD HTTP client", () => {
  it("validates auth and performs create, download, update, and image operations", async () => {
    const client = new CodimdClient("test", 5_000, origin);
    expect((await client.me()).name).toBe("Tester");
    const reference = await client.createNote("# Created");
    expect(reference.id).toBe("note-1");
    const downloaded = await client.getNote(reference);
    expect(downloaded.markdown).toBe("# Created");
    expect(downloaded.suggestedFilename).toBe("Example Note.md");
    await client.updateNote(reference, "# Updated");
    expect((await client.getNote(reference)).markdown).toBe("# Updated");
    expect(await client.uploadImage(Buffer.from([1]), "x.png", "image/png")).toBe(`${origin}/uploads/image.png`);
    expect((await client.downloadImage(`${origin}/uploads/image.png`)).mime).toBe("image/png");
  });

  it("rejects a non-authenticated session", async () => {
    await expect(new CodimdClient("wrong", 5_000, origin).me()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("maps HTTP failures, timeouts, and cross-origin redirects to stable errors", async () => {
    const client = new CodimdClient("test", 5_000, origin);
    const reference = (id: string) => ({ id, url: `${origin}/${id}` });
    await expect(client.getNote(reference("unauthorized"))).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await expect(client.getNote(reference("forbidden"))).rejects.toMatchObject({ code: "REFUSED" });
    await expect(client.getNote(reference("failure"))).rejects.toMatchObject({ code: "SERVER" });
    await expect(client.getNote(reference("cross"))).rejects.toMatchObject({ code: "SERVER" });
    await expect(new CodimdClient("test", 10, origin).getNote(reference("slow"))).rejects.toMatchObject({ code: "NETWORK" });
  });

  it("explains when CodiMD refuses an API update because the note is open", async () => {
    const client = new CodimdClient("test", 5_000, origin);
    const reference = { id: "online", url: `${origin}/online` };
    await expect(client.updateNote(reference, "# Updated")).rejects.toMatchObject({
      code: "REFUSED",
      message: expect.stringContaining("currently open by one or more users"),
    });
  });

  it("refuses the production origin when Node TLS verification is disabled", () => {
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    expect(() => new CodimdClient("secret")).toThrowError(/TLS verification/);
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  });
});
