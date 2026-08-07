// パス表示欄とその左右のボタン (#topbar) を1つの部品として閉じる。
// パスの解釈以外の判断 (開けるか/保存するか) は持たず、すべて ports へ委ねる。
import type { NavigationState } from "./navigation-history";
import { isMiddleClick } from "./interaction-constants";

export interface AddressBarPorts {
  onOpen: (path: string, newTab?: boolean) => void;
  onBack: () => void;
  onForward: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onNew: () => void;
  onFind: () => void;
  onPick: () => void;
  onFavorite: () => void;
}

export type AddressBarNavigationState = NavigationState;

// ドライブ文字は "C:\" で1区切り、以降は各フォルダ名。パンくずの各項目が
// そのまま「開く対象の絶対パス」になるよう、累積したパスを持たせる。
export function pathSegments(path: string): { label: string; path: string }[] {
  const normalized = path.replaceAll("/", "\\");
  const drive = normalized.match(/^[A-Za-z]:\\/);
  if (!drive) return [{ label: path, path }];
  const root = drive[0];
  let current = root;
  return [
    { label: root.slice(0, -1), path: root },
    ...normalized.slice(root.length).split("\\").filter(Boolean).map((label) => {
      current += label;
      const segment = { label, path: current };
      current += "\\";
      return segment;
    }),
  ];
}

export class AddressBar {
  private input: HTMLInputElement;
  private breadcrumb: HTMLElement;
  private navigationState: AddressBarNavigationState = { canGoBack: false, canGoForward: false };

  constructor(private host: HTMLElement, private ports: AddressBarPorts) {
    this.input = this.pick<HTMLInputElement>("addressbar");
    this.breadcrumb = this.pick("addressbar-breadcrumb");

    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && this.path) this.ports.onOpen(this.path);
      else if (e.key === "Escape") this.render(this.input.value);
    });
    this.input.addEventListener("blur", () => this.render(this.input.value));
    this.breadcrumb.addEventListener("click", () => this.edit());
    this.pick("addressbar-back").addEventListener("click", ports.onBack);
    this.pick("addressbar-forward").addEventListener("click", ports.onForward);
    this.pick("addressbar-fav").addEventListener("click", ports.onFavorite);
    this.pick("addressbar-save").addEventListener("click", ports.onSave);
    this.pick("addressbar-save-as").addEventListener("click", ports.onSaveAs);
    this.pick("addressbar-new").addEventListener("click", ports.onNew);
    this.pick("addressbar-find").addEventListener("click", ports.onFind);
    this.pick("addressbar-open").addEventListener("click", ports.onPick);
    window.addEventListener("auxclick", this.onMouseNavigation, true);
    this.setNavigationState({ canGoBack: false, canGoForward: false });
  }

  private pick<T extends HTMLElement>(id: string): T {
    return this.host.querySelector<T>(`#${id}`)!;
  }

  // 入力中の値も含めた「いま指しているパス」。空なら空文字。
  get path(): string {
    return this.input.value.trim();
  }

  setNavigationState(state: AddressBarNavigationState) {
    this.navigationState = state;
    this.pick<HTMLButtonElement>("addressbar-back").disabled = !state.canGoBack;
    this.pick<HTMLButtonElement>("addressbar-forward").disabled = !state.canGoForward;
  }

  private onMouseNavigation = (event: MouseEvent) => {
    const canNavigate = event.button === 3
      ? this.navigationState.canGoBack
      : event.button === 4
        ? this.navigationState.canGoForward
        : null;
    if (canNavigate === null || !canNavigate) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.button === 3) this.ports.onBack();
    else this.ports.onForward();
  };

  dispose() {
    window.removeEventListener("auxclick", this.onMouseNavigation, true);
  }

  render(path: string) {
    this.input.value = path;
    this.breadcrumb.replaceChildren(...pathSegments(path).flatMap((segment, index) => {
      const items: Node[] = [];
      if (index) {
        const separator = document.createElement("span");
        separator.className = "addressbar-sep";
        separator.textContent = ">";
        items.push(separator);
      }
      const button = document.createElement("button");
      button.className = "addressbar-crumb";
      button.textContent = segment.label;
      button.title = segment.path;
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        this.ports.onOpen(segment.path);
      });
      button.addEventListener("auxclick", (event) => {
        if (!isMiddleClick(event)) return;
        event.preventDefault();
        event.stopPropagation();
        this.ports.onOpen(segment.path, true);
      });
      items.push(button);
      return items;
    }));
    this.input.hidden = true;
    this.breadcrumb.hidden = false;
  }

  edit() {
    this.breadcrumb.hidden = true;
    this.input.hidden = false;
    this.input.focus();
    this.input.select();
  }
}
