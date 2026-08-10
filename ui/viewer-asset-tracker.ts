export class ViewerAssetTracker {
  private readonly urls = new Set<string>();

  constructor(private readonly revoke: (url: string) => void) {}

  revokeAll() {
    const urls = [...this.urls];
    this.urls.clear();
    for (const url of urls) {
      try {
        this.revoke(url);
      } catch (error) {
        console.error("プレビュー資産URLを解放できませんでした", error);
      }
    }
  }

  retain(url: string, generation: number, currentGeneration: number): boolean {
    if (generation !== currentGeneration) {
      this.revoke(url);
      return false;
    }
    this.urls.add(url);
    return true;
  }

  release(url: string) {
    if (!this.urls.delete(url)) return;
    try {
      this.revoke(url);
    } catch (error) {
      console.error("プレビュー資産URLを解放できませんでした", error);
    }
  }
}
