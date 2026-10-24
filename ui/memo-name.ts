export interface MemoSpec {
  stem: string;
  extension: string;
}

export const DEFAULT_MEMO_STEM = "memo";
export const DEFAULT_MEMO_EXTENSION = "txt";

export function fileNameOf(spec: MemoSpec): string {
  return `${spec.stem}${spec.extension ? `.${spec.extension}` : ""}`;
}

export function memoStemOf(path: string, extension: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const suffix = extension ? `.${extension}` : "";
  return suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}
