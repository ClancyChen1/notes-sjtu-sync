import { EXIT } from "./constants.js";

export type ErrorCode =
  | "USAGE"
  | "AUTH_REQUIRED"
  | "AUTH_FAILED"
  | "NOT_TRACKED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "REFUSED"
  | "NETWORK"
  | "SERVER"
  | "LOCAL_IO"
  | "INVALID_STATE"
  | "UNSUPPORTED_SERVER";

const exitByCode: Record<ErrorCode, number> = {
  USAGE: EXIT.USAGE,
  AUTH_REQUIRED: EXIT.AUTH,
  AUTH_FAILED: EXIT.AUTH,
  NOT_TRACKED: EXIT.NOT_FOUND,
  NOT_FOUND: EXIT.NOT_FOUND,
  CONFLICT: EXIT.CONFLICT,
  REFUSED: EXIT.CONFLICT,
  NETWORK: EXIT.NETWORK,
  SERVER: EXIT.NETWORK,
  LOCAL_IO: EXIT.LOCAL,
  INVALID_STATE: EXIT.LOCAL,
  UNSUPPORTED_SERVER: EXIT.NETWORK,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.exitCode = exitByCode[code];
    this.details = details;
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    return new AppError("LOCAL_IO", error.message);
  }
  return new AppError("LOCAL_IO", String(error));
}
