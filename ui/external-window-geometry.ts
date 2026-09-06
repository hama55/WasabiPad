export interface ExternalWindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface PositionLike {
  x: number;
  y: number;
}

export function externalWindowRectFor(
  rect: RectLike,
  innerPosition: PositionLike,
  scaleFactor: number,
): ExternalWindowRect | null {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return null;
  const values = [rect.left, rect.top, rect.width, rect.height, innerPosition.x, innerPosition.y];
  if (!values.every(Number.isFinite)) {
    return null;
  }

  const width = Math.round(rect.width * scaleFactor);
  const height = Math.round(rect.height * scaleFactor);
  if (width <= 0 || height <= 0) return null;

  const x = Math.round(innerPosition.x + rect.left * scaleFactor);
  const y = Math.round(innerPosition.y + rect.top * scaleFactor);
  if (![x, y, width, height].every(Number.isSafeInteger)) return null;
  if (x < -2_147_483_648 || x > 2_147_483_647 || y < -2_147_483_648 || y > 2_147_483_647) return null;
  if (width > 4_294_967_295 || height > 4_294_967_295) return null;

  return {
    x,
    y,
    width,
    height,
  };
}
