import { AppError, asAppError } from "./errors.js";

export interface OutputOptions {
  json?: boolean;
}

export function emitSuccess(command: string, result: unknown, message: string, options: OutputOptions): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, command, result }, null, 2)}\n`);
  } else {
    process.stdout.write(`${message}\n`);
  }
}

export function emitError(error: unknown, json: boolean): number {
  const appError = asAppError(error);
  if (json) {
    const payload = {
      ok: false,
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.details === undefined ? {} : { details: appError.details }),
      },
    };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stderr.write(`Error [${appError.code}]: ${appError.message}\n`);
  }
  return appError.exitCode;
}

export function usageError(message: string): never {
  throw new AppError("USAGE", message);
}
