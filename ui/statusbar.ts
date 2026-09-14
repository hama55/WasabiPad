import { READ_ENCODINGS, type ReadEncoding, type ViewerFormat } from "./api";
import type { DocumentSession } from "./session";
import { readEncodingOf } from "./session";
import { formatByteSize, formatCursor, formatFontFamily, formatLineCount, formatModifiedAt } from "./format";
import {
  DEFAULT_INDENT_SIZE,
  FONT_FAMILIES,
  INDENT_SIZES,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  clampFontSize,
} from "./font-controls";
import { confirmMessage, promptFields } from "./prompt";
import { runAsyncBoundary } from "./async-boundary";
import { viewerFormatSpec } from "./viewer-formats";
import { reportErrorSafely } from "./report-error";
import { ENCODING_LABELS } from "./generated/Protocol";

function option(value: string, label: string): HTMLOptionElement {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  return element;
}

export interface StatusBarPorts {
  onGoTo: (line: number) => void;
  onFontFamily: (family: string) => void;
  onFontSize: (size: number) => void;
  onPreviewFontFamily?: (family: string) => void | Promise<void>;
  onPreviewFontSize?: (size: number) => void | Promise<void>;
  onWrap: (on: boolean) => void;
  onIndent: (size: number) => void;
  onPreviewDelimiter?: (delimiter: string) => void;
  // 再読込を受け入れたら true。false なら選択を元へ戻す (成否の判断は呼び出し側に残す)
  onReadEncoding: (encoding: ReadEncoding) => Promise<boolean>;
  onError?: (title: string, error: unknown) => void | Promise<void>;
}

// ファイルビュー側のステータス。文書のバイトサイズと保存日時だけを持つ。
export class FileStatusBar {
  private modifiedAt: number | null = null;

  constructor(private host: HTMLElement) {}

  private pick<T extends HTMLElement>(id: string): T {
    return this.host.querySelector<T>(`#${id}`)!;
  }

  setByteSize(bytes: number | null, isHuge = false) {
    const size = this.pick<HTMLElement>("st-size");
    size.textContent = bytes === null ? "" : formatByteSize(bytes);
    size.classList.toggle("is-huge", bytes !== null && isHuge);
  }

  setModifiedAt(timestamp: number | null) {
    this.modifiedAt = timestamp;
    this.refreshModifiedAt();
  }

  // 相対時刻は時間経過で変わるため、メイン画面の定期更新から呼び出す。
  refreshModifiedAt() {
    this.pick<HTMLElement>("st-modified").textContent = formatModifiedAt(this.modifiedAt);
  }
}

// エディタ・プレビュー側のステータス。ファイル情報は持たない。
export class EditingStatusBar {
  private currentLine = 1;
  private lineCount = 1;
  private wrap = false;
  // change 後の select からは元の値が読めないため、直近に表示した値を控えておく
  private shownReadEncoding: ReadEncoding = "utf8";
  private committedFontFamily = FONT_FAMILIES[0];
  private committedFontSize = MIN_FONT_SIZE;
  private familyCandidatePending = false;
  private sizeCandidatePending = false;

