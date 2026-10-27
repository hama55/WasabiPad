import { expect, it } from "vitest";
import { diagramTargetAt, diagramInsertion, replaceDiagramTarget } from "./diagram-target";

// Feature: 図を編集する対象
// Scenario: 同じ行の第二画像を選ぶ
// Given: Markdown画像と複数行のHTML画像がある
// When: 各画像の記述を右クリックする
// Then: 正しい画像範囲と表示幅を取得する
it("Scenario: Markdown と複数行 HTML の対象を位置で選べる", () => {
  const text = '前 ![一](first.png) <img\n src="second.png" width="320" alt="二"> 後';
  const first = diagramTargetAt(text, text.indexOf("first"));
  expect(first).toMatchObject({ src: "first.png", start: 2, alt: "一" });
  const second = diagramTargetAt(text, text.indexOf("second"));
  expect(second).toMatchObject({ src: "second.png", width: 320, alt: "二" });
  expect(text.slice(second!.start, second!.end)).toBe('<img\n src="second.png" width="320" alt="二">');
});

// Feature: 図の新規挿入
// Scenario: 通常の行に挿入する
// Given: 選択文章を含む行がある
// When: 行直後の挿入を計画する
// Then: 元の行を置換せず改行位置に挿入する
it("Scenario: 通常行の直後に選択文章を保持して挿入する", () => {
  expect(diagramInsertion("説明\n次の行", 1, "<img>\n")).toEqual({ start: 3, end: 3, text: "<img>\n" });
  expect(diagramInsertion("説明", 1, "<img>\n")).toEqual({ start: 2, end: 2, text: "\n<img>\n" });
});

// Feature: 図編集対象の検証
// Scenario: コードや壊れた画像は誤って編集しない
// Given: コードブロックと不正な画像記述
// When: 右クリック対象を探す
// Then: コードは通常行扱い、不正記述は拒否する
it("Scenario: コード内の画像を対象にせず不正タグを拒否する", () => {
  const code = '```html\n<img src="x.png">\n```';
  expect(diagramTargetAt(code, code.indexOf("x.png"))).toBeNull();
  expect(() => diagramTargetAt('<img src="x.png', 8)).toThrow();
  expect(() => diagramTargetAt('![説明](x.png', 7)).toThrow();
});

// Feature: 図参照の差し替え
// Scenario: 特殊文字を含む文書名で保存する
// Given: 表示幅を指定したHTML画像
// When: $を含む保存先へ差し替える
// Then: パス文字を置換構文として扱わず表示幅を保持する
it("Scenario: 特殊文字のパスへ差し替えても表示幅を保持する", () => {
  const target = diagramTargetAt('<img src="old.svg" width="320">', 10)!;
  expect(replaceDiagramTarget(target, 'image_markdown/$&/diagram-123.svg')).toBe('<img src="image_markdown/$&amp;/diagram-123.svg" width="320">');
});
