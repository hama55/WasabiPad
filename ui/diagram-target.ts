import { remark } from "remark";
import remarkGfm from "remark-gfm";
import { decodeString } from "micromark-util-decode-string";
import { escapeXml } from "./diagram";
import type { Pos } from "./api";

export interface DiagramTarget {
  start: number;
  end: number;
  src: string;
  alt: string;
  width?: number;
  raw: string;
}
interface Node {
  type: string;
  url?: string;
  alt?: string;
  value?: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}
export function diagramTargetAt(text: string, offset: number): DiagramTarget | null {
  const root = remark().use(remarkGfm).parse(text) as Node;
  let result: DiagramTarget | null = null;
  const visit = (node: Node) => {
    const start = node.position?.start.offset ?? -1, end = node.position?.end.offset ?? -1;
    if (offset < start || offset >= end) return;
    if (node.type === "image") {
      result = { start, end, src: node.url ?? "", alt: node.alt ?? "", raw: text.slice(start, end) };
    } else if (node.type === "imageReference") {
      throw new Error("参照定義形式の画像は対象を安全に特定できません。画像の直接参照を使ってください。");
    } else if (node.type === "html") {
      const value = text.slice(start, end);
      const tags = /<img\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
      let match: RegExpExecArray | null;
      while ((match = tags.exec(value))) {
        const first = start + match.index, last = first + match[0].length;
        if (offset < first || offset >= last) continue;
        const attrs = [...match[0].matchAll(/\s([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)];
        const sources = attrs.filter((a) => a[1].toLowerCase() === "src");
        if (sources.length !== 1) throw new Error("画像の参照先を特定できません");
        const attribute = (name: string) => attrs.find((a) => a[1].toLowerCase() === name);
        const valueOf = (a: RegExpMatchArray | undefined) => decodeString(a?.[2] ?? a?.[3] ?? a?.[4] ?? "");
        const width = Number(valueOf(attribute("width")));
        result = { start: first, end: last, src: valueOf(sources[0]), alt: valueOf(attribute("alt")), raw: match[0], ...width > 0 ? { width } : {} };
      }
      if (!result) {
        const before = value.slice(0, offset - start + 1);
        const opening = before.toLowerCase().lastIndexOf("<img");
        if (opening >= 0 && !before.slice(opening).includes(">")) throw new Error("画像記述が壊れているため編集できません");
      }
    } else if (node.type === "text") {
      const before = text.slice(start, offset + 1), opening = before.toLowerCase().lastIndexOf("<img");
      if (opening >= 0 && !before.slice(opening).includes(">")) throw new Error("画像記述が壊れているため編集できません");
      const image = text.slice(start, end), label = image.lastIndexOf("![", offset - start);
      if (label >= 0 && image.slice(label).includes("](") && !image.slice(label).includes(")")) throw new Error("画像記述が壊れているため編集できません");
    } else if (node.type !== "code" && node.type !== "inlineCode") node.children?.forEach(visit);
  };
  visit(root);
  return result;
}

export function diagramInsertion(text: string, offset: number, tag: string): { start: number; end: number; text: string } {
  const newline = text.indexOf("\n", offset);
  const start = newline < 0 ? text.length : newline + 1;
  return { start, end: start, text: (newline < 0 ? "\n" : "") + tag };
}

export function diagramImageTag(src: string, width?: number, alt = "図"): string {
  return `<img src="${escapeXml(src)}" alt="${escapeXml(alt)}"${width ? ` width="${width}"` : ""}>`;
}

export function replaceDiagramTarget(target: DiagramTarget, src: string): string {
  if (/^<img\b/i.test(target.raw)) return target.raw.replace(/(\ssrc\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>]+)/i, (_match, prefix: string) => `${prefix}"${escapeXml(src)}"`);
  return diagramImageTag(src, target.width, target.alt);
}

export function offsetToDiagramPos(text: string, offset: number, firstLine = 0): Pos {
  const prefix = text.slice(0, offset), lines = prefix.split("\n");
  return { line: firstLine + lines.length - 1, col: Array.from(lines[lines.length - 1]).length };
}
