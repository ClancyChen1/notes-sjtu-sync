import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "./errors.js";

export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function readUtf8(target: string): Promise<string> {
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new AppError("NOT_FOUND", `File not found: ${target}`);
    throw new AppError("LOCAL_IO", `Could not read ${target}: ${(error as Error).message}`);
  }
}

export async function atomicWrite(target: string, content: string | Uint8Array, mode = 0o600): Promise<void> {
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    await chmod(target, mode);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new AppError("LOCAL_IO", `Could not write ${target}: ${(error as Error).message}`);
  }
}

export function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}
