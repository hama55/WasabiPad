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

  // Given: 独立viewerが最大化・最小化・復元と内容更新を受け取る
  // When: windowのresize・移動・DPI・focusまたはnative state changeが届く
  // Then: 画像・表・グラフを共有の有効viewport反映へまとめる
  it("Scenario: standalone viewer changes use the shared layout coordinator", () => {
    expect(viewerSource).toMatch(/viewerLayoutRuntime = createWindowLayoutRuntime\(window/);
    expect(viewerSource).toMatch(/onGeometryChange:\s*\(\) => viewerLayoutCoordinator\?\.request\(\)/);
    expect(viewerSource).toMatch(/onStateChange:\s*\(state\) => \{[\s\S]*?state !== "minimized"[\s\S]*?viewerLayoutCoordinator\?\.request\(\)/);
    expect(viewerSource).toMatch(/viewerLayoutCoordinator\?\.refresh\(\);[\s\S]*?if \(!isInlineViewer\) await win!\.show\(\);\s*viewerLayoutCoordinator\?\.request\(\)/s);
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
    expect(viewerSource).toMatch(/await renderPayload\(await takeViewerPayload\(win!\.label\)\);[\s\S]*?await win!\.show\(\)/);
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
