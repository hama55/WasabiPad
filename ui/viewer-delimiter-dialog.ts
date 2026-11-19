import {
  CSV_DELIMITER_OPTIONS,
  CUSTOM_DELIMITER_VALUE,
  csvDelimiterOptions,
  delimiterPresetFor,
  encodeCsvDelimiters,
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

  const selected = csvDelimiterOptions(options.value);
  const presets = selected.map(delimiterPresetFor);
  const choices = document.createElement("fieldset");
  choices.className = "viewer-delimiter-choices";
  const legend = document.createElement("legend");
  legend.textContent = "区切り文字";
  choices.append(legend);
  const checkboxes = [...CSV_DELIMITER_OPTIONS, { value: CUSTOM_DELIMITER_VALUE, label: "その他" }].map((option) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = option.value;
    input.checked = presets.includes(option.value);
    label.append(input, option.label);
    choices.append(label);
    return input;
  });
  const customOption = checkboxes[checkboxes.length - 1];

  const customLabel = document.createElement("label");
  customLabel.textContent = "その他の区切り文字";
  const customInput = document.createElement("input");
  customInput.value = selected.find((value) => delimiterPresetFor(value) === CUSTOM_DELIMITER_VALUE) ?? "";
  customInput.setAttribute("aria-label", "その他の区切り文字");
  customLabel.appendChild(customInput);
  const syncCustomVisibility = () => {
    customLabel.hidden = !customOption.checked;
  };
  customOption.addEventListener("change", syncCustomVisibility);
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
  dialog.append(heading, choices, customLabel, error, buttons);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  checkboxes[0].focus();

  let closed = false;
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    finish();
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  cancel.addEventListener("click", finish);
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) finish();
  });
  window.addEventListener("keydown", onKey, true);
  apply.addEventListener("click", () => {
    if (customOption.checked && !customInput.value) {
      error.textContent = "区切り文字を入力してください";
      return;
    }
    if (customOption.checked && /[\r\n"]/.test(customInput.value)) {
      error.textContent = "改行と引用符は区切り文字に使えません";
      return;
    }
    const values = checkboxes.filter((input) => input.checked)
      .map((input) => input === customOption ? customInput.value : input.value);
    finish();
    options.onApply(encodeCsvDelimiters([...new Set(values)]));
  });
}
