import { previewSizeFromPointer, type PreviewPlacement } from "./preview-layout";

export interface PreviewResizePorts {
  placement: () => PreviewPlacement;
  bounds: () => Pick<DOMRect, "left" | "right" | "top" | "bottom">;
  setSize: (size: number) => void;
  onStart?: () => void;
  onStop?: () => void;
}

export function bindPreviewResize(splitter: HTMLElement, ports: PreviewResizePorts): () => void {
  let pointerId: number | null = null;

  function stop() {
    if (pointerId === null) return;
    const activePointerId = pointerId;
    pointerId = null;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stopPointer);
    window.removeEventListener("pointercancel", stopPointer);
    window.removeEventListener("blur", stop);
    if (splitter.hasPointerCapture?.(activePointerId)) splitter.releasePointerCapture?.(activePointerId);
    ports.onStop?.();
  }

  function stopPointer(event: PointerEvent) {
    if (pointerId !== event.pointerId) return;
    stop();
  }

  function move(event: PointerEvent) {
    if (pointerId !== event.pointerId) return;
    if (event.buttons === 0) {
      stop();
      return;
    }
    const placement = ports.placement();
    const bounds = ports.bounds();
    const horizontal = placement === "right";
    ports.setSize(previewSizeFromPointer(
      placement, horizontal ? bounds.left : bounds.top, horizontal ? bounds.right : bounds.bottom,
      horizontal ? event.clientX : event.clientY,
    ));
  }

  function start(event: PointerEvent) {
    if (event.button !== 0 || pointerId !== null) return;
    event.preventDefault();
    pointerId = event.pointerId;
    splitter.setPointerCapture?.(event.pointerId);
    ports.onStart?.();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stopPointer);
    window.addEventListener("pointercancel", stopPointer);
    window.addEventListener("blur", stop);
  }

  splitter.addEventListener("pointerdown", start);
  return () => {
    stop();
    splitter.removeEventListener("pointerdown", start);
  };
}
