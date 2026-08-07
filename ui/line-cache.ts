// 可視行のチャンクキャッシュ。backend との往復と LRU 破棄はここだけの責務で、
// 描画やキャレットの都合は持ち込まない。
import type { DocumentClient, Pos } from "./api";
import { charLen } from "./editor-math";

export const CHUNK = 512; // 行取得のバックエンド往復単位
const CACHE_MAX = 64;

export class LineCache {
  private chunks = new Map<number, string[]>();
  private pending = new Map<number, { generation: number; promise: Promise<void> }>();
  private generation = 0;

  constructor(private doc: DocumentClient) {}

  static chunkOf(line: number): number {
    return Math.floor(line / CHUNK);
  }

  clear() {
    this.generation++;
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
    if (this.chunks.has(chunk)) return;
    const pending = this.pending.get(chunk);
    if (pending) {
      await pending.promise;
      return;
    }
    const generation = this.generation;
    const promise = this.fetchChunk(chunk, generation);
    this.pending.set(chunk, { generation, promise });
    await promise;
  }

  private async fetchChunk(chunk: number, generation: number): Promise<void> {
    try {
      const lines = await this.doc.lines(chunk * CHUNK, CHUNK);
      if (generation !== this.generation) return;
      this.chunks.set(chunk, lines);
      while (this.chunks.size > CACHE_MAX) {
        const oldest = this.chunks.keys().next().value!;
        if (oldest === chunk) break;
        this.chunks.delete(oldest);
      }
    } finally {
      if (this.pending.get(chunk)?.generation === generation) this.pending.delete(chunk);
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
    const invalidatedPending: number[] = [];
    for (const chunk of [...this.chunks.keys()]) {
      if (chunk * CHUNK + CHUNK > fromLine) this.chunks.delete(chunk);
    }
    for (const chunk of this.pending.keys()) {
      if (chunk * CHUNK + CHUNK > fromLine) invalidatedPending.push(chunk);
    }
    if (invalidatedPending.length) {
      this.generation++;
      for (const chunk of invalidatedPending) this.pending.delete(chunk);
    }
  }

  applySingleLineEdit(start: Pos, end: Pos, inserted: string): boolean {
    if (start.line !== end.line || inserted.includes("\n")) return false;
    const chunk = LineCache.chunkOf(start.line);
    const lines = this.chunks.get(chunk);
    const index = start.line - chunk * CHUNK;
    const current = lines?.[index];
    if (current === undefined) return false;
    const chars = [...current];
    lines![index] = `${chars.slice(0, start.col).join("")}${inserted}${chars.slice(end.col).join("")}`;
    return true;
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
