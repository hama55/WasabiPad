// Tauri の webview では window.prompt が使えないため、複数フィールド入力用の
// 簡易モーダルを自前実装する (お気に入りの名前/パス編集などに使用)。
export function promptFields(
  title: string,
  fields: { label: string; value: string; options?: { label: string; value: string }[] }[]
): Promise<string[] | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "pf-overlay";
    const box = document.createElement("div");
    box.className = "pf-box";

    const h = document.createElement("div");
    h.className = "pf-title";
    h.textContent = title;
    box.appendChild(h);

    const inputs = fields.map((f) => {
      const row = document.createElement("div");
      row.className = "pf-row";
      const label = document.createElement("label");
      label.textContent = f.label;
      const input = f.options ? document.createElement("select") : document.createElement("input");
      if (f.options) {
        for (const option of f.options) {
          const el = document.createElement("option");
          el.value = option.value;
          el.textContent = option.label;
          input.appendChild(el);
        }
      } else {
        input.spellcheck = false;
      }
      input.value = f.value;
      row.appendChild(label);
      row.appendChild(input);
      box.appendChild(row);
      return input;
    });

    const btns = document.createElement("div");
    btns.className = "pf-btns";
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "キャンセル";
    const okBtn = document.createElement("button");
    okBtn.textContent = "OK";
    okBtn.className = "pf-ok";
    btns.appendChild(cancelBtn);
    btns.appendChild(okBtn);
    box.appendChild(btns);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const finish = (result: string[] | null) => {
      overlay.remove();
      window.removeEventListener("keydown", onKey, true);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      } else if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    };
    const submit = () => finish(inputs.map((i) => i.value));

    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) finish(null);
    });
    cancelBtn.addEventListener("click", () => finish(null));
    okBtn.addEventListener("click", submit);
    window.addEventListener("keydown", onKey, true);

    inputs[0]?.focus();
    if (inputs[0] instanceof HTMLInputElement) inputs[0].select();
  });
}

export function showMessage(title: string, message: string, okLabel = "OK"): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "pf-overlay";
    overlay.innerHTML = `<div class="pf-box"><div class="pf-title"></div><div class="pf-message"></div><div class="pf-btns"><button class="pf-ok"></button></div></div>`;
    overlay.querySelector<HTMLElement>(".pf-title")!.textContent = title;
    overlay.querySelector<HTMLElement>(".pf-message")!.textContent = message;
    const ok = overlay.querySelector<HTMLButtonElement>(".pf-ok")!;
    ok.textContent = okLabel;
    document.body.appendChild(overlay);
    const finish = () => {
      overlay.remove();
      window.removeEventListener("keydown", onKey, true);
      resolve();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); finish(); }
    };
    ok.addEventListener("click", finish);
    window.addEventListener("keydown", onKey, true);
    ok.focus();
  });
}

export function confirmMessage(
  title: string,
  message: string,
  okLabel: string,
  cancelLabel = "キャンセル"
): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "pf-overlay";
    overlay.innerHTML = `<div class="pf-box"><div class="pf-title"></div><div class="pf-message"></div><div class="pf-btns"><button class="pf-cancel"></button><button class="pf-ok"></button></div></div>`;
    overlay.querySelector<HTMLElement>(".pf-title")!.textContent = title;
    overlay.querySelector<HTMLElement>(".pf-message")!.textContent = message;
    const cancel = overlay.querySelector<HTMLButtonElement>(".pf-cancel")!;
    const ok = overlay.querySelector<HTMLButtonElement>(".pf-ok")!;
    cancel.textContent = cancelLabel;
    ok.textContent = okLabel;
    document.body.appendChild(overlay);
    const finish = (value: boolean) => {
      overlay.remove();
      window.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
    };
    cancel.addEventListener("click", () => finish(false));
    ok.addEventListener("click", () => finish(true));
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) finish(false); });
    window.addEventListener("keydown", onKey, true);
    ok.focus();
  });
}

export type SaveDiscardChoice = "save" | "discard" | "cancel";

export function confirmSaveDiscard(): Promise<SaveDiscardChoice> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "pf-overlay";
    overlay.innerHTML = `<div class="pf-box"><div class="pf-title">未保存の変更</div><div class="pf-message">変更が保存されていない</div><div class="pf-btns"><button class="pf-cancel">キャンセル</button><button class="pf-discard">破棄</button><button class="pf-ok">保存して続ける</button></div></div>`;
    document.body.appendChild(overlay);
    const finish = (value: SaveDiscardChoice) => {
      overlay.remove();
      window.removeEventListener("keydown", onKey, true);
      resolve(value);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); finish("cancel"); }
      if (e.key === "Enter") { e.preventDefault(); finish("save"); }
    };
    overlay.querySelector(".pf-cancel")!.addEventListener("click", () => finish("cancel"));
    overlay.querySelector(".pf-discard")!.addEventListener("click", () => finish("discard"));
    overlay.querySelector(".pf-ok")!.addEventListener("click", () => finish("save"));
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) finish("cancel"); });
    window.addEventListener("keydown", onKey, true);
    overlay.querySelector<HTMLButtonElement>(".pf-ok")!.focus();
  });
}
