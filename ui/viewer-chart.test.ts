// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const { chartMock } = vi.hoisted(() => ({
  chartMock: vi.fn(function () {
    return { destroy: vi.fn(), data: { datasets: [] }, isDatasetVisible: vi.fn() };
  }),
}));
vi.mock("chart.js/auto", () => ({ default: chartMock }));

import { ViewerChartController } from "./viewer-chart";

function createController() {
  const panel = document.createElement("section");
  const title = document.createElement("h1");
  const canvas = document.createElement("canvas");
  const content = document.createElement("div");
  const run = vi.fn((operation: () => void) => operation());
  const onClose = vi.fn();
  const controller = new ViewerChartController({ panel, title, canvas, content, run, onClose });
  controller.setRows([
    ["name", "value"],
    ["first", "1"],
  ]);
  document.body.append(panel, content);
  return { controller, run };
}

describe("Feature: Chart viewer drawing boundary", () => {
  afterEach(() => {
    chartMock.mockClear();
    document.body.innerHTML = "";
  });

  // Given: 表形式の行データを受け取ったChart専用controller
  // When: グラフ設定ダイアログを開く
  // Then: Chart描画のための設定UIだけを生成する
  it("Scenario: グラフ設定を専用controllerへ委譲する", () => {
    const { controller } = createController();

    controller.openDialog();

    expect(document.querySelector(".viewer-dialog h2")?.textContent).toBe("グラフ作成");
    expect(document.querySelectorAll(".chart-column-grid input")).toHaveLength(2);
  });

  // Feature: グラフ設定ダイアログのキャンセル
  // Scenario: Escapeでダイアログを閉じる
  // Given: グラフ設定ダイアログが表示されている
  // When: Escapeキーを押す
  // Then: グラフ描画せずにダイアログを閉じる
  it("Scenario: Escapeでグラフ設定ダイアログを閉じる", () => {
    const { controller, run } = createController();
    controller.openDialog();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(run).not.toHaveBeenCalled();
    expect(document.querySelector(".viewer-dialog-overlay")).toBeNull();
  });

  // Given: X軸以外のY軸が選択されていないグラフ設定
  // When: 作成ボタンを押す
  // Then: 描画処理を実行せず入力エラーを表示する
  it("Scenario: Y軸未選択のグラフを描画しない", () => {
    const { controller, run } = createController();
    controller.openDialog();
    document.querySelectorAll<HTMLInputElement>(".chart-column-grid input").forEach((input) => {
      input.checked = false;
    });

    document.querySelector<HTMLButtonElement>(".viewer-dialog-buttons .primary")?.click();

    expect(document.querySelector(".viewer-dialog-error")?.textContent)
      .toBe("Y軸を1列以上選択してください");
    expect(run).not.toHaveBeenCalled();
  });

  // Given: X軸と数値Y軸を含む表データ
  // When: 有効なグラフ設定で作成する
  // Then: Chart.jsへ委譲し、表をグラフ表示へ切り替える
  it("Scenario: 選択済みの表データをChart.jsへ委譲する", () => {
    const { controller } = createController();
    controller.openDialog();

    document.querySelector<HTMLButtonElement>(".viewer-dialog-buttons .primary")?.click();

    expect(chartMock).toHaveBeenCalledOnce();
  });
});
