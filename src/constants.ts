export const SERVER_ORIGIN = "https://notes.sjtu.edu.cn";
export const STATE_DIR_NAME = ".notes-sjtu-sync";
export const MANIFEST_VERSION = 1;
export const SESSION_SERVICE = "notes-sjtu-sync";
export const SESSION_ACCOUNT = SERVER_ORIGIN;

export const EXIT = {
  OK: 0,
  USAGE: 2,
  AUTH: 3,
  NOT_FOUND: 4,
  CONFLICT: 5,
  NETWORK: 6,
  LOCAL: 7,
} as const;
