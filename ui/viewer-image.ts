export function createImagePreview(label: string): { wrapper: HTMLDivElement; image: HTMLImageElement } {
  const wrapper = document.createElement("div");
  wrapper.className = "viewer-image-wrap";
  const image = document.createElement("img");
  image.className = "viewer-image";
  image.alt = label;
  wrapper.appendChild(image);
  return { wrapper, image };
}

export function markImageLoadFailure(image: HTMLImageElement, label = image.alt || "画像") {
  image.removeAttribute("src");
  image.alt = `${label}（読み込めません）`;
}
