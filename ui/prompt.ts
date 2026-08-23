// 入力・確認のモーダル。重ね方は ui/modal.ts が持ち、ここは中身と返す値だけを決める。
import { openModal } from "./modal";

export interface PromptFieldsOptions {
  preview?: {
    label: string;
    render: (values: string[]) => string;
  };
  onChangeError?: (error: unknown) => void | Promise<void>;
}

export interface PromptField {
  label: string;
  value: string;
  type?: "password";
  multiline?: boolean;
  options?: { label: string; value: string }[];
  validate?: (value: string, values: string[]) => string | null;
  onChange?: (
    value: string,
    values: string[],
    setValue: (index: number, value: string) => void,
  ) => void | Promise<void>;
}

export function promptFields(
  title: string,
  fields: PromptField[],
  options: PromptFieldsOptions = {},
): Promise<string[] | null> {
  return new Promise((resolve) => {
    let closed = false;
    let pendingChanges = 0;
    const { box, close } = openModal({
      onCancel: () => finish(null),
      onAccept: () => submit(),
    });
    if (fields.some((field) => field.multiline)) box.classList.add("pf-command-box");

    const h = document.createElement("div");
    h.className = "pf-title";
    h.textContent = title;
    box.appendChild(h);

    const errors: HTMLElement[] = [];
    const inputs = fields.map((f) => {
      const row = document.createElement("div");
      row.className = "pf-row";
      const label = document.createElement("label");
      label.textContent = f.label;
      const input = f.options
        ? document.createElement("select")
        : f.multiline
          ? document.createElement("textarea")
          : document.createElement("input");
      if (f.options) {
        for (const option of f.options) {
          const el = document.createElement("option");
          el.value = option.value;
          el.textContent = option.label;
          input.appendChild(el);
        }
      } else {
        const editable = input as HTMLInputElement | HTMLTextAreaElement;
        editable.spellcheck = false;
        if (f.multiline) {
          const textarea = input as HTMLTextAreaElement;
          textarea.className = "pf-multiline-value";
          textarea.rows = 6;
          textarea.wrap = "soft";
        } else if (f.type) {
          (input as HTMLInputElement).type = f.type;
        }
      }
      input.value = f.value;
      row.appendChild(label);
      row.appendChild(input);
      const error = document.createElement("span");
      error.className = "pf-error";
      error.setAttribute("aria-live", "polite");
      row.appendChild(error);
      errors.push(error);
      box.appendChild(row);
      return input;
    });

    const preview = options.preview;
    let previewValue: HTMLTextAreaElement | null = null;
    if (preview) {
      const row = document.createElement("div");
      row.className = "pf-preview-row";
      const label = document.createElement("label");
      label.textContent = preview.label;
      previewValue = document.createElement("textarea");
      previewValue.className = "pf-preview-value";
      previewValue.readOnly = true;
      previewValue.rows = 2;
      previewValue.wrap = "soft";
      row.append(label, previewValue);
      box.appendChild(row);
    }

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

    const finish = (result: string[] | null) => {
      if (closed) return;
      closed = true;
      close();
      resolve(result);
    };
    const reportChangeError = (error: unknown) => {
      if (!options.onChangeError) {
        console.error("入力変更処理に失敗しました", error);
        return;
      }
      try {
        void Promise.resolve(options.onChangeError(error)).catch((reportError) => {
          console.error("入力変更処理のエラー通知に失敗しました", reportError);
        });
      } catch (reportError) {
        console.error("入力変更処理のエラー通知に失敗しました", reportError);
      }
    };
    const validate = () => {
      const values = inputs.map((input) => input.value);
      if (previewValue && preview) previewValue.value = preview.render(values);
      let valid = true;
      fields.forEach((field, index) => {
        const message = field.validate?.(values[index], values) ?? null;
        errors[index].textContent = message ?? "";
        inputs[index].setAttribute("aria-invalid", String(Boolean(message)));
        valid &&= !message;
      });
      okBtn.disabled = !valid || pendingChanges > 0;
      return valid;
    };
    const submit = () => {
      if (validate() && pendingChanges === 0) finish(inputs.map((i) => i.value));
    };

    cancelBtn.addEventListener("click", () => finish(null));
    okBtn.addEventListener("click", submit);
    inputs.forEach((input, index) => {
      input.addEventListener("input", validate);
      input.addEventListener("change", () => {
        validate();
        const onChange = fields[index].onChange;
        if (!onChange) return;
        const setValue = (targetIndex: number, value: string) => {
          if (closed) return;
          const target = inputs[targetIndex];
          if (!target) return;
          target.value = value;
          validate();
        };
        let result: void | Promise<void>;
        try {
          result = onChange(input.value, inputs.map((item) => item.value), setValue);
        } catch (error) {
          reportChangeError(error);
          return;
        }
        if (!result) return;
        pendingChanges += 1;
        validate();
        void Promise.resolve(result)
          .catch((error) => reportChangeError(error))
          .finally(() => {
            pendingChanges -= 1;
            if (!closed) validate();
          })
          .catch((error) => console.error("入力変更処理の後始末に失敗しました", error));
      });
    });

    validate();
    inputs[0]?.focus();
    if (inputs[0] instanceof HTMLInputElement) inputs[0].select();
  });
}

