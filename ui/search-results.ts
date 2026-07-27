import type { WorkspaceSearchResult } from "./api";

// 検索結果をファイル単位のツリーへ組み直す。表示の都合しか知らない純関数として
// 切り出し、DOM を作る Sidebar から独立してテストできるようにする。

export interface ResultGroup {
  relPath: string;
  fileName: string;
  dirPath: string; // ルートからの親フォルダ ("" ならルート直下)
  matches: WorkspaceSearchResult[];
}

// 途中経過は走査順で届くため、確定結果と同じ順に並べ直してから見せる。
// そうしないと検索が終わった瞬間に並びが飛び、目で追っていた行を見失う。
// 規則は core/src/workspace_search.rs の sort_hits と一対で、両方直す必要がある。
export function sortResults(
  results: WorkspaceSearchResult[],
  byScore: boolean
): WorkspaceSearchResult[] {
  const sorted = [...results];
  if (byScore) {
    // ファイル名だけを探しているときは、当てはまりの良い順
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

// localeCompare は言語設定で並びが変わる。backend の素の大小比較に合わせる
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
