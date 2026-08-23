export type FileTreeDropMode = "move" | "copy";

export interface FileTreeDropRequest {
  sourceRelPaths: string[];
  targetRelDir: string;
  mode: FileTreeDropMode;
}

export interface FileTreeDropResult {
  undoable: boolean;
}
