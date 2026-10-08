// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { DiagramDocument, readDiagramSvg, writeDiagramSvg, validateStandaloneSvg } from "./diagram";
import { composeDiagramPreview } from "./diagram-assets";

describe("Feature: 編集図の保存と再編集", () => {
  // Given: 六種類の図形と二つの重なり要素
  // When: 前面・背面へ変更し、SVG に保存する
  // Then: 各種類と色・太さ・文字を保持する
  it("Scenario: 各図形と重なり順を再編集できる", () => {
    const doc = new DiagramDocument({ width: 800, height: 600, elements: [] });
    for (const kind of ["rect", "ellipse", "line", "arrow", "callout", "text"] as const) doc.add({ kind, x: 10, y: 20, width: 100, height: 60, stroke: "#123456", strokeWidth: 4, fill: "#abcdef", text: "説明\n補足", textColor: "#000000", fontSize: 24 });
    doc.reorder(1, true);
    expect(doc.value.elements.at(-1)?.id).toBe(1);
    doc.reorder(1, false);
    expect(doc.value.elements[0].id).toBe(1);
    const svg = writeDiagramSvg(doc.value);
    expect(readDiagramSvg(svg)).toEqual(doc.value);
    expect(svg).toContain("<ellipse"); expect(svg).toContain("<path"); expect(svg).toContain("<tspan");
  });
  // Given: 同じ背景画像に赤枠と複数行の説明を重ねた図
  // When: SVGを保存して再編集する
  // Then: 背景参照と図形・文字が保持され、画像バイトは埋め込まれない
  it("Scenario: 共有背景と注釈をSVGで再編集できる", () => {
    const doc = new DiagramDocument({ width: 800, height: 600, elements: [] });
    doc.add({ kind: "image", x: 0, y: 0, width: 800, height: 600, src: "background.png" });
    doc.add({ kind: "rect", x: 10, y: 20, width: 120, height: 80, stroke: "#ff0000", strokeWidth: 3, fill: "none" });
    doc.add({ kind: "text", x: 30, y: 40, width: 150, height: 80, text: "説明<&\n次の行", fill: "#000000", fontSize: 20 });
    const svg = writeDiagramSvg(doc.value);
    expect(readDiagramSvg(svg)).toEqual(doc.value);
    expect(svg).toContain('href="background.png"');
    expect(svg).not.toContain("data:image");
  });

  // Given: 保存した図は共有背景を参照する
  // When: Markdown プレビューを組み立てる
  // Then: 表示用だけ画像を埋め込み、保存データは変化しない
  it("Scenario: 表示時だけ共有背景を解決し、欠落時も注釈を保持する", async () => {
    const doc = new DiagramDocument({ width: 100, height: 80, elements: [] });
    doc.add({ kind: "image", x: 0, y: 0, width: 100, height: 80, src: "shared.png" });
    doc.add({ kind: "rect", x: 5, y: 5, width: 20, height: 20 });
    const svg = writeDiagramSvg(doc.value);
    const result = await composeDiagramPreview(svg, async () => new Uint8Array([1, 2, 3]).buffer);
    expect(result?.svg).toContain('href="data:image/png;base64,AQID"');
    expect(result?.missing).toEqual([]);
    const missing = await composeDiagramPreview(svg, async () => { throw new Error("missing"); });
    expect(missing?.missing).toEqual(["shared.png"]);
    expect(missing?.svg).toContain("<rect");
    expect(readDiagramSvg(svg)?.elements[0].src).toBe("shared.png");
  });

  // Given: 図形の変更履歴がある
  // When: 移動、削除、undo、redo を行う
  // Then: 図形の内容が履歴どおりに戻る
  it("Scenario: 図形の編集を戻してやり直せる", () => {
    const doc = new DiagramDocument({ width: 800, height: 600, elements: [] });
    const id = doc.add({ kind: "arrow", x: 10, y: 20, width: -5, height: 40 });
    doc.update(id, { x: 60 });
    doc.remove(id);
    doc.undo();
    expect(doc.value.elements[0].x).toBe(60);
    doc.undo();
    expect(doc.value.elements[0].x).toBe(10);
    doc.redo();
    expect(doc.value.elements[0].x).toBe(60);
  });

  // Given: 外部依存や不正な図データ
  // When: 背景取込または再編集する
  // Then: 危険な読み込みを拒否する
  it("Scenario: 外部依存 SVG と危険な背景参照を拒否する", () => {
    expect(() => validateStandaloneSvg('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/x.png"/></svg>')).toThrow();
    expect(() => validateStandaloneSvg('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')).toThrow();
    expect(() => new DiagramDocument({ width: 100, height: 80, elements: [{ id: 1, kind: "image", x: 0, y: 0, width: 1, height: 1, src: "%2e%2e/secret.png" }] })).toThrow();
  });
});
