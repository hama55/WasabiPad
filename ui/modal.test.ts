// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { openModal } from "./modal";

const press = (key: string) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

const mouseDownOn = (target: EventTarget) =>
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

describe("openModal", () => {
  afterEach(() => document.body.replaceChildren());

  it("Escape と背景クリックはどちらも「やめる」", () => {
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

  it("Enter は受け取り先がある画面だけが拾う", () => {
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

  it("close の後はキーを拾わない", () => {
    let cancels = 0;
    const modal = openModal({ onCancel: () => (cancels += 1) });
    modal.close();

    expect(document.querySelector(".pf-overlay")).toBeNull();
    press("Escape");
    expect(cancels, "後始末で listener も外れる").toBe(0);
  });

  it("追加の見た目は box の class として渡せる", () => {
    const modal = openModal({ onCancel: () => {} }, "ss-box");
    expect(modal.box.className).toBe("pf-box ss-box");
  });
});
