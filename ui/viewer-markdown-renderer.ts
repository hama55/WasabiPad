import MarkdownIt from "markdown-it";
import type { ViewerSelection } from "./api";
import {
  markdownBlockSelected,
  markdownHighlightTargets,
  placeMarkdownCaret,
  renderRawHtml,
} from "./viewer-markdown";
import { isCollapsedViewerSelection } from "./viewer-selection";

export interface MarkdownRenderResult {
  article: HTMLElement;
  highlightTargets: HTMLElement[];
}

export function renderMarkdownDocument(text: string, selection: ViewerSelection | null): MarkdownRenderResult {
  const article = document.createElement("article");
  const sourceLines = text.split(/\r?\n/);
  const markdown = new MarkdownIt({ html: true, linkify: true, typographer: false });
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
  });
  return { article, highlightTargets };
}
