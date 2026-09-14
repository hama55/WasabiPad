import {
  CSV_DELIMITER_OPTIONS,
  CUSTOM_DELIMITER_VALUE,
  delimiterPresetFor,
} from "./viewer-delimiter";

const CUSTOM_DELIMITER_LABEL = "自由形式";

export function syncViewerDelimiterControl(
  select: HTMLSelectElement,
  input: HTMLInputElement,
  value: string,
) {
  const preset = delimiterPresetFor(value);
  select.value = preset;
  if (preset === CUSTOM_DELIMITER_VALUE) input.value = value;
  input.hidden = preset !== CUSTOM_DELIMITER_VALUE;
}

export function createViewerDelimiterControl(
  select: HTMLSelectElement,
  input: HTMLInputElement,
  value: string,
  onChange: (value: string) => void,
  signal?: AbortSignal,
) {
  select.replaceChildren(
    ...CSV_DELIMITER_OPTIONS.map((option) => {
      const item = document.createElement("option");
      item.value = option.value;
      item.textContent = option.label;
      return item;
    }),
    (() => {
      const item = document.createElement("option");
      item.value = CUSTOM_DELIMITER_VALUE;
      item.textContent = CUSTOM_DELIMITER_LABEL;
      return item;
    })(),
  );
  syncViewerDelimiterControl(select, input, value);

  select.addEventListener("change", () => {
    if (select.value === CUSTOM_DELIMITER_VALUE) {
      input.hidden = false;
      input.focus();
      return;
    }
    input.hidden = true;
    onChange(select.value);
  }, { signal });
  input.addEventListener("input", () => {
    if (select.value !== CUSTOM_DELIMITER_VALUE || !input.value) return;
    onChange(input.value);
  }, { signal });
}
