import { READ_ENCODINGS, type ReadEncoding } from "./api";
import type { DocumentSession } from "./session";
import { readEncodingOf } from "./session";
import { formatByteSize, formatCursor, formatFontFamily, formatLineCount } from "./format";
import { DEFAULT_INDENT_SIZE, INDENT_SIZES, promptFontFamily, promptFontSize } from "./font-controls";
import { confirmMessage, promptFields } from "./prompt";
import { normalizeTheme, THEME_STORAGE_KEY, THEMES, type Theme } from "./theme";
import { runAsyncBoundary } from "./async-boundary";

const THEME_LABELS: Record<Theme, string> = { dark: "ダーク", light: "ライト" };
const READ_ENCODING_LABELS: Record<ReadEncoding, string> = {
  utf8: "UTF-8",
  sjis: "Shift-JIS",
  utf16le: "UTF-16LE",
};

function option(value: string, label: string): HTMLOptionElement {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  return element;
}

export interface StatusBarPorts {
  onGoTo: (line: number) => void;
  onFont: (family: string, size: number) => void;
  onWrap: (on: boolean) => void;
  onIndent: (size: number) => void;
  // 再読込を受け入れたら true。false なら選択を元へ戻す (成否の判断は呼び出し側に残す)
  onReadEncoding: (encoding: ReadEncoding) => Promise<boolean>;
  onError?: (title: string, error: unknown) => void | Promise<void>;
}

// ステータスバー全体 (#statusbar) を1つの部品として閉じる。表示中の文書がどう
// 見えているかだけを持ち、文書そのものの状態は持たない。
export class StatusBar {
  private currentLine = 1;
  private lineCount = 1;
  private wrap = false;
  private fontFamily = "";
  private fontSize = 0;
  // change 後の select からは元の値が読めないため、直近に表示した値を控えておく
  private shownReadEncoding: ReadEncoding = "utf8";

