// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { openModal } from "./modal";

const press = (key: string) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

const mouseDownOn = (target: EventTarget) =>
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

describe("Feature: openModal", () => {
  afterEach(() => document.body.replaceChildren());

  // Given: cancel callback付きmodalを開く
  // When: Escape、背景、modal本体でmousedown
  // Then: Escape/背景だけcancel、callbackは2回
  it("Scenario: Escape と背景クリックはどちらも「やめる」", () => {
    const cancels: string[] = [];
    const modal = openModal({ onCancel: () => cancels.push("cancel") });
    const overlay = document.querySelector(".pf-overlay")!;

    press("Escape");
    mouseDownOn(overlay);
    expect(cancels).toEqual(["cancel", "cancel"]);

    // 中身の上で押したときは閉じない (ドラッグ選択が終わった位置で消えてしまう)
    mouseDownOn(modal.box);
    expect(cancels).toHaveLength(2);
  });

  // Given: accept付きmodalとcancelのみのmodalを順に開く
  // When: 各modalでEnter
  // Then: accept付きだけaccept、受け取り先なしではイベント変化なし
  it("Scenario: Enter は受け取り先がある画面だけが拾う", () => {
    const events: string[] = [];
    const withAccept = openModal({
      onCancel: () => events.push("cancel"),
      onAccept: () => events.push("accept"),
    });
    press("Enter");
    expect(events).toEqual(["accept"]);

    withAccept.close();
    openModal({ onCancel: () => events.push("cancel2") });
    press("Enter"); // 受け取り先が無ければ素通し (入力欄が自前で使う)
    expect(events).toEqual(["accept"]);
  });

  // Given: cancel callback付きmodalを開く
  // When: `close()`後にEscape
  // Then: overlay削除、callbackは呼ばれない
  it("Scenario: close の後はキーを拾わない", () => {
    let cancels = 0;
    const modal = openModal({ onCancel: () => (cancels += 1) });
    modal.close();

    expect(document.querySelector(".pf-overlay")).toBeNull();
    press("Escape");
    expect(cancels, "後始末で listener も外れる").toBe(0);
  });

  // Given: 追加classに`ss-box`を指定
  // When: modalを開く
  // Then: boxのclassが`pf-box ss-box`
  it("Scenario: 追加の見た目は box の class として渡せる", () => {
    const modal = openModal({ onCancel: () => {} }, "ss-box");
    expect(modal.box.className).toBe("pf-box ss-box");
  });
});
