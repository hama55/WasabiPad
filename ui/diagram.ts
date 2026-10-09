export type DiagramKind = "rect" | "ellipse" | "line" | "arrow" | "callout" | "text" | "image";
export interface DiagramElement {
  id: number;
  kind: DiagramKind;
  x: number;
  y: number;
  width: number;
  height: number;
  stroke?: string;
  strokeWidth?: number;
  fill?: string;
  text?: string;
  fontSize?: number;
  textColor?: string;
  src?: string;
}
export interface Diagram {
  width: number;
  height: number;
  elements: DiagramElement[];
}
export interface DiagramBounds { x: number; y: number; width: number; height: number }

function diagramPathPoints(e: DiagramElement): [number, number][] {
  if (e.kind === "arrow") {
    const x = e.x + e.width, y = e.y + e.height;
    const angle = Math.atan2(e.height, e.width), size = 10 + (e.strokeWidth ?? 2);
    return [[x - size * Math.cos(angle - .45), y - size * Math.sin(angle - .45)], [x, y],
      [x - size * Math.cos(angle + .45), y - size * Math.sin(angle + .45)]];
  }
  const x = Math.min(e.x, e.x + e.width), y = Math.min(e.y, e.y + e.height), w = Math.abs(e.width), h = Math.abs(e.height);
  return [[x, y], [x + w, y], [x + w, y + h * .75], [x + w * .4, y + h * .75],
    [x + w * .2, y + h], [x + w * .2, y + h * .75], [x, y + h * .75]];
}

// SVG uses butt caps and miter joins (limit 4); include their painted extent, not just the path vertices.
function strokePoints(points: [number, number][], half: number, closed = false): [number, number][] {
  const result = [...points];
  const normals = points.map((p, i) => {
    const q = points[(i + 1) % points.length], dx = q[0] - p[0], dy = q[1] - p[1], length = Math.hypot(dx, dy);
    return length ? [-dy / length, dx / length] : [0, 0];
  });
  for (let i = 0; i < (closed ? points.length : points.length - 1); i++) {
    for (const p of [points[i], points[(i + 1) % points.length]]) {
      for (const sign of [-1, 1]) result.push([p[0] + sign * half * normals[i][0], p[1] + sign * half * normals[i][1]]);
    }
  }
  for (let i = closed ? 0 : 1; i < (closed ? points.length : points.length - 1); i++) {
    const a = normals[(i + points.length - 1) % points.length], b = normals[i];
    const denominator = 1 + a[0] * b[0] + a[1] * b[1];
    if (denominator <= 0) continue;
    const dx = (a[0] + b[0]) / denominator, dy = (a[1] + b[1]) / denominator;
    if (Math.hypot(dx, dy) > 4) continue;
    for (const sign of [-1, 1]) result.push([points[i][0] + sign * half * dx, points[i][1] + sign * half * dy]);
  }
  return result;
}

export function diagramContentBounds(diagram: Diagram, measureText: (element: DiagramElement) => DiagramBounds): DiagramBounds | null {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  const include = (x: number, y: number) => { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); };
  for (const e of diagram.elements) {
    const x = Math.min(e.x, e.x + e.width), y = Math.min(e.y, e.y + e.height), w = Math.abs(e.width), h = Math.abs(e.height);
    const half = (e.stroke ?? "#ff0000") === "none" ? 0 : (e.strokeWidth ?? 2) / 2;
    if (e.kind === "line" || e.kind === "arrow") {
      for (const p of strokePoints([[e.x, e.y], [e.x + e.width, e.y + e.height]], half)) include(...p);
      if (e.kind === "arrow") for (const p of strokePoints(diagramPathPoints(e), half)) include(...p);
    } else if (e.kind === "callout") {
      for (const p of strokePoints(diagramPathPoints(e), half, true)) include(...p);
    } else if (e.kind !== "text") {
      const stroke = e.kind === "image" ? 0 : half;
      include(x - stroke, y - stroke); include(x + w + stroke, y + h + stroke);
    }
    if ((e.kind === "text" || e.kind === "callout") && e.text) {
      const bounds = measureText(e);
      if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width < 0 || bounds.height < 0) throw new Error("文字の表示範囲を取得できません");
      include(bounds.x, bounds.y); include(bounds.x + bounds.width, bounds.y + bounds.height);
    }
  }
  return left === Infinity ? null : { x: left, y: top, width: right - left, height: bottom - top };
}

