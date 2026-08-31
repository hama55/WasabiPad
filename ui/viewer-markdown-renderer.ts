import MarkdownIt from "markdown-it";
import type { ViewerSelection } from "./api";
import {
  markdownBlockSelected,
  markdownHighlightTargets,
  markdownHeadingSlug,
  placeMarkdownCaret,
  renderRawHtml,
} from "./viewer-markdown";
import { isCollapsedViewerSelection } from "./viewer-selection";
import {
  isExternalMarkdownLink,
  isSameDocumentMarkdownLink,
  markdownFragmentOf,
} from "./viewer-assets";

export interface MarkdownRenderResult {
  article: HTMLElement;
  highlightTargets: HTMLElement[];
}

export interface MarkdownRenderOptions {
  sourcePath?: string | null;
  archivePath?: string | null;
  breaks?: boolean;
}

function decorateTaskListItems(article: HTMLElement) {
  article.querySelectorAll<HTMLLIElement>("li").forEach((item) => {
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    const text = walker.nextNode();
    if (!(text instanceof Text)) return;
    const match = text.data.match(/^\[([ xX])\](?:[ \t]+|$)/);
    if (!match) return;

    text.data = text.data.slice(match[0].length);
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.disabled = true;
    checkbox.checked = match[1].toLowerCase() === "x";
    checkbox.className = "viewer-markdown-task";
    checkbox.setAttribute("aria-label", checkbox.checked ? "完了" : "未完了");
    text.parentNode?.insertBefore(checkbox, text);
    item.classList.add("viewer-markdown-task-list-item");
  });
}

function assignMarkdownHeadingIds(article: HTMLElement) {
  const used = new Set([...article.querySelectorAll<HTMLElement>("[id]")]
    .map((element) => element.id)
    .filter(Boolean));
  const counts = new Map<string, number>();
  article.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6").forEach((heading) => {
    const base = markdownHeadingSlug(heading.textContent ?? "");
    if (!base) return;
    let suffix = counts.get(base) ?? 0;
    let id = suffix ? `${base}-${suffix}` : base;
    while (used.has(id)) {
      suffix += 1;
      id = `${base}-${suffix}`;
    }
    counts.set(base, suffix + 1);
    heading.id = id;
    used.add(id);
  });
}

function markdownLinkTitle(
  href: string,
  options: MarkdownRenderOptions,
): string {
  if (isSameDocumentMarkdownLink(options.sourcePath ?? null, href)) {
    return "クリックで同じ文書内を移動";
  }
  if (isExternalMarkdownLink(href)) {
    return "Ctrl+クリックで既定のブラウザで開く";
  }
  if (markdownFragmentOf(href) !== null && !options.archivePath) {
    return "Ctrl+クリックで新規タブを開いて該当箇所へ移動";
  }
  return "Ctrl+クリックで新規タブで開く";
}

export function renderMarkdownDocument(
  text: string,
  selection: ViewerSelection | null,
  options: MarkdownRenderOptions = {},
): MarkdownRenderResult {
  const article = document.createElement("article");
  const sourceLines = text.split(/\r?\n/);
  const markdown = new MarkdownIt({
    breaks: options.breaks ?? true,
    html: true,
    linkify: true,
    typographer: false,
  });
  const rawHtml = (tokens: { content: string }[], index: number) =>
    renderRawHtml(tokens[index].content, markdown.utils.escapeHtml);
  markdown.renderer.rules.html_block = rawHtml;
  markdown.renderer.rules.html_inline = rawHtml;
  const tokens = markdown.parse(text, {});
  tokens.forEach((token) => {
    if (token.nesting === 1 && token.map) {
      token.attrSet("data-source-start", String(token.map[0]));
      token.attrSet("data-source-end", String(token.map[1]));
      token.attrSet("data-source-text", sourceLines.slice(token.map[0], token.map[1]).join("\n"));
    }
  });
  article.innerHTML = markdown.renderer.render(tokens, markdown.options, {});
  decorateTaskListItems(article);
  assignMarkdownHeadingIds(article);
  const sourceElements = [...article.querySelectorAll<HTMLElement>("[data-source-start]")];
  const highlightTargets = markdownHighlightTargets(sourceElements);
  highlightTargets.forEach((element) => {
    const start = Number(element.dataset.sourceStart);
    const end = Number(element.dataset.sourceEnd);
    const selected = markdownBlockSelected(selection, start, end);
    element.classList.toggle("viewer-source-selected", !isCollapsedViewerSelection(selection) && selected);
    element.classList.toggle("viewer-caret-line", isCollapsedViewerSelection(selection) && selected);
  });
  placeMarkdownCaret(highlightTargets, selection);
  article.querySelectorAll("a").forEach((link) => {
    link.target = "_blank";
    link.rel = "noreferrer";
    link.title = markdownLinkTitle(link.getAttribute("href") ?? "", options);
  });
  return { article, highlightTargets };
}
