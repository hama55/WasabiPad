import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { WindowLayoutCoordinator } from "./window-layout";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const viewerSource = readFileSync(new URL("./viewer.ts", import.meta.url), "utf8");
const viewerRustSource = readFileSync(new URL("../src-tauri/src/viewer.rs", import.meta.url), "utf8");

describe("Feature: window layout integration", () => {
  // Feature: 新規プレビューは空から読み込む
  // Given: 前のプレビュー表示と明示的な外部更新がある
  // When: 開始経路と更新経路を検査する
  // Then: 通常開始だけ旧本文と生成物を消し、明示更新だけ旧結果を維持する
  it("Scenario: 新しく開くときだけ前の表示を消す", () => {
    const open = mainSource.slice(mainSource.indexOf("function openPreviewFormat("), mainSource.indexOf("function sqlitePreviewSourcePath("));
    expect(open).toContain("const pendingContentClear = keepCurrentUntilOpened ? Promise.resolve() : inlinePreview.clear();");
    expect(open).toMatch(/await pendingContentClear;\s*if \(!isCurrentRequest\(\)\) return;\s*if \(!keepCurrentUntilOpened\) clearDisplayedExternalPreviewOutput\(\);/);
    expect(open).toContain("const previousPreviewDocument = keepCurrentUntilOpened ? previewDocument : null;");
    const refresh = mainSource.slice(mainSource.indexOf("async function refreshExternalPreview()"));
    expect(refresh).toContain("keepCurrentUntilOpened: true,");
    expect(mainSource).toContain("if (shouldResendPreviewOnRestore(previewDocument?.format ?? null)) inlinePreview.resend(true);");
  });
  // Feature: 外部プレビュー生成物の保存場所
  // Given: 表示済みの生成物と別の生成待ちパスがある
  // When: 本体のフォルダ操作経路を検査する
  // Then: 表示済み生成物のパスだけを既存Explorer APIへ渡す
  it("Scenario: 生成フォルダ操作は表示済みの結果を使う", () => {
    const reveal = mainSource.slice(mainSource.indexOf("  onRevealExternalOutput:"), mainSource.indexOf("  onRefresh:"));
    expect(reveal).toContain("externalPreviewOutputLifecycle.displayedOutputPath()");
    expect(reveal).toContain("if (!previewDocument?.externalAdapter || !path) return;");
    expect(reveal).toContain("await revealInExplorer(path, false);");
  });
  // Feature: プレビュー枠の先行表示
  // Given: 標準・外部のプレビューで本文準備や取消完了が遅れる
  // When: プレビュー開始経路を検査する
  // Then: 非同期処理を待つ前に共通の待機表示を開き、待機中の閉鎖も取り消す
  it("Scenario: 標準と外部の待機枠を準備処理より先に開く", () => {
    const open = mainSource.slice(mainSource.indexOf("function openPreviewFormat("), mainSource.indexOf("function sqlitePreviewSourcePath("));
    expect(open).toMatch(/openingPreviewRequestGeneration = requestGeneration;[\s\S]*?inlinePreview\.setPreviewStatus\([\s\S]*?await pendingViewerOpenCancellation/);
    expect(open).toContain('kind: externalAdapter ? "external" : "standard"');
    const close = mainSource.slice(mainSource.indexOf("function closePreview("), mainSource.indexOf("function selectPreviewPlacement("));
    expect(close).toContain("if (previewReplacementLifecycle.isReplacing() || externalPreviewRefreshPending)");
  });
  // Feature: 標準プレビューの読み込み失敗
  // Given: プレビューの本文準備が失敗する
  // When: 本体のエラー処理経路を検査する
  // Then: 現在の要求だけ待機を解除して理由を表示し、既存エラー通知を維持する
  it("Scenario: 標準の準備失敗を待機中のまま残さない", () => {
    const open = mainSource.slice(mainSource.indexOf("function openPreviewFormat("), mainSource.indexOf("function sqlitePreviewSourcePath("));
    const onError = open.slice(open.indexOf("  }, async (error) => {"));
    expect(onError).toMatch(/if \(!isCurrentRequest\(\)\) return;[\s\S]*?if \(!externalAdapter\)/);
    expect(onError).toContain('message: "読み込み失敗: " + detail, busy: false');
    expect(onError).toContain("await reportBackgroundError(errorTitle, error);");
  });
  // Feature: 読み込み失敗時の文書情報
  // Given: 通常の開始では前の本文を消し、明示更新では旧結果を保持する
  // When: 標準の本文準備が失敗する経路を検査する
  // Then: 保持を指定した要求だけ旧文書を参照し、通常開始は現在の文書を使う
  it("Scenario: 通常開始で消した旧文書の情報を失敗時に復元しない", () => {
    const open = mainSource.slice(mainSource.indexOf("function openPreviewFormat("), mainSource.indexOf("function sqlitePreviewSourcePath("));
    const onError = open.slice(open.indexOf("  }, async (error) => {"));
    expect(open).toContain("const previousPreviewDocument = keepCurrentUntilOpened ? previewDocument : null;");
    expect(onError).toContain("previewDocument = previousPreviewDocument ?? document;");
    expect(onError).toMatch(/kind: previousPreviewDocument\?\.externalAdapter && externalPreviewOutputLifecycle\.displayedOutputPath\(\)\s*\? "external" : "standard"/);
  });
  // Feature: 貼り付け画像の即時プレビュー
  // Given: 通常のプレビュー切替を通らずMarkdownを開く文書がある
  // When: エディタが画像貼り付けから直接プレビューを開く
  // Then: 本文を送る前に現在の文書の画像参照元を設定する
  it("Scenario: 直接開くMarkdownにも現在の文書の画像参照元を渡す", () => {
    const openViewer = mainSource.slice(mainSource.indexOf("  openViewer: async"), mainSource.indexOf("  updateViewer:"));
    expect(openViewer).toMatch(/if \(format === "markdown" && openingPreviewRequestGeneration === null\) \{\s*inlinePreview\.setSourcePath\(\s*sourcePathForViewer\(format, session\.savePath, session\.displayPath\),\s*session\.archivePath,\s*session\.archiveEntry,\s*session\.effectiveExtension,\s*\);\s*\}[\s\S]*?await inlinePreview\.open\(/);
  });
  // Given: 更新操作がプレビューの共通ツールバーにある
  // When: 外部生成物の表示・標準表示・表示クリアへ遷移する
  // Then: 外部生成物と動画で更新を表示し、外部生成物は保存確認付き更新へ渡す
  it("Scenario: 外部生成物と動画をツールバーから更新できる", () => {
    expect(viewerSource).toContain('previewRefreshButton.hidden = !isInlineViewer || (!external && currentFormat !== "video" && currentFormat !== "git");');
    expect(viewerSource).toMatch(/INLINE_PREVIEW_MESSAGES\.CLEAR_MESSAGE[\s\S]*?previewRefreshButton\.hidden = true;/);
    expect(mainSource).toContain('onRefresh: () => runBackground("プレビューを更新できませんでした"');
    expect(mainSource).toContain('if (previewDocument?.format === "video") inlinePreview.resend();');
    expect(mainSource).toContain('else return refreshExternalPreview();');
    expect(mainSource).not.toContain("updateExternalPreviewRefreshVisibility");
  });
  // Given: メイン画面にnative windowとDOMの寸法変更通知がある
  // When: resize・move・DPI・focus・標準ボタンの変更が届く
  // Then: すべてが同じレイアウト調整境界へ入り、初期表示後にも再要求される
  it("Scenario: main window changes use the shared layout coordinator", () => {
    expect(mainSource).toMatch(/layoutRuntime = createWindowLayoutRuntime\(window/);
    expect(mainSource).toMatch(/document\.documentElement\.style\.setProperty\("--sidebar-default-width"/);
    expect(mainSource).toMatch(/document\.documentElement\.style\.setProperty\("--sidebar-min-width"/);
    expect(mainSource).toMatch(/document\.documentElement\.style\.setProperty\("--pane-splitter-width"/);
    expect(mainSource).toMatch(/onGeometryChange:\s*\(\)\s*=>\s*layoutRuntime\?\.coordinator\.request\(\)/);
    expect(mainSource).toMatch(/onStateChange:\s*\(state\)\s*=>\s*\{[\s\S]*?state !== "minimized"[\s\S]*?layoutRuntime\?\.coordinator\.request\(\)/);
    expect(mainSource).toMatch(/try \{\s*applyPaneVisibility\(viewport\.width\);\s*editor\.syncWindowGeometry\(\);[\s\S]*?reportBackgroundError\("画面レイアウトを更新できませんでした"/);
    expect(mainSource).toMatch(/layoutRuntime\?\.coordinator\.refresh\(\);\s*await windowChrome\.syncWindowState\(\)/s);
    expect(mainSource).toMatch(/await win\.show\(\);\s*layoutRuntime\?\.coordinator\.request\(\)/s);
    expect(mainSource).toMatch(/layoutRuntime\?\.dispose\(\)/);
  });

  // Feature: プレビュー開閉ボタン幅の起動時同期
  // Scenario: TypeScriptの既定幅をメイン画面のCSSカスタムプロパティへ渡す
  // Given: プレビュー開閉ボタン幅を管理するTypeScript定数がある
  // When: メイン画面の初期CSS変数設定を検査する
  // Then: CSS変数は既定幅定数からpx値として設定される
  it("Scenario: 起動時にプレビュー開閉ボタン幅をCSSへ設定する", () => {
    expect(mainSource).toMatch(/mainEl\.style\.setProperty\("--preview-toggle-width",\s*`\$\{PREVIEW_TOGGLE_DEFAULT_WIDTH\}px`\)/);
  });

  // Feature: タブ別ファイルツリー幅
  // Scenario: タブのworkspace状態へ手動幅を接続する
  // Given: メイン画面がタブ管理とサイドバーを配線している
  // When: workspace状態のcapture/restore経路を検査する
  // Then: 幅をタブ状態へ保存し、未保存時は共通設定へ戻す
  it("Scenario: タブ切替のworkspace状態へファイルツリー幅を接続する", () => {
    expect(mainSource).toMatch(/capture:\s*\(\)\s*=>\s*\(\{\s*\.\.\.sidebar\.captureViewState\(\),\s*fileTreeWidth:\s*readSidebarWidth\(\)/s);
    expect(mainSource).toMatch(/restore:\s*async \(state\)\s*=>\s*\{[\s\S]*?setSidebarWidth\(state\?\.fileTreeWidth\s*\?\?\s*getSetting\("sidebarWidth"\)\);\s*updateSidebarVisibility\(\);[\s\S]*?await sidebar\.restoreViewState\(state\);/s);
  });

  // Feature: プレビューを開くボタンの離脱時非表示
  // Scenario: メイン領域の外へポインターが出たらプレビューを開くボタンを非表示にする
  // Given: 近接表示を解除する関数と、ホバー中・フォーカス中のガードがある
  // When: `#main` の pointerleave イベントを登録する
  // Then: メイン領域外への離脱時に非表示予約を行い、既存のガードを維持する
  it("Scenario: メイン領域から離れた時にプレビューを開くボタンを非表示予約する", () => {
    expect(mainSource).toMatch(/mainEl\.addEventListener\("pointerleave",\s*hidePreviewTogglePeekLater\);/);
    expect(mainSource).toMatch(/if \(!previewToggleHovered && !previewOpenButtons\.includes\(document\.activeElement as HTMLButtonElement\)\)/);
  });

  // Feature: 独立したプレビューを閉じる操作
  // Scenario: 専用ボタンで閉じ、キーボード操作なら開くボタンへフォーカスを戻す
  // Given: プレビューを閉じるボタンと開くボタンが別々にある
  // When: プレビューを閉じるボタンを押す
  // Then: 全画面状態を解除し、寸法を保ったまま閉じ、同じ方向の開くボタンへフォーカスする
  it("Scenario: 専用ボタンでプレビューを閉じキーボードフォーカスを戻す", () => {
    expect(mainSource).toContain("onClose: closePreview");
    expect(mainSource).toMatch(/function closePreview\(returnFocusToOpenButton = false\)[\s\S]*?previewCollapsed = true;[\s\S]*?previewFullscreen = false;[\s\S]*?updatePreviewVisibility\(\);[\s\S]*?if \(returnFocusToOpenButton\)\s*\{\s*previewOpenButtons\.find\(\(button\) => button\.dataset\.previewPlacement === previewPlacement\)\?\.focus\(\);/s);
    expect(mainSource).not.toContain('previewEl.style.removeProperty("width")');
  });

  // Feature: プレビューを開いた時のキーボード操作
  // Scenario: 開くボタンから専用の閉じるボタンへフォーカスを移す
  // Given: プレビューを開くボタンがキーボードフォーカス中
  // When: プレビューが表示状態へ切り替わる
  // Then: フォーカスを閉じるボタンへ引き継ぐ
  it("Scenario: キーボードでプレビューを開いたら閉じるボタンへフォーカスする", () => {
    expect(mainSource).toMatch(/const returnFocusToCloseButton = previewShown && previewOpenButtons\.some\(\(button\) => button\.matches\(":focus-visible"\)\);/);
    expect(mainSource).toContain("if (returnFocusToCloseButton) inlinePreview.focusCloseButton();");
  });

  // Given: プレビュー表示中でエディタ右端へポインターを寄せる
  // When: 別方向のボタンを押す
  // Then: 表示中の配置だけ更新し、payloadを再送しない
  it("Scenario: エディタ右端のボタンで閲覧中プレビューの配置だけ切り替える", () => {
    expect(mainSource).toMatch(/const boundary = editorHost\.getBoundingClientRect\(\)\.right;/);
    expect(mainSource).toContain("button.hidden = !isPreviewOpenButtonShown(previewState, previewPlacement, placement);");
    const shownBranch = mainSource.match(/function openPreview\(placement\?: PreviewPlacement\)\s*\{\s*if \(paneVisibilityAt\(measuredMainWidth\(\)\)\.previewShown\)\s*\{([\s\S]*?)\n  \}/)?.[1];
    expect(shownBranch).toContain("selectPreviewPlacement(placement)");
    expect(shownBranch).toContain("updatePreviewVisibility()");
    expect(shownBranch).not.toMatch(/resend|openPreviewFormat/);
    expect(shownBranch).toMatch(/if \(!placement \|\| placement === previewPlacement\) \{\s*closePreview\(\);\s*return;/);
  });

  // Feature: 選択行プレビューの明示的解除
  // Given: 選択行プレビューが表示されている
  // When: ×または同じ配置の切替ボタンで閉じる。幅不足では自動退避する
  // Then: 明示的な閉操作だけ以前のプレビュー範囲を解除する
  it("Scenario: 明示閉では範囲を解除し自動退避では保持する", () => {
    const close = mainSource.slice(mainSource.indexOf("function closePreview("), mainSource.indexOf("function selectPreviewPlacement("));
    expect(mainSource).toContain("onClose: closePreview");
    expect(close).toContain("editor.resetPreviewRange()");
    expect(close).toContain("previewDocument.rangeReset = true");
    const visibility = mainSource.slice(mainSource.indexOf("function applyPaneVisibility("), mainSource.indexOf("function updateSidebarVisibility("));
    expect(visibility).not.toMatch(/resetPreviewRange|closePreview\(/);
  });

  // Feature: Gitプレビューの表示維持
  // Given: 同じ.gitをすでに閲覧している
  // When: ツリーで同じ.gitを再選択する
  // Then: 閉操作へ渡さず、非表示のときだけ再表示する
  it("Scenario: 同じGit対象の再選択はプレビューを閉じない", () => {
    const openGit = mainSource.slice(mainSource.indexOf("async function openGitPreview("), mainSource.indexOf("async function navigateTreeEntry("));
    expect(openGit).toMatch(/if \(gitPreviewTarget\?\.path === path\) \{\s*gitPreviewTarget\.collapsed = false;\s*if \(!paneVisibilityAt\(measuredMainWidth\(\)\)\.previewShown\) openPreview\(\);/);
  });

  // Given: 独立viewerが最大化・最小化・復元と内容更新を受け取る
  // When: windowのresize・移動・DPI・focusまたはnative state changeが届く
  // Then: 画像・表・グラフを共有の有効viewport反映へまとめる
  it("Scenario: standalone viewer changes use the shared layout coordinator", () => {
    expect(viewerSource).toMatch(/viewerLayoutRuntime = createWindowLayoutRuntime\(window/);
    expect(viewerSource).toMatch(/onGeometryChange:\s*\(\) => viewerLayoutCoordinator\?\.request\(\)/);
    expect(viewerSource).toMatch(/onStateChange:\s*\(state\) => \{[\s\S]*?state !== "minimized"[\s\S]*?viewerLayoutCoordinator\?\.request\(\)/);
    expect(viewerSource).toMatch(/viewerLayoutCoordinator\?\.refresh\(\);\s*viewerLayoutCoordinator\?\.request\(\)/s);
    expect(viewerSource).toMatch(/viewerLayoutRuntime\?\.dispose\(\)/);
    expect(viewerSource).toMatch(/function beginRender\(\): number/);
    expect(viewerSource).toMatch(/content\.classList\.add\("viewer-loading"\)/);
    expect(viewerSource).toMatch(/content\.classList\.remove\("viewer-loading"\)/);
    expect(viewerSource).toMatch(/async function renderAssetPreview[\s\S]*?finishRender\(generation\)/s);
    expect(viewerSource).toMatch(/function disposeViewer\(\)[\s\S]*?renderGeneration \+= 1;/s);
    expect(viewerSource).toMatch(/const viewerDomListeners = new AbortController\(\)/);
    expect(viewerSource).toMatch(/function disposeViewer\(\)[\s\S]*?viewerDomListeners\.abort\(\)/s);
    expect(viewerSource).toMatch(/let viewerDisposed = false/);
    expect(viewerSource).toMatch(/function disposeViewer\(\)[\s\S]*?viewerDisposed = true/);
    expect(viewerSource).toMatch(/function beginRender\(\): number[\s\S]*?querySelectorAll<HTMLElement>\("\:scope > \.viewer-pending"\)/s);
    expect(viewerSource).toMatch(/const committed = await renderViewerState\(nextState, nextImageZoom(?:, requireLoadedOutput)?\);[\s\S]*?if \(viewerDisposed \|\| !committed\) return(?: false)?;[\s\S]*?publishViewerRenderState\(nextState, nextImageZoom\)/s);
    expect(viewerSource).toMatch(/previousDisposeImagePan\?\.\(\)/);
    expect(viewerRustSource).toMatch(/\.inner_size\(960\.0, 700\.0\)\s*\.visible\(false\)/s);
    expect(viewerSource).toMatch(/if \(!isInlineViewer\) await win!\.show\(\);[\s\S]*?await renderPayload\(await takeViewerPayload\(win!\.label\)\);/);
  });

  // Given: native/DOMの複数通知を同じlayout coordinatorへ接続している
  // When: resize・復元・DPI通知を同一フレーム内に受け取る
  // Then: 最新の有効viewportを1回だけ反映する
  it("Scenario: 複数のgeometry通知を1つの描画境界へまとめる", () => {
    let callback: (() => void) | undefined;
    const apply = vi.fn();
    const coordinator = new WindowLayoutCoordinator({
      measure: () => ({ width: 900, height: 700 }),
      apply,
      requestFrame: (next) => {
        callback = next;
        return 1;
      },
      cancelFrame: () => { callback = undefined; },
    });

    coordinator.request();
    coordinator.request();
    coordinator.request();
    callback?.();

    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith({ width: 900, height: 700 });
  });
});
