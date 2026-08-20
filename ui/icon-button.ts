export const CHEVRON_LEFT = "\uE76B";
export const CHEVRON_RIGHT = "\uE76C";
export const CHEVRON_DOWN = "\uE70D";

export function iconButton(className: string, label: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  return button;
}
