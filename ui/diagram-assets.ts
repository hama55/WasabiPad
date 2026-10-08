import { readDiagramSvg, validateStandaloneSvg, writeDiagramSvg } from "./diagram";
import { imageMimeType } from "./image-formats";

export function imageDataUrl(bytes: ArrayBuffer, mimeType: string): string {
  const array = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < array.length; i += 8192) binary += String.fromCharCode(...array.subarray(i, i + 8192));
  return `data:${mimeType};base64,${btoa(binary)}`;
}

export async function composeDiagramPreview(
  svg: string,
  readImage: (relativePath: string) => Promise<ArrayBuffer>,
): Promise<{ svg: string; missing: string[] } | null> {
  const diagram = readDiagramSvg(svg);
  if (!diagram) return null;
  const sources = new Map<string, string>();
  const missing: string[] = [];
  for (const element of diagram.elements) {
    if (element.kind !== "image" || !element.src || sources.has(element.src)) continue;
    try {
      const mimeType = imageMimeType(element.src);
      const bytes = await readImage(element.src);
      if (mimeType === "image/svg+xml") validateStandaloneSvg(new TextDecoder().decode(bytes));
      sources.set(element.src, imageDataUrl(bytes, mimeType));
    } catch {
      sources.set(element.src, "");
      missing.push(element.src);
    }
  }
  return { svg: writeDiagramSvg(diagram, sources), missing };
}
