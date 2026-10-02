import type { FindResult } from "./api";
import type { SearchHighlightQuery } from "./workspace-search-options";
import { charToU16 } from "./editor-math";
import { createMenuIcon, MENU_ICON } from "./menu-icons";

const ROW_HEIGHT = 26;

export class EditorSearchResults {
  private root = document.createElement("section");
  private status = document.createElement("span");
  private list = document.createElement("div");
  private spacer = document.createElement("div");
  private rows = document.createElement("div");
  private matches: FindResult[] = [];
  private generation = 0;
  private renderGeneration = 0;
  private timer: number | undefined;
  private query: SearchHighlightQuery | null = null;
  private selected = -1;
  private stopDrag: (() => void) | undefined;

  constructor(private ports: {
    search: (query: SearchHighlightQuery) => Promise<FindResult[]>;
    line: (line: number) => Promise<string>;
    select: (match: FindResult, query: SearchHighlightQuery) => void;
  }) {
    this.root.className = "editor-search-results";
    this.root.setAttribute("aria-label", "エディタ検索結果");
    this.root.hidden = true;
    const header = document.createElement("header");
    header.className = "editor-search-results-header";
    header.tabIndex = 0;
    header.setAttribute("aria-label", "検索結果パネルの位置");
    const title = document.createElement("span");
    title.textContent = "検索結果";
    this.status.className = "editor-search-results-status";
    this.status.setAttribute("role", "status");
    const close = document.createElement("button");
    close.type = "button";
    close.className = "editor-search-results-close";
    close.title = "検索結果を閉じる";
    close.setAttribute("aria-label", close.title);
    close.append(createMenuIcon(MENU_ICON.close));
    close.addEventListener("click", () => this.close());
    header.append(title, this.status, close);
    this.list.className = "editor-search-results-list";
    this.list.tabIndex = 0;
    this.list.setAttribute("role", "listbox");
    this.list.setAttribute("aria-label", "一致箇所");
    this.spacer.className = "editor-search-results-spacer";
    this.rows.className = "editor-search-results-rows";
    this.list.append(this.spacer, this.rows);
    const resize = document.createElement("div");
    resize.className = "editor-search-results-resize";
    resize.tabIndex = 0;
    resize.setAttribute("role", "separator");
    resize.setAttribute("aria-label", "検索結果パネルのサイズ");
    this.root.append(header, this.list, resize);
    header.addEventListener("pointerdown", event => { if (!(event.target as Element).closest("button")) this.drag(event, false); });
    resize.addEventListener("pointerdown", event => this.drag(event, true));
    const arrows = (event: KeyboardEvent, resizing: boolean) => {
      const dx = event.key === "ArrowRight" ? 10 : event.key === "ArrowLeft" ? -10 : 0;
      const dy = event.key === "ArrowDown" ? 10 : event.key === "ArrowUp" ? -10 : 0;
      if (!dx && !dy) return;
      event.preventDefault();
      const box = this.box();
      this.place(box.left + (resizing ? 0 : dx), box.top + (resizing ? 0 : dy), box.width + (resizing ? dx : 0), box.height + (resizing ? dy : 0));
    };
    header.addEventListener("keydown", event => { if (event.target === header) arrows(event, false); });
    resize.addEventListener("keydown", event => arrows(event, true));
    for (const edge of ["top", "bottom"] as const) {
      const handle = document.createElement("div");
      handle.className = `editor-search-results-resize-${edge}`;
      handle.tabIndex = 0;
      handle.setAttribute("role", "separator");
      handle.setAttribute("aria-label", edge === "top" ? "検索結果パネルの上辺" : "検索結果パネルの下辺");
      handle.addEventListener("pointerdown", event => this.drag(event, edge));
      handle.addEventListener("keydown", event => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        this.resizeHeight(this.box(), event.key === "ArrowUp" ? -10 : 10, edge);
      });
      this.root.append(handle);
    }
    this.root.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); this.close(); }
    });
    this.list.addEventListener("scroll", () => { void this.renderRows(); });
    this.list.addEventListener("keydown", event => {
      if (!this.matches.length || !["ArrowDown", "ArrowUp", "Home", "End", "Enter"].includes(event.key)) return;
      event.preventDefault();
      const index = event.key === "Home" ? 0 : event.key === "End" ? this.matches.length - 1
        : event.key === "ArrowDown" ? Math.min(this.matches.length - 1, this.selected + 1)
        : event.key === "ArrowUp" ? Math.max(0, this.selected - 1) : Math.max(0, this.selected);
      this.selected = index;
      this.list.scrollTop = Math.max(0, index * ROW_HEIGHT - this.list.clientHeight / 2);
      void this.renderRows();
      if (event.key === "Enter" && this.query) this.ports.select(this.matches[index], this.query);
    });
  }

  open(query: SearchHighlightQuery, belowSearchBar = 0) {
    if (!this.root.isConnected) document.body.append(this.root);
    this.root.hidden = false;
    if (!this.root.style.top) this.root.style.top = `${Math.max(belowSearchBar, window.innerHeight - 364, 8)}px`;
    window.addEventListener("resize", this.clamp);
    const box = this.box();
    this.place(box.left, box.top, box.width, box.height);
    this.refresh(query, 0);
  }

  get showing() { return !this.root.hidden; }

  close() {
    this.root.hidden = true;
    this.generation++;
    this.renderGeneration++;
    window.clearTimeout(this.timer);
    window.removeEventListener("resize", this.clamp);
    this.stopDrag?.();
  }

  refresh(query: SearchHighlightQuery, delay = 80) {
    if (this.root.hidden) return;
    const generation = ++this.generation;
    this.renderGeneration++;
    window.clearTimeout(this.timer);
    this.query = { ...query };
    this.matches = [];
    this.selected = -1;
    this.rows.replaceChildren();
    this.spacer.style.height = "0px";
    this.status.textContent = query.pat ? "検索中…" : "";
    if (!query.pat) return;
    this.timer = window.setTimeout(() => {
      void this.ports.search(query).then(matches => {
        if (generation !== this.generation || this.root.hidden) return;
        this.matches = matches;
        this.list.scrollTop = 0;
        this.status.textContent = `${matches.length.toLocaleString()}件`;
        this.spacer.style.height = `${matches.length * ROW_HEIGHT}px`;
        void this.renderRows();
      }).catch(error => {
        if (generation === this.generation) this.status.textContent = String(error);
      });
    }, delay);
  }

  private async renderRows() {
    const generation = ++this.renderGeneration;
    const first = Math.max(0, Math.floor(this.list.scrollTop / ROW_HEIGHT) - 2);
    const last = Math.min(this.matches.length, first + Math.ceil((this.list.clientHeight || 260) / ROW_HEIGHT) + 4);
    const fragment = document.createDocumentFragment();
    try {
      for (let index = first; index < last; index++) {
        const match = this.matches[index];
        const text = await this.ports.line(match.start.line);
        if (generation !== this.renderGeneration || this.root.hidden) return;
        const row = document.createElement("button");
        row.type = "button";
        row.tabIndex = -1;
        row.className = "editor-search-result";
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(index === this.selected));
        row.style.top = `${index * ROW_HEIGHT}px`;
        const position = document.createElement("span");
        position.className = "editor-search-result-position";
        position.textContent = `${match.start.line + 1}:${match.start.col + 1}`;
        const preview = document.createElement("span");
        preview.className = "editor-search-result-preview";
        const start = charToU16(text, match.start.col);
        const end = match.end.line === match.start.line ? charToU16(text, match.end.col) : text.length;
        const mark = document.createElement("mark");
        mark.textContent = text.slice(start, end);
        preview.append(text.slice(0, start), mark, text.slice(end));
        row.title = `${position.textContent} ${text}`;
        row.append(position, preview);
        row.addEventListener("click", () => {
          if (generation !== this.renderGeneration || !this.query) return;
          this.selected = index;
          this.ports.select(match, this.query);
          void this.renderRows();
        });
        fragment.append(row);
      }
      if (generation === this.renderGeneration) this.rows.replaceChildren(fragment);
    } catch (error) {
      if (generation === this.renderGeneration) this.status.textContent = String(error);
    }
  }

  private box() {
    return {
      left: Number.parseFloat(this.root.style.left) || Math.max(8, window.innerWidth - 584),
      top: Number.parseFloat(this.root.style.top) || 100,
      width: Number.parseFloat(this.root.style.width) || 560,
      height: Number.parseFloat(this.root.style.height) || 340,
    };
  }

  private place(left: number, top: number, width: number, height: number) {
    const maxWidth = Math.max(1, window.innerWidth - 16);
    const maxHeight = Math.max(1, window.innerHeight - 16);
    width = Math.min(maxWidth, Math.max(Math.min(280, maxWidth), width));
    height = Math.min(maxHeight, Math.max(Math.min(140, maxHeight), height));
    Object.assign(this.root.style, {
      left: `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`,
      top: `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`,
      width: `${width}px`, height: `${height}px`,
    });
    void this.renderRows();
  }

  private clamp = () => {
    const box = this.box();
    this.place(box.left, box.top, box.width, box.height);
  };

  private resizeHeight(box: ReturnType<EditorSearchResults["box"]>, delta: number, edge: "top" | "bottom") {
    const minHeight = Math.min(140, Math.max(1, window.innerHeight - 16));
    if (edge === "top") {
      delta = Math.max(8 - box.top, Math.min(delta, box.height - minHeight));
      this.place(box.left, box.top + delta, box.width, box.height - delta);
    } else {
      const height = Math.max(minHeight, Math.min(box.height + delta, window.innerHeight - box.top - 8));
      this.place(box.left, box.top, box.width, height);
    }
  }

  private drag(event: PointerEvent, resizing: boolean | "top" | "bottom") {
    if (event.button !== 0) return;
    event.preventDefault();
    this.stopDrag?.();
    const box = this.box();
    const move = (next: PointerEvent) => {
      const dx = next.clientX - event.clientX;
      const dy = next.clientY - event.clientY;
      if (resizing === "top" || resizing === "bottom") {
        this.resizeHeight(box, dy, resizing);
        return;
      }
      this.place(box.left + (resizing ? 0 : dx), box.top + (resizing ? 0 : dy), box.width + (resizing ? dx : 0), box.height + (resizing ? dy : 0));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
      this.stopDrag = undefined;
    };
    this.stopDrag = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
  }
}