export function showMessage(title: string, message: string, okLabel = "OK"): Promise<void> {
  return new Promise((resolve) => {
    // 伝えるだけの画面なので、Escape も Enter も背景クリックも「読んだ」で同じ
    const { box, close } = openModal({ onCancel: () => finish(), onAccept: () => finish() });
    box.innerHTML = `<div class="pf-title"></div><div class="pf-message"></div><div class="pf-btns"><button class="pf-ok"></button></div>`;
    box.querySelector<HTMLElement>(".pf-title")!.textContent = title;
    box.querySelector<HTMLElement>(".pf-message")!.textContent = message;
    const ok = box.querySelector<HTMLButtonElement>(".pf-ok")!;
    ok.textContent = okLabel;
    const finish = () => {
      close();
      resolve();
    };
    ok.addEventListener("click", finish);
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
    const { box, close } = openModal({
      onCancel: () => finish(false),
      onAccept: () => finish(true),
    });
    box.innerHTML = `<div class="pf-title"></div><div class="pf-message"></div><div class="pf-btns"><button class="pf-cancel"></button><button class="pf-ok"></button></div>`;
    box.querySelector<HTMLElement>(".pf-title")!.textContent = title;
    box.querySelector<HTMLElement>(".pf-message")!.textContent = message;
    const cancel = box.querySelector<HTMLButtonElement>(".pf-cancel")!;
    const ok = box.querySelector<HTMLButtonElement>(".pf-ok")!;
    cancel.textContent = cancelLabel;
    ok.textContent = okLabel;
    const finish = (value: boolean) => {
      close();
      resolve(value);
    };
    cancel.addEventListener("click", () => finish(false));
    ok.addEventListener("click", () => finish(true));
    ok.focus();
  });
}

export type SaveDiscardChoice = "save" | "discard" | "cancel";

export function confirmSaveDiscard(): Promise<SaveDiscardChoice> {
  return new Promise((resolve) => {
    // 破棄だけは押し間違いが取り返しつかないので、Enter/Escape の逃げ道には割り当てない
    const { box, close } = openModal({
      onCancel: () => finish("cancel"),
      onAccept: () => finish("save"),
    });
    box.innerHTML = `<div class="pf-title">未保存のファイルがあります。</div><div class="pf-message">保存して続行するか、変更を破棄してください。</div><div class="pf-btns"><button class="pf-cancel">キャンセル</button><button class="pf-discard">破棄</button><button class="pf-ok">保存して続行</button></div>`;
    const finish = (value: SaveDiscardChoice) => {
      close();
      resolve(value);
    };
    box.querySelector(".pf-cancel")!.addEventListener("click", () => finish("cancel"));
    box.querySelector(".pf-discard")!.addEventListener("click", () => finish("discard"));
    box.querySelector(".pf-ok")!.addEventListener("click", () => finish("save"));
    box.querySelector<HTMLButtonElement>(".pf-ok")!.focus();
  });
}
