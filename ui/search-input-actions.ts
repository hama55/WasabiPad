import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { showMenu } from "./menu";
import { createMenuIcon, MENU_ICON } from "./menu-icons";
import { MENU_LABELS } from "./menu-labels";

export function addSearchInputActions(input: HTMLInputElement, onError: (error: unknown) => void | Promise<void>) {
  const field = document.createElement("span");
  field.className = "search-input-field";
  input.replaceWith(field);
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "search-input-clear";
  clear.title = `${input.placeholder || input.getAttribute("aria-label") || "入力"}を消去`;
  clear.setAttribute("aria-label", clear.title);
  clear.append(createMenuIcon(MENU_ICON.close));
  field.append(input, clear);
  const sync = () => { clear.hidden = !input.value; };
  const changed = () => { input.dispatchEvent(new Event("input", { bubbles: true })); };
  input.addEventListener("input", sync);
  clear.addEventListener("mousedown", event => event.preventDefault());
  clear.addEventListener("click", () => {
    input.value = "";
    input.focus();
    changed();
  });
  input.addEventListener("contextmenu", event => {
    event.preventDefault();
    event.stopPropagation();
    input.focus();
    const value = input.value;
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? start;
    const run = (operation: () => void | Promise<void>) => async () => {
      try { await operation(); } catch (error) { await onError(error); }
    };
    const insert = (text: string) => {
      if (input.value !== value || input.disabled || input.readOnly) return;
      input.focus();
      input.setSelectionRange(start, end);
      input.setRangeText(text, start, end, "end");
      changed();
    };
    showMenu(event.clientX, event.clientY, [
      { label: MENU_LABELS.cut, iconClass: MENU_ICON.cut, action: run(async () => {
        if (start === end || input.readOnly) return;
        await writeText(value.slice(start, end));
        insert("");
      }) },
      { label: MENU_LABELS.copy, iconClass: MENU_ICON.copy, action: run(async () => {
        if (start !== end) await writeText(value.slice(start, end));
        input.focus();
        input.setSelectionRange(start, end);
      }) },
      { label: MENU_LABELS.paste, iconClass: MENU_ICON.paste, action: run(async () => {
        if (!input.readOnly) insert(await readText());
      }) },
      { label: "全選択", iconClass: MENU_ICON.selectAll, action: () => { input.focus(); input.select(); } },
    ]);
  });
  sync();
  return sync;
}
