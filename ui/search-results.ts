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

// backend の大小文字無視は ASCII バイト単位なので、強調表示も同じ規則で畳む
const foldAscii = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

// preview 内の一致位置。preview は行の一部を切り出したもので result.col とは
// 座標系が違うため、位置は preview を検索し直して求める。
export function highlightRanges(
  preview: string,
  pattern: string,
  matchCase: boolean
): [number, number][] {
  if (!pattern) return [];
  const haystack = matchCase ? preview : foldAscii(preview);
  const needle = matchCase ? pattern : foldAscii(pattern);
  const ranges: [number, number][] = [];
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) {
    ranges.push([i, i + needle.length]);
  }
  return ranges;
}

// 一致部分を <mark> で囲んだ断片を作る
export function highlightedPreview(
  preview: string,
  pattern: string,
  matchCase: boolean
): DocumentFragment {
  const frag = document.createDocumentFragment();
  let at = 0;
  for (const [start, end] of highlightRanges(preview, pattern, matchCase)) {
    frag.append(preview.slice(at, start));
    const mark = document.createElement("mark");
    mark.textContent = preview.slice(start, end);
    frag.append(mark);
    at = end;
  }
  frag.append(preview.slice(at));
  return frag;
}
