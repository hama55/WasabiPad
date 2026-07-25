// 可視行のチャンクキャッシュ。backend との往復と LRU 破棄はここだけの責務で、
// 描画やキャレットの都合は持ち込まない。
import type { DocumentClient, Pos } from "./api";
import { charLen } from "./editor-math";

export const CHUNK = 512; // 行取得のバックエンド往復単位
const CACHE_MAX = 64;

export class LineCache {
  private chunks = new Map<number, string[]>();
  private pending = new Set<number>();

  constructor(private doc: DocumentClient) {}

  static chunkOf(line: number): number {
    return Math.floor(line / CHUNK);
  }

  clear() {
    this.chunks.clear();
    this.pending.clear();
  }

  has(chunk: number): boolean {
    return this.chunks.has(chunk);
  }

  // 取得済みなら同期で返す (描画中に await したくない経路用)
  peek(line: number): string | undefined {
    const chunk = LineCache.chunkOf(line);
    return this.chunks.get(chunk)?.[line - chunk * CHUNK];
  }

  async fetch(chunk: number): Promise<void> {
    if (this.chunks.has(chunk) || this.pending.has(chunk)) return;
    this.pending.add(chunk);
    try {
      this.chunks.set(chunk, await this.doc.lines(chunk * CHUNK, CHUNK));
      while (this.chunks.size > CACHE_MAX) {
        const oldest = this.chunks.keys().next().value!;
        if (oldest === chunk) break;
        this.chunks.delete(oldest);
      }
    } finally {
      this.pending.delete(chunk);
    }
  }

  async line(index: number): Promise<string> {
    const cached = this.peek(index);
    if (cached !== undefined) return cached;
    await this.fetch(LineCache.chunkOf(index));
    return this.peek(index) ?? "";
  }

  async lineLength(index: number): Promise<number> {
    const cached = this.peek(index);
    return cached !== undefined ? charLen(cached) : this.doc.lineCharLen(index);
  }

  // 編集で fromLine 以降の行番号がずれるため、その位置に触れるチャンクを捨てる
  invalidateFrom(fromLine: number) {
    for (const chunk of [...this.chunks.keys()]) {
      if (chunk * CHUNK + CHUNK > fromLine) this.chunks.delete(chunk);
    }
  }

  async textInRange(start: Pos, end: Pos): Promise<string> {
    const parts: string[] = [];
    for (let i = start.line; i <= end.line; i += 1) {
      const text = await this.line(i);
      if (i === start.line && i === end.line) parts.push([...text].slice(start.col, end.col).join(""));
      else if (i === start.line) parts.push([...text].slice(start.col).join(""));
      else if (i === end.line) parts.push([...text].slice(0, end.col).join(""));
      else parts.push(text);
    }
    return parts.join("\n");
  }
}
