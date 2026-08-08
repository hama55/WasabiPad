import { previewWidthFromPointer } from "./preview-layout";

export interface PreviewResizePorts {
  mainRight: () => number;
  setWidth: (width: number) => void;
  onStart?: () => void;
  onStop?: () => void;
}

export function bindPreviewResize(splitter: HTMLElement, ports: PreviewResizePorts): () => void {
  let pointerId: number | null = null;

  function stop() {
    if (pointerId === null) return;
    pointerId = null;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
    window.removeEventListener("blur", stop);
    ports.onStop?.();
  }

  function move(event: PointerEvent) {
    if (pointerId !== event.pointerId) return;
    if (event.buttons === 0) {
      stop();
      return;
    }
    ports.setWidth(previewWidthFromPointer(ports.mainRight(), event.clientX));
  }

  function start(event: PointerEvent) {
    if (event.button !== 0 || pointerId !== null) return;
    event.preventDefault();
    pointerId = event.pointerId;
    splitter.setPointerCapture?.(event.pointerId);
    ports.onStart?.();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
  }

  splitter.addEventListener("pointerdown", start);
  return () => {
    stop();
    splitter.removeEventListener("pointerdown", start);
  };
}
