export const MARKDOWN_IMAGE_LOAD_CONCURRENCY = 3;

export interface MarkdownImageLoadOptions {
  isPriority?: (image: HTMLImageElement) => boolean;
}

/**
 * Markdown画像を上限付きで読み込む。個別の失敗は次の画像へ影響させない。
 * priority は表示領域に近い画像を先に流すためのヒントで、順序以外の保証はしない。
 */
export function scheduleMarkdownImageLoads(
  images: readonly HTMLImageElement[],
  load: (image: HTMLImageElement) => void | Promise<void>,
  options: MarkdownImageLoadOptions = {},
): Promise<void> {
  const isPriority = options.isPriority ?? (() => false);
  const ordered = images
    .map((image, index) => ({ image, index, priority: isPriority(image) }))
    .sort((left, right) => Number(right.priority) - Number(left.priority) || left.index - right.index)
    .map(({ image }) => image);
  let nextIndex = 0;
  let active = 0;

  return new Promise<void>((resolve) => {
    const pump = () => {
      while (active < MARKDOWN_IMAGE_LOAD_CONCURRENCY && nextIndex < ordered.length) {
        const image = ordered[nextIndex++];
        active += 1;
        Promise.resolve()
          .then(() => load(image))
          .catch(() => {
            // 1枚の破損・読込失敗で、同じ文書の後続画像を止めない。
          })
          .finally(() => {
            active -= 1;
            if (nextIndex >= ordered.length && active === 0) {
              resolve();
              return;
            }
            pump();
          });
      }
      if (nextIndex >= ordered.length && active === 0) resolve();
    };

    pump();
  });
}
