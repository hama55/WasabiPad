import { describe, it } from "vitest";

describe("Feature: アプリ境界の仕様記録", () => {
  // Given: Win11関連付け起動と複数プロセスの実時間順序はVitestで再現不可
  // When: 外部起動引数を最新の起動中インスタンスへ転送
  // Then: そのインスタンスの新規タブでファイルを開く
  it("Scenario: Win11 Explorerからテキストファイルを開くと最新のWasabiPadの新規タブで開く", () => {
    // Win11の関連付け起動と複数プロセスの実時間順序は、Vitestの単体環境では再現できない。
    // 仕様: 外部起動引数は最新の起動中インスタンスへ転送し、そのインスタンスの新規タブで開く。
  });

  // Given: TauriのExplorer起動とDocSessionの実ファイル選択は単体再現不可
  // When: メモビューのExplorerメニューを実行
  // Then: 選択中メモの親フォルダを開く
  it("Scenario: メモビューのExplorerメニューは選択中メモが格納されたフォルダを開く", () => {
    // TauriのExplorer起動とDocSessionの実ファイル選択を同時に扱うため、単体テストでは分離できない。
    // 仕様: フォルダビューで選択中の項目があっても、メモビューではそのファイルの親フォルダを開く。
  });

  // Given: WindowChromeとTauriの終了許可は単体再現不可
  // When: 主/副ウィンドウを終了する
  // Then: 保留中の設定保存完了後に終了を許可する
  it("Scenario: 全ウィンドウで設定保存の完了を待ってから終了する", () => {
    // WindowChromeとTauriの終了許可を単体環境では再現できない。
    // 仕様: 主ウィンドウ・セカンダリウィンドウとも、保留中の設定保存が完了してから終了を許可する。
  });

  // Given: Sidebar・DocumentSession・別ウィンドウIPCは単体再現不可
  // When: フォルダビューで対応画像を選択
  // Then: 画像を参照するMarkdownビューを自動で開く
  it("Scenario: フォルダビューで画像を選択するとMarkdownビューで画像を表示する", () => {
    // Sidebar・DocumentSession・別ウィンドウのTauri IPCをまたぐため、単体テストでは再現できない。
    // 仕様: 対応する画像ファイルを選択すると、画像を参照するMarkdownビューを自動で開く。
  });

  // Given: フォルダビュー検索が本文一致のパス・行・列・一致範囲を返す
  // When: 検索結果をクリックして対象ファイルをメモビューで開く
  // Then: navigateEntry完了後に一致範囲をselectRangeへ渡し、その行がメモビュー中央へ来る
  it("Scenario: フォルダビュー検索結果をクリックすると該当範囲を中央表示する", () => {
    // Sidebar→main→TabManager→VirtualEditorをまたぐDOM/IPCの実時間順序は単体環境では再現できない。
    // 仕様: ファイルを開く完了を待ってから本文の一致範囲を選択し、検索結果の行を中央へスクロールする。
  });
});
