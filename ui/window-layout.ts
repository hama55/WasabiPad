export interface WindowViewport {
  width: number;
  height: number;
}

export interface WindowLayoutCoordinatorOptions {
  measure: () => WindowViewport;
  apply: (viewport: WindowViewport) => void;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
  requestRetry?: (callback: () => void, delayMs: number) => number;
  cancelRetry?: (handle: number) => void;
  retryDelayMs?: number;
  maxRetries?: number;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 250;

function validViewport(viewport: WindowViewport): WindowViewport | null {
  if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)) return null;
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  return { width: viewport.width, height: viewport.height };
}

// native window/DOMの寸法変更を、最新の有効なviewportへまとめて反映する。
// 最小化直後などの0寸法は既存レイアウトを壊さず、復元後の測定を待つ。
export class WindowLayoutCoordinator {
  private frame: number | null = null;
  private retryTimer: number | null = null;
  private dirty = false;
  private invalidRetries = 0;
  private disposed = false;
  private lastValid: WindowViewport | null = null;
  private readonly requestFrame: (callback: () => void) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly requestRetry: (callback: () => void, delayMs: number) => number;
  private readonly cancelRetry: (handle: number) => void;
  private readonly retryDelayMs: number;
  private readonly maxRetries: number;

  constructor(private readonly options: WindowLayoutCoordinatorOptions) {
    this.requestFrame = options.requestFrame ?? ((callback) => window.requestAnimationFrame(callback));
    this.cancelFrame = options.cancelFrame ?? ((handle) => window.cancelAnimationFrame(handle));
    this.requestRetry = options.requestRetry ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
    this.cancelRetry = options.cancelRetry ?? ((handle) => window.clearTimeout(handle));
    this.retryDelayMs = Math.max(16, Math.floor(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_MAX_RETRIES));
  }

  get lastValidViewport(): WindowViewport | null {
    return this.lastValid ? { ...this.lastValid } : null;
  }

  request() {
    if (this.disposed) return;
    this.cancelPendingRetry();
    this.dirty = true;
    this.invalidRetries = 0;
    this.schedule();
  }

  // 起動時など、現在の寸法を直ちに1回反映する。未確定なら次フレームへ回す。
  refresh(): WindowViewport | null {
    if (this.disposed) return this.lastValidViewport;
    this.cancelPendingFrame();
    this.cancelPendingRetry();
    this.dirty = false;
    this.invalidRetries = 0;
    const viewport = this.commitMeasuredViewport();
    if (!viewport) {
      this.dirty = true;
      this.invalidRetries = 1;
      this.schedule();
    }
    return viewport;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.dirty = false;
    this.cancelPendingFrame();
    this.cancelPendingRetry();
  }

  private schedule() {
    if (!this.dirty || this.frame !== null || this.disposed) return;
    this.frame = this.requestFrame(() => {
      this.frame = null;
      this.flushFrame();
    });
  }

  private flushFrame() {
    if (!this.dirty || this.disposed) return;
    this.dirty = false;
    if (this.commitMeasuredViewport()) {
      this.invalidRetries = 0;
      return;
    }
    if (this.invalidRetries < this.maxRetries) {
      this.invalidRetries += 1;
      this.dirty = true;
      this.schedule();
      return;
    }
    // 最小化中に毎フレーム回し続けず、復元通知を取り逃がしても低頻度で再測定する。
    this.invalidRetries = 0;
    this.dirty = true;
    this.scheduleRetry();
  }

  private commitMeasuredViewport(): WindowViewport | null {
    let measured: WindowViewport;
    try {
      measured = this.options.measure();
    } catch {
      return null;
    }
    const viewport = validViewport(measured);
    if (!viewport) return null;
    this.lastValid = viewport;
    this.options.apply({ ...viewport });
    return viewport;
  }

  private cancelPendingFrame() {
    if (this.frame === null) return;
    this.cancelFrame(this.frame);
    this.frame = null;
  }

  private scheduleRetry() {
    if (!this.dirty || this.retryTimer !== null || this.disposed) return;
    this.retryTimer = this.requestRetry(() => {
      this.retryTimer = null;
      if (!this.dirty || this.disposed) return;
      this.schedule();
    }, this.retryDelayMs);
  }

  private cancelPendingRetry() {
    if (this.retryTimer === null) return;
    this.cancelRetry(this.retryTimer);
    this.retryTimer = null;
  }
}
