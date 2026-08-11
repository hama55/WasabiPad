export class RectangularClipboard {
  private value: { text: string; rows: string[] } | null = null;

  clear() {
    this.value = null;
  }

  set(text: string) {
    this.value = { text, rows: text.split("\n") };
  }

  rowsFor(text: string): string[] | null {
    if (this.value?.text !== text) return null;
    return [...this.value.rows];
  }
}
