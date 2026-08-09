import {
  CSV_DELIMITER_OPTIONS,
  CUSTOM_DELIMITER_VALUE,
  delimiterPresetFor,
} from "./viewer-delimiter";

export interface ViewerDelimiterDialogOptions {
  value: string;
  onApply: (value: string) => void;
}

export function openViewerDelimiterDialog(options: ViewerDelimiterDialogOptions) {
  const overlay = document.createElement("div");
  overlay.className = "viewer-dialog-overlay";
  const dialog = document.createElement("div");
  dialog.className = "viewer-dialog";
  const heading = document.createElement("h2");
  heading.textContent = "区切り文字を変更";

  const presetLabel = document.createElement("label");
  presetLabel.textContent = "プリセット";
  const preset = document.createElement("select");
  CSV_DELIMITER_OPTIONS.forEach((option) => {
    const item = document.createElement("option");
    item.value = option.value;
    item.textContent = option.label;
    preset.appendChild(item);
  });
  const customOption = document.createElement("option");
  customOption.value = CUSTOM_DELIMITER_VALUE;
  customOption.textContent = "その他";
  preset.appendChild(customOption);
  preset.value = delimiterPresetFor(options.value);
  presetLabel.appendChild(preset);

  const customLabel = document.createElement("label");
  customLabel.textContent = "その他の区切り文字";
  const customInput = document.createElement("input");
  customInput.value = options.value;
  customInput.setAttribute("aria-label", "その他の区切り文字");
  customLabel.appendChild(customInput);
  const syncCustomVisibility = () => {
    customLabel.hidden = preset.value !== CUSTOM_DELIMITER_VALUE;
  };
  preset.addEventListener("change", syncCustomVisibility);
  syncCustomVisibility();

  const error = document.createElement("div");
  error.className = "viewer-dialog-error";
  const buttons = document.createElement("div");
  buttons.className = "viewer-dialog-buttons";
  const cancel = document.createElement("button");
  cancel.textContent = "キャンセル";
  const apply = document.createElement("button");
  apply.className = "primary";
  apply.textContent = "適用";
  buttons.append(cancel, apply);
  dialog.append(heading, presetLabel, customLabel, error, buttons);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const finish = () => overlay.remove();
  cancel.addEventListener("click", finish);
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) finish();
  });
  apply.addEventListener("click", () => {
    const value = preset.value === CUSTOM_DELIMITER_VALUE ? customInput.value : preset.value;
    if (!value) {
      error.textContent = "区切り文字を入力してください";
      return;
    }
    finish();
    options.onApply(value);
  });
}
