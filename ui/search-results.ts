import type { WorkspaceSearchResult } from "./api";

// 検索結果をファイル単位のツリーへ組み直す。表示の都合しか知らない純関数として
// 切り出し、DOM を作る Sidebar から独立してテストできるようにする。

export interface ResultGroup {
  relPath: string;
  fileName: string;
  dirPath: string; // ルートからの親フォルダ ("" ならルート直下)
  matches: WorkspaceSearchResult[];
}

// backend はパス順に並べて返すため、隣り合う同じパスをまとめるだけでよい
export function groupResults(results: WorkspaceSearchResult[]): ResultGroup[] {
  const groups: ResultGroup[] = [];
  for (const result of results) {
    const last = groups[groups.length - 1];
    if (last?.relPath === result.rel_path) {
      last.matches.push(result);
      continue;
    }
    const cut = result.rel_path.lastIndexOf("/");
    groups.push({
      relPath: result.rel_path,
      fileName: result.rel_path.slice(cut + 1),
      dirPath: cut < 0 ? "" : result.rel_path.slice(0, cut),
      matches: [result],
    });
  }
  return groups;
}

// backend が返す範囲は char 単位。サロゲートペアがあると JS の
// 文字列 index とずれるため、一度コードポイント配列に開いてから切る。
export function highlightedPreview(
  preview: string,
  highlights: [number, number][]
): DocumentFragment {
  const frag = document.createDocumentFragment();
  const chars = [...preview];
  let at = 0;
  for (const [start, length] of highlights) {
    if (start < at || start >= chars.length) continue; // 壊れた範囲は無視して素で出す
    frag.append(chars.slice(at, start).join(""));
    const mark = document.createElement("mark");
    mark.textContent = chars.slice(start, start + length).join("");
    frag.append(mark);
    at = start + length;
  }
  frag.append(chars.slice(at).join(""));
  return frag;
}
