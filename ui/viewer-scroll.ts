import type { ViewerSelection } from "./api";

export interface ViewerLineRange {
  start: number;
  end: number;
}

export function scrollViewerCaret(
  elements: HTMLElement[],
  selection: ViewerSelection | null,
  rangeOf: (element: HTMLElement, index: number) => ViewerLineRange,
) {
  const line = selection?.end.line;
  if (line === undefined) return;

  const entries = elements.map((element, index) => ({ element, range: rangeOf(element, index) }));
  const target = entries.find(({ range }) => range.start <= line && line < range.end)
    ?? entries.reduce<typeof entries[number] | undefined>((nearest, entry) => {
      if (lineDistance(entry.range, line) < (nearest ? lineDistance(nearest.range, line) : Infinity)) return entry;
      return nearest;
    }, undefined);
  target?.element.scrollIntoView?.({ block: "center", inline: "nearest" });
}

function lineDistance(range: ViewerLineRange, line: number): number {
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start) return Infinity;
  return line < range.start ? range.start - line : line >= range.end ? line - range.end + 1 : 0;
}