  constructor(private host: HTMLElement, private ports: StatusBarPorts) {
    this.indentSelect.replaceChildren(
      ...INDENT_SIZES.map((size) => option(String(size), `インデント: ${size}`)),
    );
    this.sourceEncodingSelect.replaceChildren(
      ...READ_ENCODINGS.map((encoding) => option(encoding, READ_ENCODING_LABELS[encoding])),
    );
    this.pick("st-theme").addEventListener("click", () => {
      this.run("テーマを変更できませんでした", () => {
        const current = (document.documentElement.getAttribute("data-theme") as Theme) ?? "dark";
        this.applyTheme(THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]);
      });
    });
    this.pick("st-font").addEventListener("click", () => this.run("フォントを変更できませんでした", () => this.promptFont()));
    this.pick("st-font-size").addEventListener("click", () => this.run("文字サイズを変更できませんでした", () => this.promptFontSize()));
    this.pick("st-wrap").addEventListener("click", () => {
      this.run("折り返しを変更できませんでした", () => {
        this.wrap = !this.wrap;
        this.pick("st-wrap").textContent = `折り返し: ${this.wrap ? "オン" : "オフ"}`;
        this.ports.onWrap(this.wrap);
      });
    });
    this.indentSelect.addEventListener("change", () => {
      this.run("インデント幅を変更できませんでした", () => this.ports.onIndent(Number(this.indentSelect.value)));
    });
    this.pick("st-pos").addEventListener("click", () => this.run("指定行へ移動できませんでした", () => this.promptGoTo()));
    this.pick("st-lines").addEventListener("click", () => this.run("最後の行へ移動できませんでした", () => this.promptGoToLast()));
    this.sourceEncodingSelect.addEventListener("change", () => this.run("文字コードを変更できませんでした", () => this.requestReadEncoding()));
  }

  private pick<T extends HTMLElement>(id: string): T {
    return this.host.querySelector<T>(`#${id}`)!;
  }

  private run(title: string, operation: () => void | Promise<unknown>) {
    runAsyncBoundary(operation, (error) => this.reportError(title, error));
  }

  private async reportError(title: string, error: unknown) {
    try {
      await this.ports.onError?.(title, error);
    } catch (reportError) {
      console.error(`${title}のエラーを表示できませんでした`, reportError);
    }
  }

  private get indentSelect() {
    return this.pick<HTMLSelectElement>("st-indent");
  }

  private get sourceEncodingSelect() {
    return this.pick<HTMLSelectElement>("st-source-enc");
  }

  // 保存済みの配色を復元する。未保存/未知の値はダーク扱い。
  restoreTheme(saved: string | null) {
    this.applyTheme(normalizeTheme(saved));
  }

  private applyTheme(theme: Theme) {
    document.documentElement.setAttribute("data-theme", theme);
    this.pick("st-theme").textContent = THEME_LABELS[theme];
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }

  // 選択肢に無いインデント幅は既定の8へ丸め、丸めた結果を返す
  setIndent(size: number): number {
    this.indentSelect.value = String(INDENT_SIZES.includes(size as typeof INDENT_SIZES[number]) ? size : DEFAULT_INDENT_SIZE);
    return Number(this.indentSelect.value);
  }

  setFont(family: string, size: number) {
    this.fontFamily = family;
    this.fontSize = size;
    this.pick("st-font").textContent = formatFontFamily(family);
    this.pick("st-font-size").textContent = `${size}px`;
  }

  setCursor(line: number, col: number) {
    this.currentLine = line;
    this.pick("st-pos").textContent = formatCursor(line, col);
  }

  setLineCount(count: number) {
    this.lineCount = count;
    this.pick("st-lines").textContent = formatLineCount(count);
  }

  // 無題文書はバイト数を持たないため null で空表示にする
  setByteSize(bytes: number | null, isHuge = false) {
    const size = this.pick("st-size");
    size.textContent = bytes === null ? "" : formatByteSize(bytes);
    size.classList.toggle("is-huge", bytes !== null && isHuge);
  }

  setMode(label: string) {
    this.pick("st-mode").textContent = label;
  }

  get mode(): string {
    return this.pick("st-mode").textContent ?? "";
  }

  // ステータスバーが示すのは読込時の形式だけ。保存形式は別名保存ダイアログが持つ。
  setFormat(session: Readonly<DocumentSession>) {
    const source = this.sourceEncodingSelect;
    this.shownReadEncoding = readEncodingOf(session.sourceEncoding);
    source.value = this.shownReadEncoding;
    source.disabled = session.readOnly || !session.savePath;
    source.title = session.sourceEncoding === "utf8bom" ? "読込文字コード: UTF-8 (BOMあり)" : "読込文字コード";
    this.pick("st-eol").textContent = session.sourceEol.toUpperCase();
  }

  private async requestReadEncoding() {
    const select = this.sourceEncodingSelect;
    const requested = select.value as ReadEncoding;
    if (requested === this.shownReadEncoding) return;
    if (!(await this.ports.onReadEncoding(requested))) select.value = this.shownReadEncoding;
  }

  private async promptFont() {
    const family = await promptFontFamily(this.fontFamily);
    if (family) this.ports.onFont(family, this.fontSize);
  }

  private async promptFontSize() {
    const size = await promptFontSize(this.fontSize);
    if (size !== null) this.ports.onFont(this.fontFamily, size);
  }

  private async promptGoTo() {
    const result = await promptFields("指定行へ移動", [
      { label: `行番号 (1〜${this.lineCount.toLocaleString("ja-JP")})`, value: String(this.currentLine) },
    ]);
    const line = Number(result?.[0]);
    if (Number.isInteger(line) && line >= 1 && line <= this.lineCount) this.ports.onGoTo(line - 1);
  }

  private async promptGoToLast() {
    if (await confirmMessage("最後の行へ移動", "最後の行に移動する", "移動")) {
      this.ports.onGoTo(this.lineCount - 1);
    }
  }
}
