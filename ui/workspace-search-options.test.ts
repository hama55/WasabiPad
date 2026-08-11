import { describe, expect, it } from "vitest";
import type { WorkspaceSearchOptions } from "./api";
import {
  DEFAULT_SEARCH_OPTIONS,
  OPTION_TEXTS,
  clampSearchOptions,
  optionTitle,
  sameSearchOptions,
  searchScopeSummary,
} from "./workspace-search-options";

const options = (overrides: Partial<WorkspaceSearchOptions> = {}): WorkspaceSearchOptions => ({
  ...DEFAULT_SEARCH_OPTIONS,
  ...overrides,
});

describe("Feature: ワークスペース検索オプション", () => {
  // Given: 数値上限外、NaN、重複と空白を含む検索条件
  // When: clampSearchOptionsを呼ぶ
  // Then: 数値を範囲内へ丸め、リストを正規化する
  it("Scenario: 検索オプションを安全な範囲へ丸める", () => {
    const result = clampSearchOptions({
      ...options(),
      max_files: -1,
      max_results: 2_000_000,
      workers: Number.NaN,
      exclude_dirs: [" .git ", "", ".git"],
      exclude_globs: [" *.map ", "*.map"],
    });

    expect(result.max_files).toBe(0);
    expect(result.max_results).toBe(1_000_000);
    expect(result.workers).toBe(0);
    expect(result.exclude_dirs).toEqual([".git"]);
    expect(result.exclude_globs).toEqual(["*.map"]);
  });

  // Given: 同じ検索条件と、リスト順だけが異なる検索条件
  // When: sameSearchOptionsを呼ぶ
  // Then: 値が完全一致する場合だけtrueを返す
  it("Scenario: 検索条件の変更を配列順も含めて検出する", () => {
    const first = options();
    expect(sameSearchOptions(first, options())).toBe(true);
    expect(sameSearchOptions(first, options({ exclude_dirs: [...first.exclude_dirs].reverse() }))).toBe(false);
    expect(sameSearchOptions(first, options({ match_case: true }))).toBe(false);
  });

  // Given: ヒントを持つフラグと持たないフラグ
  // When: optionTitleを呼ぶ
  // Then: ラベルだけ、またはラベルとヒントを返す
  it("Scenario: 検索オプションの表示名をSSoTから組み立てる", () => {
    expect(optionTitle("match_case")).toBe(OPTION_TEXTS.match_case.label);
    expect(optionTitle("whole_word")).toContain(OPTION_TEXTS.whole_word.label);
    expect(optionTitle("whole_word")).toContain(OPTION_TEXTS.whole_word.hint);
  });

  // Given: 本文検索とファイル名検索の組み合わせ、fuzzy、除外条件
  // When: searchScopeSummaryを呼ぶ
  // Then: 対象と除外条件を現在値から説明する
  it("Scenario: 検索対象と除外条件の概要を正しく表示する", () => {
    const summary = searchScopeSummary(options({
      match_case: true,
      use_regex: true,
      whole_word: true,
      exclude_binary: true,
      respect_gitignore: true,
      max_files: 5,
      exclude_dirs: [".git"],
      exclude_globs: ["*.map"],
    }), "fuzzy");

    expect(summary).toContain("検索対象: ファイル名と本文");
    expect(summary).toContain("検索対象外:");
    expect(summary).toContain(".gitignore");
    expect(summary).toContain("5件目");
  });

  // Given: ファイル名検索と本文検索の両方が無効
  // When: searchScopeSummaryを呼ぶ
  // Then: 存在しない検索対象を「ファイル名のみ」と誤表示しない
  it("Scenario: 検索対象がない場合は対象なしと表示する", () => {
    const summary = searchScopeSummary(options({
      search_file_names: false,
      search_contents: false,
    }), "fuzzy");

    expect(summary).toContain("検索対象: 検索対象なし");
  });
});
