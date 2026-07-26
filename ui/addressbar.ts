// パス表示欄とその左右のボタン (#topbar) を1つの部品として閉じる。
// パスの解釈以外の判断 (開けるか/保存するか) は持たず、すべて ports へ委ねる。

export interface AddressBarPorts {
  onOpen: (path: string) => void;
  onSave: () => void;
  onNew: () => void;
  onNewWindow: () => void;
  onPick: () => void;
  onFavorite: () => void;
}

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

  constructor(private host: HTMLElement, private ports: AddressBarPorts) {
    this.input = this.pick<HTMLInputElement>("addressbar");
    this.breadcrumb = this.pick("addressbar-breadcrumb");

    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && this.path) this.ports.onOpen(this.path);
      else if (e.key === "Escape") this.render(this.input.value);
    });
    this.input.addEventListener("blur", () => this.render(this.input.value));
    this.breadcrumb.addEventListener("click", () => this.edit());
    this.pick("addressbar-fav").addEventListener("click", ports.onFavorite);
    this.pick("addressbar-save").addEventListener("click", ports.onSave);
    this.pick("addressbar-new").addEventListener("click", ports.onNew);
    this.pick("addressbar-new-window").addEventListener("click", ports.onNewWindow);
    this.pick("addressbar-open").addEventListener("click", ports.onPick);
  }

  private pick<T extends HTMLElement>(id: string): T {
    return this.host.querySelector<T>(`#${id}`)!;
  }

  // 入力中の値も含めた「いま指しているパス」。空なら空文字。
  get path(): string {
    return this.input.value.trim();
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
