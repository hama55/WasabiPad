// ドラッグ開始の判定はお気に入りとタブで同じ操作感にする。
export const DRAG_THRESHOLD = 5;

// 中クリックの判定は各UIで同じにする。
export function isMiddleClick(event: MouseEvent | undefined): boolean {
  return event?.button === 1;
}