export function fitDiagramCanvas(diagram: Diagram, bounds: DiagramBounds | null, trim = false): Diagram {
  if (!bounds) return validateDiagram(diagram);
  const dx = trim ? -bounds.x : Math.max(0, -bounds.x), dy = trim ? -bounds.y : Math.max(0, -bounds.y);
  const width = trim ? Math.max(1, bounds.width) : Math.max(diagram.width, bounds.x + bounds.width) + dx;
  const height = trim ? Math.max(1, bounds.height) : Math.max(diagram.height, bounds.y + bounds.height) + dy;
  if (width > 10000 || height > 10000) throw new Error("図の内容がキャンバスの上限（10000）を超えています");
  return validateDiagram({ width, height, elements: diagram.elements.map((e) => ({ ...e, x: e.x + dx, y: e.y + dy })) });
}
const kinds: DiagramKind[] = ["rect", "ellipse", "line", "arrow", "callout", "text", "image"];
export const DIAGRAM_MARKER = "wasabipad-diagram";
export const escapeXml = (text: string) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
const color = (value: unknown) => value === "none" || typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
const finite = (value: unknown, min = -100000, max = 100000): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

export function isLocalDiagramImage(src: string): boolean {
  return Boolean(src) && !/[\x00-\x1f%?#:/\\]/.test(src) && src !== "..";
}

export function validateDiagram(value: unknown): Diagram {
  const fail = () => { throw new Error("図のデータが不正です"); };
  if (!value || typeof value !== "object") return fail();
  const d = value as Diagram;
  if (!finite(d.width, 1, 10000) || !finite(d.height, 1, 10000) || !Array.isArray(d.elements) || d.elements.length > 2000) return fail();
  const ids = new Set<number>();
  const elements = d.elements.map((e) => {
    if (!e || !kinds.includes(e.kind) || !Number.isSafeInteger(e.id) || e.id < 0 || ids.has(e.id)
      || !finite(e.x) || !finite(e.y) || !finite(e.width) || !finite(e.height)
      || e.stroke !== undefined && !color(e.stroke) || e.fill !== undefined && !color(e.fill)
      || e.textColor !== undefined && !color(e.textColor)
      || e.strokeWidth !== undefined && !finite(e.strokeWidth, 0, 100)
      || e.fontSize !== undefined && !finite(e.fontSize, 1, 300)
      || e.text !== undefined && (typeof e.text !== "string" || e.text.length > 100000)
      || e.kind === "image" && (typeof e.src !== "string" || !isLocalDiagramImage(e.src))) return fail();
    ids.add(e.id);
    // Only the editor's schema is retained; untrusted SVG markup never becomes executable DOM.
    return { id: e.id, kind: e.kind, x: e.x, y: e.y, width: e.width, height: e.height,
      ...e.stroke !== undefined ? { stroke: e.stroke } : {}, ...e.strokeWidth !== undefined ? { strokeWidth: e.strokeWidth } : {},
      ...e.fill !== undefined ? { fill: e.fill } : {}, ...e.text !== undefined ? { text: e.text } : {},
      ...e.fontSize !== undefined ? { fontSize: e.fontSize } : {}, ...e.textColor !== undefined ? { textColor: e.textColor } : {},
      ...e.kind === "image" ? { src: e.src } : {} };
  });
  return { width: d.width, height: d.height, elements };
}

export class DiagramDocument {
  value: Diagram;
  private undoStack: Diagram[] = [];
  private redoStack: Diagram[] = [];
  constructor(value: Diagram) { this.value = validateDiagram(value); }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  change(value: Diagram) {
    const next = validateDiagram(value);
    if (JSON.stringify(next) === JSON.stringify(this.value)) return;
    this.undoStack.push(this.value);
    this.redoStack = [];
    this.value = next;
  }
  add(value: Omit<DiagramElement, "id">): number {
    const id = Math.max(0, ...this.value.elements.map((e) => e.id)) + 1;
    this.change({ ...this.value, elements: [...this.value.elements, { ...value, id }] });
    return id;
  }
  update(id: number, changes: Partial<DiagramElement>) { this.change({ ...this.value, elements: this.value.elements.map((e) => e.id === id ? { ...e, ...changes, id } : e) }); }
  remove(id: number) { this.change({ ...this.value, elements: this.value.elements.filter((e) => e.id !== id) }); }
  reorder(id: number, front: boolean) {
    const element = this.value.elements.find((e) => e.id === id);
    if (!element) return;
    const rest = this.value.elements.filter((e) => e.id !== id);
    this.change({ ...this.value, elements: front ? [...rest, element] : [element, ...rest] });
  }
  undo() { const previous = this.undoStack.pop(); if (previous) { this.redoStack.push(this.value); this.value = previous; } }
  redo() { const next = this.redoStack.pop(); if (next) { this.undoStack.push(this.value); this.value = next; } }
}

export function diagramElementSvg(e: DiagramElement, imageSrc = e.src ?? ""): string {
  const x = Math.min(e.x, e.x + e.width), y = Math.min(e.y, e.y + e.height);
  const w = Math.abs(e.width), h = Math.abs(e.height);
  const style = `stroke="${e.stroke ?? "#ff0000"}" stroke-width="${e.strokeWidth ?? 2}" fill="${e.fill ?? "none"}"`;
  const text = (e.text ?? "").split("\n").map((line, i) => `<tspan x="${x + 8}" dy="${i ? (e.fontSize ?? 20) * 1.3 : 0}">${escapeXml(line)}</tspan>`).join("");
  const label = `<text x="${x + 8}" y="${y + (e.fontSize ?? 20) + 4}" fill="${e.textColor ?? (e.kind === "text" ? e.fill ?? "#000000" : "#000000")}" font-size="${e.fontSize ?? 20}" font-family="sans-serif">${text}</text>`;
  switch (e.kind) {
    case "image": return imageSrc ? `<image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none" href="${escapeXml(imageSrc)}"/>`
      : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#888888" stroke-dasharray="4 3"/><text x="${x + 8}" y="${y + 24}" fill="#666666" font-size="16">背景画像が見つからないか、読み込めません</text>`;
    case "rect": return `<rect x="${x}" y="${y}" width="${w}" height="${h}" ${style}/>`;
    case "ellipse": return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" ${style}/>`;
    case "line": case "arrow": {
      const endX = e.x + e.width, endY = e.y + e.height;
      const line = `<line x1="${e.x}" y1="${e.y}" x2="${endX}" y2="${endY}" ${style}/>`;
      if (e.kind === "line") return line;
      return line + `<path d="${diagramPathPoints(e).map(([px, py], i) => `${i ? "L" : "M"} ${px} ${py}`).join(" ")}" ${style}/>`;
    }
    case "callout": return `<path d="${diagramPathPoints(e).map(([px, py], i) => `${i ? "L" : "M"} ${px} ${py}`).join(" ")} Z" ${style}/>` + label;
    case "text": return label;
  }
}

export function writeDiagramSvg(diagram: Diagram, imageSources?: Map<string, string>): string {
  const d = validateDiagram(diagram);
  // Metadata is the editable source; visible SVG geometry is always derived from it.
  const metadata = imageSources ? "" : `<metadata id="${DIAGRAM_MARKER}">${escapeXml(JSON.stringify(d))}</metadata>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${d.width}" height="${d.height}" viewBox="0 0 ${d.width} ${d.height}">${metadata}${d.elements.map((e) => diagramElementSvg(e, e.src ? imageSources ? imageSources.get(e.src) ?? "" : e.src : "")).join("")}</svg>`;
}

export function readDiagramSvg(svg: string): Diagram | null {
  if (!svg.includes(DIAGRAM_MARKER)) return null;
  const xml = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (xml.querySelector("parsererror") || xml.documentElement.localName !== "svg") throw new Error("図の SVG を読み込めません");
  const metadata = [...xml.querySelectorAll("metadata")].filter((e) => e.id === DIAGRAM_MARKER);
  if (metadata.length !== 1) throw new Error("図の編集情報が不正です");
  return validateDiagram(JSON.parse(metadata[0].textContent ?? ""));
}

export function validateStandaloneSvg(svg: string): void {
  const xml = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (xml.querySelector("parsererror") || xml.documentElement.localName !== "svg") throw new Error("SVG を読み込めません");
  for (const node of [xml.documentElement, ...xml.querySelectorAll("*")]) {
    if (["script", "foreignObject", "style", "animate", "set"].includes(node.localName)) throw new Error("外部依存や動作を含む SVG は背景に使えません");
    for (const attr of [...node.attributes]) {
      if (/^on/i.test(attr.name) || /(?:url\(\s*["']?(?!#)|@import|@font-face)/i.test(attr.value)
        || /(?:^|:)href$/i.test(attr.name) && !attr.value.startsWith("#") && !/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(attr.value)) throw new Error("外部依存を含む SVG は背景に使えません");
    }
  }
}
