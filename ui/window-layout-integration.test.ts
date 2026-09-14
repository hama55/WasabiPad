import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { WindowLayoutCoordinator } from "./window-layout";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
const viewerSource = readFileSync(new URL("./viewer.ts", import.meta.url), "utf8");
const viewerRustSource = readFileSync(new URL("../src-tauri/src/viewer.rs", import.meta.url), "utf8");

describe("Feature: window layout integration", () => {
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
    expect(mainSource).toMatch(/capture:\s*\(\)\s*=>\s*\(\{\s*\.\.\.sidebar\.captureViewState\(\),\s*fileTreeWidth:\s*readSidebarWidth\(\)\s*\}\)/s);
    expect(mainSource).toMatch(/restore:\s*\(state\)\s*=>\s*\{\s*setSidebarWidth\(state\?\.fileTreeWidth\s*\?\?\s*getSetting\("sidebarWidth"\)\);\s*updateSidebarVisibility\(\);[\s\S]*?return sidebar\.restoreViewState\(state\);/s);
  });

  // Feature: プレビュー開閉ボタンの離脱時非表示
  // Scenario: メイン領域の外へポインターが出たらプレビュー開閉ボタンを非表示にする
  // Given: 近接表示を解除する関数と、ホバー中・フォーカス中のガードがある
  // When: `#main` の pointerleave イベントを登録する
  // Then: メイン領域外への離脱時に非表示予約を行い、既存のガードを維持する
  it("Scenario: メイン領域から離れた時にプレビュー開閉ボタンを非表示予約する", () => {
    expect(mainSource).toMatch(/mainEl\.addEventListener\("pointerleave",\s*hidePreviewTogglePeekLater\);/);
    expect(mainSource).toMatch(/if \(!previewToggleHovered && document\.activeElement !== previewToggle\)/);
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
    expect(viewerSource).toMatch(/const committed = await renderViewerState\(nextState, nextImageZoom\);[\s\S]*?if \(viewerDisposed \|\| !committed\) return;[\s\S]*?publishViewerRenderState\(nextState, nextImageZoom\)/s);
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
