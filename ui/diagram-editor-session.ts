import type { Pos, EditResult } from "./api";
export interface DiagramAssetSession {
  assetPrefix: string;
  isCurrent: () => boolean;
  readImage: (src: string, base?: string) => Promise<ArrayBuffer>;
  saveImage: (bytes: ArrayBuffer, mimeType: string, shared: boolean) => Promise<string>;
  finish: () => Promise<void>;
  applyEdit: (start: Pos, end: Pos, caretBefore: Pos, text: string, expected: string, expectedLine: string) => Promise<EditResult>;
}
