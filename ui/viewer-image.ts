export function createImagePreview(label: string): { wrapper: HTMLDivElement; image: HTMLImageElement } {
  const wrapper = document.createElement("div");
  wrapper.className = "viewer-image-wrap";
  const image = document.createElement("img");
  image.className = "viewer-image";
  image.alt = label;
  wrapper.appendChild(image);
  return { wrapper, image };
}
