export const DEFAULT_IMAGE_ZOOM = 1;
const MIN_IMAGE_ZOOM = 0.25;
const MAX_IMAGE_ZOOM = 4;
const IMAGE_ZOOM_STEP = 1.1;
const IMAGE_WRAP_PADDING = 48;

function clampImageZoom(zoom: number): number {
  return Math.min(MAX_IMAGE_ZOOM, Math.max(MIN_IMAGE_ZOOM, zoom));
}

function imageBaseSize(image: HTMLImageElement): { width: number; height: number } | null {
  const storedWidth = Number(image.dataset.viewerImageBaseWidth);
  const storedHeight = Number(image.dataset.viewerImageBaseHeight);
  if (storedWidth > 0 && storedHeight > 0) return { width: storedWidth, height: storedHeight };

  const rect = image.getBoundingClientRect();
  const width = rect.width || image.naturalWidth;
  const height = rect.height || image.naturalHeight;
  if (!(width > 0 && height > 0)) return null;
  image.dataset.viewerImageBaseWidth = String(width);
  image.dataset.viewerImageBaseHeight = String(height);
  return { width, height };
}

function wrapperBaseSize(wrapper: HTMLElement): { width: number; height: number } {
  const storedWidth = Number(wrapper.dataset.viewerImageBaseWidth);
  const storedHeight = Number(wrapper.dataset.viewerImageBaseHeight);
  if (storedWidth > 0 && storedHeight > 0) return { width: storedWidth, height: storedHeight };

  const rect = wrapper.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  wrapper.dataset.viewerImageBaseWidth = String(width);
  wrapper.dataset.viewerImageBaseHeight = String(height);
  return { width, height };
}

function resetImageZoom(image: HTMLImageElement) {
  image.style.removeProperty("width");
  image.style.removeProperty("height");
  delete image.dataset.viewerImageBaseWidth;
  delete image.dataset.viewerImageBaseHeight;
  const wrapper = image.parentElement;
  wrapper?.classList.remove("viewer-image-zoomed");
  wrapper?.style.removeProperty("width");
  wrapper?.style.removeProperty("height");
  if (wrapper instanceof HTMLElement) {
    delete wrapper.dataset.viewerImageBaseWidth;
    delete wrapper.dataset.viewerImageBaseHeight;
  }
}

export function createImagePreview(label: string): { wrapper: HTMLDivElement; image: HTMLImageElement } {
  const wrapper = document.createElement("div");
  wrapper.className = "viewer-image-wrap";
  const image = document.createElement("img");
  image.className = "viewer-image";
  image.alt = label;
  image.title = "Ctrl+ホイールでズーム";
  image.draggable = false;
  wrapper.appendChild(image);
  return { wrapper, image };
}

export function setImageZoom(image: HTMLImageElement, zoom: number): boolean {
  const current = clampImageZoom(zoom);
  if (current === DEFAULT_IMAGE_ZOOM) {
    resetImageZoom(image);
    return true;
  }
  const base = imageBaseSize(image);
  if (!base) return false;
  const width = Math.max(1, Math.round(base.width * current));
  const height = Math.max(1, Math.round(base.height * current));
  const wrapper = image.parentElement;
  if (!(wrapper instanceof HTMLElement)) return false;
  const wrapperBase = wrapperBaseSize(wrapper);
  wrapper.classList.add("viewer-image-zoomed");
  wrapper.style.width = `${Math.max(wrapperBase.width, width + IMAGE_WRAP_PADDING)}px`;
  wrapper.style.height = `${Math.max(wrapperBase.height, height + IMAGE_WRAP_PADDING)}px`;
  image.style.width = `${width}px`;
  image.style.height = `${height}px`;
  return true;
}

export function zoomImageByWheel(image: HTMLImageElement, zoom: number, deltaY: number): number {
  const current = clampImageZoom(zoom);
  if (!deltaY) return current;
  const next = current * (deltaY < 0 ? IMAGE_ZOOM_STEP : 1 / IMAGE_ZOOM_STEP);
  const rounded = Math.round(clampImageZoom(next) * 100) / 100;
  return setImageZoom(image, rounded) ? rounded : current;
}

export function bindImagePan(image: HTMLImageElement, scroll: HTMLElement): () => void {
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;

  function stop() {
    if (pointerId === null) return;
    const activePointerId = pointerId;
    pointerId = null;
    image.classList.remove("viewer-image-panning");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stopPointer);
    window.removeEventListener("pointercancel", stopPointer);
    window.removeEventListener("blur", stop);
    if (image.hasPointerCapture?.(activePointerId)) image.releasePointerCapture?.(activePointerId);
  }

  function stopPointer(event: PointerEvent) {
    if (pointerId === event.pointerId) stop();
  }

  function move(event: PointerEvent) {
    if (pointerId !== event.pointerId) return;
    if (event.buttons === 0) {
      stop();
      return;
    }
    scroll.scrollLeft = startLeft - (event.clientX - startX);
    scroll.scrollTop = startTop - (event.clientY - startY);
  }

  function start(event: PointerEvent) {
    const scrollable = scroll.scrollWidth > scroll.clientWidth || scroll.scrollHeight > scroll.clientHeight;
    if (event.button !== 0 || event.isPrimary === false || pointerId !== null || !scrollable) return;
    event.preventDefault();
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    startLeft = scroll.scrollLeft;
    startTop = scroll.scrollTop;
    image.classList.add("viewer-image-panning");
    image.setPointerCapture?.(event.pointerId);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stopPointer);
    window.addEventListener("pointercancel", stopPointer);
    window.addEventListener("blur", stop);
  }

  image.addEventListener("pointerdown", start);
  return () => {
    stop();
    image.removeEventListener("pointerdown", start);
  };
}

export function markImageLoadFailure(image: HTMLImageElement, label = image.alt || "画像") {
  image.removeAttribute("src");
  image.alt = `${label}（読み込めません）`;
}
