import type { Pos } from "./api";

export const EXTERNAL_SOURCE_NAVIGATION = "wasabipad-external-source-navigation";
export const EXTERNAL_SOURCE_NAVIGATION_RESULT = "wasabipad-external-source-navigation-result";

export interface ExternalSourceNavigationRequest {
  type: typeof EXTERNAL_SOURCE_NAVIGATION;
  request_id: number;
  offset: number | null;
  end_offset?: number;
  source_hash: string;
}
export type ExternalSourceNavigator = (request: ExternalSourceNavigationRequest, isCurrent?: () => boolean) => Promise<string | null>;

export function isExternalSourceNavigationRequest(data: unknown): data is ExternalSourceNavigationRequest {
  if (!data || typeof data !== "object") return false;
  const value = data as ExternalSourceNavigationRequest;
  return value.type === EXTERNAL_SOURCE_NAVIGATION
    && Number.isSafeInteger(value.request_id) && value.request_id >= 0
    && (value.offset === null || (Number.isSafeInteger(value.offset) && value.offset >= 0))
    && (value.end_offset === undefined || (value.offset !== null && Number.isSafeInteger(value.end_offset) && value.end_offset >= value.offset))
    && typeof value.source_hash === "string" && /^[a-f0-9]{64}$/.test(value.source_hash);
}

export async function sourceTextHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function sourcePositionAtOffset(text: string, offset: number | null): Pos | null {
  if (offset === null || !Number.isSafeInteger(offset) || offset < 0 || offset > text.length) return null;
  if (offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset] ?? "")) return null;
  const lines = text.slice(0, offset).split("\n");
  return { line: lines.length - 1, col: Array.from(lines.at(-1)!).length };
}
