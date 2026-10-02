import { describe, expect, it, vi } from "vitest";
import {
  createViewerFormatHandlers,
  canRenderViewerFormat,
  isAssetViewerFormat,
  isSqliteCandidatePath,
  isViewerFormat,
  resolveSqlitePreviewAction,
  sourcePathForViewer,
  viewerFormatForAutomaticPreview,
  viewerFormatForPreviewToggle,
  viewerFormatForPath,
  viewerFormatSpec,
} from "./viewer-formats";
import { MENU_ICON } from "./menu-icons";

describe("Feature: viewer formats", () => {
  // Given: 大文字小文字が混在する通常MOV・MP4とテキスト
  // When: 自動形式と描画可否、資産パスを判定する
  // Then: 動画だけを動画形式で直接参照し、テキストとして解釈しない
  it("Scenario: MOV・MP4を動画として自動判定する", () => {
    expect(viewerFormatForAutomaticPreview("clip.MOV")).toBe("video");
    expect(viewerFormatForPreviewToggle("clip.Mp4")).toBe("video");
    expect(sourcePathForViewer("video", null, "C:\\work\\clip.MOV")).toBe("C:\\work\\clip.MOV");
    expect(canRenderViewerFormat("video", "clip.mov")).toBe(true);
    expect(canRenderViewerFormat("video", "notes.md")).toBe(false);
    expect(canRenderViewerFormat("markdown", "clip.mp4")).toBe(false);
    expect(canRenderViewerFormat("video", "clip.mov", true)).toBe(false);
  });
  // Given: `report.CSV`、`notes.Markdown`、`photo.PNG`、`manual.PDF`、`manual.HTML`、`data.SQLITE3`、`notes.txt`を指定
  // When: `viewerFormatForPath`を呼ぶ
  // Then: それぞれ`csv`、`markdown`、`image`、`pdf`、`html`、`null`
  it("Scenario: resolves registered extensions case-insensitively", () => {
    expect(viewerFormatForPath("report.CSV")).toBe("csv");
    expect(viewerFormatForPath("notes.Markdown")).toBe("markdown");
    expect(viewerFormatForPath("photo.PNG")).toBe("image");
    expect(viewerFormatForPath("manual.PDF")).toBe("pdf");
    expect(viewerFormatForPath("manual.HTML")).toBe("html");
    expect(viewerFormatForPath("data.SQLITE3")).toBe("sqlite");
    expect(viewerFormatForPath("data.DB")).toBeNull();
    expect(viewerFormatForPath("notes.txt")).toBeNull();
  });

  // Feature: 自動プレビューのSQLite候補
  // Scenario: SQLite候補拡張子だけをSQLiteプローブへ送る
  // Given: .db、既存のSQLite拡張子、通常の未知拡張子
  // When: 自動プレビュー形式を判定する
  // Then: 候補3拡張子をSQLiteへ送り、その他は従来どおり未分類にする
  it("Scenario: 自動プレビューでは候補拡張子だけをSQLiteへ送る", () => {
    expect(viewerFormatForAutomaticPreview("data.db")).toBe("sqlite");
    expect(viewerFormatForAutomaticPreview("data.sqlite")).toBe("sqlite");
    expect(viewerFormatForAutomaticPreview("data.sqlite3")).toBe("sqlite");
    expect(viewerFormatForAutomaticPreview("payload.bin")).toBeNull();
  });

  // Feature: 常時表示プレビューボタンの既定形式
  // Scenario: 未登録拡張子のテキストだけMarkdownとして開く
  // Given: CSV、GIF、通常テキスト、未知バイナリの各文書
  // When: プレビューボタン用の表示形式を判定する
  // Then: 登録形式を優先し、未登録拡張子はMarkdownで手動表示できる
  it("Scenario: 未登録拡張子のテキストをMarkdownビューで開く", () => {
    expect(viewerFormatForPreviewToggle("data.csv")).toBe("csv");
    expect(viewerFormatForPreviewToggle("data.sqlite")).toBe("sqlite");
    expect(viewerFormatForPreviewToggle("data.DB")).toBe("sqlite");
    expect(viewerFormatForPreviewToggle("animation.gif")).toBe("image");
    expect(viewerFormatForPreviewToggle("notes.txt")).toBe("markdown");
    expect(viewerFormatForPreviewToggle("payload.bin")).toBe("markdown");
  });

  // Feature: SQLiteプレビュー候補を限定する
  // Scenario: .db、.sqlite、.sqlite3だけをヘッダー検査候補とする
  // Given: 候補拡張子と対象外拡張子のパス
  // When: SQLite候補判定を行う
  // Then: 候補拡張子を大文字小文字を問わず判定し、その他を除外する
  it("Scenario: SQLite候補拡張子を大文字小文字を問わず判定する", () => {
    expect(isSqliteCandidatePath("C:\\work\\data.db")).toBe(true);
    expect(isSqliteCandidatePath("C:\\work\\data.SQLITE")).toBe(true);
    expect(isSqliteCandidatePath("C:\\work\\data.Sqlite3")).toBe(true);
    expect(isSqliteCandidatePath("C:\\work\\data.sqlite3.txt")).toBe(false);
    expect(isSqliteCandidatePath("C:\\work\\data.bin")).toBe(false);
  });

  // Feature: すべてのSQLite起動経路でヘッダープローブ結果を共有する
  // Scenario: 一致、不一致、実ファイルパスなしを各経路の結果へ割り当てる
  // Given: SQLiteヘッダープローブと自動同期・プレビューボタン・形式切替の方針
  // When: SQLiteプレビュー動作を解決する
  // Then: 一致ならSQLite、不一致なら各経路の既定動作、対象外パスならプローブなしでクリアする
  it("Scenario: SQLiteプローブ結果を各起動経路の動作へ割り当てる", async () => {
    const probe = vi.fn(async () => true);
    expect(await resolveSqlitePreviewAction("C:\\work\\data.db", "clear", probe)).toBe("sqlite");

    probe.mockResolvedValue(false);
    expect(await resolveSqlitePreviewAction("C:\\work\\data.sqlite", "clear", probe)).toBe("clear");
    expect(await resolveSqlitePreviewAction("C:\\work\\data.sqlite3", "markdown", probe)).toBe("markdown");
    expect(await resolveSqlitePreviewAction("C:\\work\\data.db", "keep", probe)).toBe("keep");
    expect(await resolveSqlitePreviewAction(null, "markdown", probe)).toBe("clear");
    expect(await resolveSqlitePreviewAction(null, "keep", probe)).toBe("keep");
    expect(await resolveSqlitePreviewAction("C:\\work\\data.bin", "markdown", probe)).toBe("markdown");
    expect(probe).toHaveBeenCalledTimes(4);
  });

  // Given: markdown/png/pdf/未指定のデータ
  // When: 各形式の描画可否を判定する
  // Then: 画像/PDFは対応データだけで、テキスト形式はテキストデータで描画できる
  it("Scenario: データ種別に応じて描画できる形式を判定する", () => {
    expect(canRenderViewerFormat("image", "notes.md")).toBe(false);
    expect(canRenderViewerFormat("pdf", "photo.png")).toBe(false);
    expect(canRenderViewerFormat("image", "photo.png")).toBe(true);
    expect(canRenderViewerFormat("pdf", "manual.pdf")).toBe(true);
    expect(canRenderViewerFormat("csv", "notes.md")).toBe(true);
    expect(canRenderViewerFormat("markdown", null)).toBe(true);
    expect(canRenderViewerFormat("image", null)).toBe(false);
    expect(canRenderViewerFormat("sqlite", "data.sqlite")).toBe(true);
    expect(canRenderViewerFormat("csv", "data.sqlite")).toBe(false);
    expect(canRenderViewerFormat("sqlite", "data.db")).toBe(true);
    expect(canRenderViewerFormat("markdown", "data.db")).toBe(false);
    expect(canRenderViewerFormat("sqlite", null)).toBe(false);
  });

  // Given: 画像・PDF・テキストのビュー形式
  // When: 資産プレビュー形式かを判定する
  // Then: 画像とPDFだけが実ファイルを必要とする
  it("Scenario: treats PDF as an asset preview", () => {
    expect(isAssetViewerFormat("image")).toBe(true);
    expect(isAssetViewerFormat("pdf")).toBe(true);
    expect(isAssetViewerFormat("markdown")).toBe(false);
    expect(isAssetViewerFormat(null)).toBe(false);
  });

  // Given: 保存先を持たないPDF/SQLite、保存先を持つSQLite、通常のMarkdown文書
  // When: ビューへ渡す実ファイルパスを求める
  // Then: PDFとSQLiteは表示パス、Markdownはnullになる
  it("Scenario: keeps the direct path for read-only asset and SQLite previews", () => {
    expect(sourcePathForViewer("pdf", null, "C:\\work\\manual.pdf"))
      .toBe("C:\\work\\manual.pdf");
    expect(sourcePathForViewer("markdown", null, "C:\\work\\notes.md")).toBeNull();
    expect(sourcePathForViewer("sqlite", null, "C:\\work\\data.sqlite"))
      .toBe("C:\\work\\data.sqlite");
    expect(sourcePathForViewer("sqlite", "C:\\work\\data.sqlite", "C:\\work\\data.sqlite"))
      .toBe("C:\\work\\data.sqlite");
  });

  // Given: csv/markdown/image/pdf/htmlの形式レジストリ
  // When: `viewerFormatSpec`を呼ぶ
  // Then: csvはdelimiter/chartとも`true`、markdown/imageはともに`false`
  it("Scenario: keeps format capabilities in the registry", () => {
    expect(viewerFormatSpec("csv").supportsDelimiter).toBe(true);
    expect(viewerFormatSpec("csv").supportsChart).toBe(true);
    expect(viewerFormatSpec("csv").supportsDefaultBrowser).toBe(false);
    expect(viewerFormatSpec("csv").iconClass).toBe(MENU_ICON.csv);
    expect(viewerFormatSpec("markdown").supportsDelimiter).toBe(false);
    expect(viewerFormatSpec("markdown").supportsChart).toBe(false);
    expect(viewerFormatSpec("image").supportsDelimiter).toBe(false);
    expect(viewerFormatSpec("image").supportsChart).toBe(false);
    expect(viewerFormatSpec("image").title).toBe("Image");
    expect(viewerFormatSpec("pdf").extensions).toEqual([".pdf"]);
    expect(viewerFormatSpec("html").extensions).toEqual([".html", ".htm"]);
    expect(viewerFormatSpec("html").supportsDelimiter).toBe(false);
    expect(viewerFormatSpec("html").supportsChart).toBe(false);
    expect(viewerFormatSpec("html").supportsDefaultBrowser).toBe(true);
    expect(viewerFormatSpec("html").iconClass).toBe(MENU_ICON.html);
  });

  // Given: 形式レジストリに登録済みの`csv`/`markdown`/`image`/`pdf`/`html`と未登録の`unknown`
  // When: `isViewerFormat`を呼ぶ
  // Then: 登録済みだけをビュー形式として受け入れる
  it("Scenario: validates preview formats through the registry", () => {
    expect(isViewerFormat("csv")).toBe(true);
    expect(isViewerFormat("markdown")).toBe(true);
    expect(isViewerFormat("image")).toBe(true);
    expect(isViewerFormat("pdf")).toBe(true);
    expect(isViewerFormat("html")).toBe(true);
    expect(isViewerFormat("sqlite")).toBe(true);
    expect(isViewerFormat("unknown")).toBe(false);
    expect(isViewerFormat(null)).toBe(false);
  });

  // Given: csv/markdown/image/pdf/html/sqlite用のrenderer mockを登録
  // When: `createViewerFormatHandlers`を呼ぶ
  // Then: 各形式の`render`はmock、markdownのlabelは`Markdownビュー`
  it("Scenario: combines metadata and renderers through one typed registry", () => {
    const csvRenderer = vi.fn();
    const markdownRenderer = vi.fn();
    const imageRenderer = vi.fn();
    const pdfRenderer = vi.fn();
    const htmlRenderer = vi.fn();
    const sqliteRenderer = vi.fn();
    const handlers = createViewerFormatHandlers({
      csv: csvRenderer, markdown: markdownRenderer, image: imageRenderer, pdf: pdfRenderer, html: htmlRenderer,
      sqlite: sqliteRenderer,
      video: vi.fn(),
    });

    expect(handlers.csv.render).toBe(csvRenderer);
    expect(handlers.markdown.label).toBe("Markdownビュー");
    expect(handlers.image.render).toBe(imageRenderer);
    expect(handlers.pdf.render).toBe(pdfRenderer);
    expect(handlers.html.render).toBe(htmlRenderer);
    expect(handlers.sqlite.render).toBe(sqliteRenderer);
    expect(handlers.csv.title).toBe("CSV");
    expect(handlers.markdown.title).toBe("Markdown");
  });
});
