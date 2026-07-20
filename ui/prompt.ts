// Tauri の webview では window.prompt が使えないため、複数フィールド入力用の
// 簡易モーダルを自前実装する (お気に入りの名前/パス編集などに使用)。
export function promptFields(
  title: string,
  fields: { label: string; value: string }[]
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
      const input = document.createElement("input");
      input.value = f.value;
      input.spellcheck = false;
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
    inputs[0]?.select();
  });
}
