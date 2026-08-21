export type SyncStatus =
  | "clean"
  | "local_modified"
  | "remote_modified"
  | "diverged"
  | "untracked"
  | "missing_local"
  | "remote_missing";

export interface AssetRecord {
  hash: string;
  localPath: string;
  remoteUrl: string;
  mime: string;
  extension: string;
}

export interface TrackingRecord {
  remote: {
    id: string;
    url: string;
  };
  baseline: {
    logical: string;
    localText: string;
    remoteText: string;
    hash: string;
  };
  assets: Record<string, AssetRecord>;
  pendingAssets: Record<string, AssetRecord>;
  createdAt: string;
  updatedAt: string;
}

export interface Manifest {
  schemaVersion: 1;
  documents: Record<string, TrackingRecord>;
}

export interface NoteReference {
  id: string;
  url: string;
}

export interface RemoteDocument {
  reference: NoteReference;
  markdown: string;
  suggestedFilename?: string;
  version?: string;
}

export interface ImageReference {
  start: number;
  end: number;
  value: string;
  syntax: "markdown" | "reference" | "html";
}

export interface SyncInspection {
  status: SyncStatus;
  localExists: boolean;
  localChanged: boolean;
  remoteChanged: boolean;
  localLogical?: string;
  remoteLogical?: string;
  localText?: string;
  remoteText?: string;
  record?: TrackingRecord;
}
