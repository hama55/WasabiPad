// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const { chartMock } = vi.hoisted(() => ({
  chartMock: vi.fn(function () {
    return { destroy: vi.fn(), data: { datasets: [] }, isDatasetVisible: vi.fn() };
  }),
}));
vi.mock("chart.js/auto", () => ({ default: chartMock }));

import { ViewerChartController } from "./viewer-chart";

type ChartConfig = {
  type: string;
  data: { labels: string[]; datasets: Array<{ label?: string; data: unknown[] }> };
};

function chartConfig(): ChartConfig {
  const call = chartMock.mock.calls[0] as unknown as [HTMLCanvasElement, ChartConfig];
  return call[1];
}

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
  return { controller, run, panel, content };
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

  // Given: グラフ設定ダイアログが表示されている
  // When: 種類をヒストグラムへ変更し、X軸だけを選択して作成する
  // Then: Y軸を要求せず、Chart.jsへ描画を委譲する
  it("Scenario: ヒストグラムはX軸だけで描画する", () => {
    const { controller } = createController();
    controller.openDialog();
    const type = document.querySelector<HTMLSelectElement>(".viewer-dialog select")!;
    type.value = "histogram";
    type.dispatchEvent(new Event("change"));
    expect(document.querySelector<HTMLElement>(".chart-column-grid")?.hidden).toBe(true);
    const x = document.querySelectorAll<HTMLSelectElement>(".viewer-dialog select")[1]!;
    x.value = "1";
    document.querySelector<HTMLButtonElement>(".viewer-dialog-buttons .primary")?.click();

    expect(chartMock).toHaveBeenCalledOnce();
    const config = chartConfig();
    expect(config.type).toBe("bar");
    expect(config.data.labels).toEqual(["1"]);
    expect(config.data.datasets).toHaveLength(1);
    expect(config.data.datasets[0].data).toEqual([1]);
  });

  // Given: X軸と数値Y軸を含む表データ
  // When: 有効なグラフ設定で作成する
  // Then: Chart.jsへ委譲し、表をグラフ表示へ切り替える
  it("Scenario: 選択済みの表データをChart.jsへ委譲する", () => {
    const { controller } = createController();
    controller.openDialog();

    document.querySelector<HTMLButtonElement>(".viewer-dialog-buttons .primary")?.click();

    expect(chartMock).toHaveBeenCalledOnce();
    const config = chartConfig();
    expect(config.type).toBe("line");
    expect(config.data.datasets[0].label).toBe("value");
    expect(config.data.datasets[0].data).toEqual([1]);
  });

  // Given: 描画済みChart.jsインスタンスのdestroyが例外を投げる
  // When: グラフを閉じる
  // Then: 表示状態と内部状態の後始末を先に完了し、例外は呼び出し元へ返す
  it("Scenario: Chart破棄失敗でも内部状態を解放する", () => {
    const { controller, run, panel, content } = createController();
    controller.openDialog();
    document.querySelector<HTMLButtonElement>(".viewer-dialog-buttons .primary")?.click();
    const chart = chartMock.mock.results[0].value;
    chart.destroy.mockImplementation(() => { throw new Error("destroy failed"); });

    expect(() => controller.close()).toThrow("destroy failed");
    expect(panel.hidden).toBe(true);
    expect(content.hidden).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });
});
