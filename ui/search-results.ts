import type { WorkspaceSearchOptions, WorkspaceSearchResult } from "./api";

// 検索結果をファイル単位のツリーへ組み直す。表示の都合しか知らない純関数として
// 切り出し、DOM を作る Sidebar から独立してテストできるようにする。

export interface ResultGroup {
  relPath: string;
  fileName: string;
  dirPath: string; // ルートからの親フォルダ ("" ならルート直下)
  matches: WorkspaceSearchResult[];
}

// 結果の並びはここだけが決める (途中経過も確定結果も同じ関数を通す)。
// 途中経過は走査順で届くので UI 側の並べ替えは避けられない。backend でも並べると
// 同じ規則が2実装になり、片方だけ直したときに検索が終わった瞬間に並びが飛ぶ。
export function sortResults(
  results: WorkspaceSearchResult[],
  options: Pick<WorkspaceSearchOptions, "search_file_names" | "search_contents">
): WorkspaceSearchResult[] {
  const sorted = [...results];
  // ファイル名だけを探しているときは、パス順よりスコア順のほうが役に立つ
  // (VSCode の Quick Open と同じ狙い)。本文も混ざるならツリーの並びを優先する。
  if (options.search_file_names && !options.search_contents) {
    sorted.sort((a, b) => b.score - a.score || compare(a.rel_path, b.rel_path));
    return sorted;
  }
  // 同じファイル内ではファイル名一致を先に置く
  const kind = (result: WorkspaceSearchResult) => (result.is_filename ? 0 : 1);
  sorted.sort((a, b) =>
    compare(a.rel_path, b.rel_path) || kind(a) - kind(b) || a.line - b.line || a.col - b.col
  );
  return sorted;
}

// localeCompare は言語設定で並びが変わる。環境によらず同じ並びにするため素の大小比較
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// パス順に並んでいるため、隣り合う同じパスをまとめるだけでよい
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
