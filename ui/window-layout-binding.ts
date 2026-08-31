export interface LayoutResizeTarget {
  addEventListener(type: "resize", listener: () => void): void;
  removeEventListener(type: "resize", listener: () => void): void;
}

export function bindLayoutResize(target: LayoutResizeTarget, request: () => void): () => void {
  const onResize = () => request();
  target.addEventListener("resize", onResize);
  return () => target.removeEventListener("resize", onResize);
}