  constructor(private host: HTMLElement, private ports: StatusBarPorts) {
    this.indentSelect.replaceChildren(
      ...INDENT_SIZES.map((size) => option(String(size), `インデント: ${size}`)),
    );
    this.fontFamilySelect.replaceChildren(
      ...FONT_FAMILIES.map((family) => option(family, formatFontFamily(family))),
    );
    this.fontSizeSelect.replaceChildren(
      ...Array.from({ length: MAX_FONT_SIZE - MIN_FONT_SIZE + 1 }, (_, index) => {
        const size = MIN_FONT_SIZE + index;
        return option(String(size), `${size}px`);
      }),
    );
    this.sourceEncodingSelect.replaceChildren(
      ...READ_ENCODINGS.map((encoding) => option(encoding, ENCODING_LABELS[encoding])),
    );
    this.previewDelimiterInput.addEventListener("input", () => {
      this.run("CSV区切り文字を変更できませんでした", () => {
        if (!this.previewDelimiterInput.value) return;
        return this.ports.onPreviewDelimiter?.(this.previewDelimiterInput.value);
      });
    });
    // input は候補移動中のエディタだけのプレビュー。設定保存を行う既存ポートは change だけで呼ぶ。
    this.fontFamilySelect.addEventListener("input", () => this.previewFontFamily(this.fontFamilySelect.value));
    this.fontFamilySelect.addEventListener("pointerover", (event) => {
      const option = (event.target as Element | null)?.closest<HTMLOptionElement>("option");
      if (!option || option.parentElement !== this.fontFamilySelect || option.disabled) return;
      this.previewFontFamily(option.value);
    });
    this.fontSizeSelect.addEventListener("input", () =>
      this.previewFontSize(clampFontSize(Number(this.fontSizeSelect.value))));
    this.fontSizeSelect.addEventListener("pointerover", (event) => {
      const option = (event.target as Element | null)?.closest<HTMLOptionElement>("option");
      if (!option || option.parentElement !== this.fontSizeSelect || option.disabled) return;
      this.previewFontSize(clampFontSize(Number(option.value)));
    });
    this.fontFamilySelect.addEventListener("change", () => {
      this.familyCandidatePending = false;
      this.committedFontFamily = this.fontFamilySelect.value;
      const family = this.committedFontFamily;
      this.run("フォントを変更できませんでした", () => this.ports.onFontFamily(family));
    });
    this.fontSizeSelect.addEventListener("change", () => {
      this.sizeCandidatePending = false;
      this.committedFontSize = clampFontSize(Number(this.fontSizeSelect.value));
      const size = this.committedFontSize;
      this.run("文字サイズを変更できませんでした", () => this.ports.onFontSize(size));
    });
    this.fontFamilySelect.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      this.restoreFontFamilyCandidate();
    });
    this.fontSizeSelect.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      this.restoreFontSizeCandidate();
    });
    this.fontFamilySelect.addEventListener("blur", () => this.restoreFontFamilyCandidate());
    this.fontSizeSelect.addEventListener("blur", () => this.restoreFontSizeCandidate());
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
    await reportErrorSafely(this.ports.onError, title, error);
  }

  private get indentSelect() {
    return this.pick<HTMLSelectElement>("st-indent");
  }

  private get fontFamilySelect() {
    return this.pick<HTMLSelectElement>("st-font");
  }

  private get fontSizeSelect() {
    return this.pick<HTMLSelectElement>("st-font-size");
  }

  private get sourceEncodingSelect() {
    return this.pick<HTMLSelectElement>("st-source-enc");
  }

  private get previewDelimiter() {
    return this.pick<HTMLElement>("st-delimiter");
  }

  private get previewDelimiterInput() {
    return this.pick<HTMLInputElement>("st-delimiter-input");
  }

  // 選択肢に無いインデント幅は既定の8へ丸め、丸めた結果を返す
  setIndent(size: number): number {
    this.indentSelect.value = String(INDENT_SIZES.includes(size as typeof INDENT_SIZES[number]) ? size : DEFAULT_INDENT_SIZE);
    return Number(this.indentSelect.value);
  }

  setFont(family: string, size: number) {
    const clampedSize = clampFontSize(size);
    if (![...this.fontFamilySelect.options].some((item) => item.value === family)) {
      this.fontFamilySelect.insertBefore(option(family, formatFontFamily(family)), this.fontFamilySelect.firstChild);
    }
    this.committedFontFamily = family;
    this.committedFontSize = clampedSize;
    this.familyCandidatePending = false;
    this.sizeCandidatePending = false;
    this.fontFamilySelect.value = family;
    this.fontSizeSelect.value = String(clampedSize);
  }

  private previewFontFamily(family: string) {
    this.familyCandidatePending = true;
    this.run("フォントをプレビューできませんでした", () => this.ports.onPreviewFontFamily?.(family));
  }

  private previewFontSize(size: number) {
    this.sizeCandidatePending = true;
    this.run("文字サイズをプレビューできませんでした", () => this.ports.onPreviewFontSize?.(size));
  }

  private restoreFontFamilyCandidate() {
    if (!this.familyCandidatePending) return;
    this.familyCandidatePending = false;
    this.fontFamilySelect.value = this.committedFontFamily;
    this.run("フォントをプレビューできませんでした", () =>
      this.ports.onPreviewFontFamily?.(this.committedFontFamily));
  }

  private restoreFontSizeCandidate() {
    if (!this.sizeCandidatePending) return;
    this.sizeCandidatePending = false;
    this.fontSizeSelect.value = String(this.committedFontSize);
    this.run("文字サイズをプレビューできませんでした", () =>
      this.ports.onPreviewFontSize?.(this.committedFontSize));
  }

  setCursor(line: number, col: number) {
    this.currentLine = line;
    this.pick("st-pos").textContent = formatCursor(line, col);
  }

  setLineCount(count: number) {
    this.lineCount = count;
    this.pick("st-lines").textContent = formatLineCount(count);
  }

  setMode(label: string) {
    this.pick("st-mode").textContent = label;
  }

  get mode(): string {
    return this.pick("st-mode").textContent ?? "";
  }

  setPreviewFormat(format: ViewerFormat | null) {
    this.previewDelimiter.hidden = format === null || !viewerFormatSpec(format).supportsDelimiter;
  }

  // ステータスバーが示すのは読込時の形式だけ。保存形式は別名保存ダイアログが持つ。
  setFormat(session: Readonly<DocumentSession>) {
    const source = this.sourceEncodingSelect;
    this.shownReadEncoding = readEncodingOf(session.sourceEncoding);
    source.value = this.shownReadEncoding;
    source.disabled = session.readOnly || !session.savePath;
    source.title = session.sourceEncoding === "utf8bom" ? "読込文字コード: UTF-8 (BOMあり)" : "読込文字コード";
    this.pick("st-eol").textContent = session.sourceEol.toUpperCase();
    const binary = this.pick<HTMLElement>("st-binary");
    binary.hidden = !session.isBinary;
    binary.textContent = session.isBinary ? "閲覧専用（バイナリ）" : "";
  }

  private async requestReadEncoding() {
    const select = this.sourceEncodingSelect;
    const requested = select.value as ReadEncoding;
    if (requested === this.shownReadEncoding) return;
    if (!(await this.ports.onReadEncoding(requested))) select.value = this.shownReadEncoding;
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
