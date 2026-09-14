export class ViewerAssetTracker {
  private readonly urls = new Map<string, number>();

  constructor(private readonly revoke: (url: string) => void) {}

  revokeAll() {
    const urls = [...this.urls.keys()];
    this.urls.clear();
    for (const url of urls) this.revoke(url);
  }

  revokeStale(generation: number) {
    for (const [url, owner] of this.urls) {
      if (owner === generation) continue;
      this.urls.delete(url);
      this.revoke(url);
    }
  }

  retain(url: string, generation: number, currentGeneration: number): boolean {
    if (generation !== currentGeneration) {
      this.revoke(url);
      return false;
    }
    this.urls.set(url, generation);
    return true;
  }

  release(url: string) {
    if (!this.urls.delete(url)) return;
    this.revoke(url);
  }
}
