import type { Pos } from "./api";

export interface ContextTarget {
  relPath: string;
  isDir: boolean;
  goto?: Pos;
}
