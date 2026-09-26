export interface AbcAddonStatus {
  version: string;
  enabled: boolean;
}

export interface AbcPreviewHostPlayback {
  tunes: Array<{ title: string }>;
  play(index: number): Promise<void>;
  stop(): void;
  dispose(): void;
}

export interface AbcPreviewHostModule {
  createAbcPreview(
    container: HTMLElement,
    text: string,
    options: { soundFontUrl: string },
  ): AbcPreviewHostPlayback;
}

export interface AbcPreviewHostOptions {
  getStatus: () => Promise<AbcAddonStatus | null>;
  loadModule: (url: string) => Promise<AbcPreviewHostModule>;
  reportError: (error: unknown) => void;
}

export interface AbcPreviewHost {
  render(text: string): Promise<void>;
  dispose(): void;
}

const ENTRY_ORIGIN = "http://wasabi-addin.localhost";
const NOT_INSTALLED_MESSAGE = "ABCアドイン未導入です。設定から追加してください。";
const DISABLED_MESSAGE = "ABCアドインは無効です。設定から有効にしてください。";
const LOAD_ERROR_MESSAGE = "ABCプレビューを読み込めませんでした。";
const PLAY_ERROR_MESSAGE = "再生に失敗しました。";
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function showMessage(container: HTMLElement, message: string): void {
  const element = container.ownerDocument.createElement("p");
  element.setAttribute("role", "status");
  element.textContent = message;
  container.replaceChildren(element);
}

export function createAbcPreviewHost(
  container: HTMLElement,
  options: AbcPreviewHostOptions,
): AbcPreviewHost {
  let generation = 0;
  let playbackGeneration = 0;
  let disposed = false;
  let activePreview: AbcPreviewHostPlayback | null = null;
  let activeListeners: AbortController | null = null;

  const isCurrent = (renderGeneration: number): boolean =>
    !disposed && generation === renderGeneration;

  function reportError(error: unknown): void {
    try {
      options.reportError(error);
    } catch {
      // Reporting must not interrupt preview cleanup or the visible error state.
    }
  }

  function stopAndDisposePreview(): void {
    playbackGeneration += 1;
    activeListeners?.abort();
    activeListeners = null;
    const preview = activePreview;
    activePreview = null;
    if (!preview) return;

    try {
      preview.stop();
    } catch (error) {
      reportError(error);
    }
    try {
      preview.dispose();
    } catch (error) {
      reportError(error);
    }
  }

  function fail(renderGeneration: number, message: string, error: unknown): void {
    if (!isCurrent(renderGeneration)) return;
    showMessage(container, message);
    reportError(error);
  }

  return {
    async render(text: string): Promise<void> {
      if (disposed) return;
      const renderGeneration = ++generation;
      stopAndDisposePreview();
      showMessage(container, "ABCアドインを読み込んでいます。");

      let status: AbcAddonStatus | null;
      try {
        status = await options.getStatus();
      } catch (error) {
        fail(renderGeneration, LOAD_ERROR_MESSAGE, error);
        return;
      }
      if (!isCurrent(renderGeneration)) return;
      if (status === null) {
        showMessage(container, NOT_INSTALLED_MESSAGE);
        return;
      }
      if (!status.enabled) {
        showMessage(container, DISABLED_MESSAGE);
        return;
      }
      if (typeof status.version !== "string" || !SAFE_VERSION.test(status.version)) {
        fail(renderGeneration, LOAD_ERROR_MESSAGE, new Error("ABC add-in version is invalid."));
        return;
      }

      const document = container.ownerDocument;
      const root = document.createElement("section");
      root.className = "viewer-abc-preview";
      const toolbar = document.createElement("div");
      toolbar.className = "abc-preview-toolbar";
      const tuneLabel = document.createElement("label");
      tuneLabel.append(document.createTextNode("曲 "));
      const tuneSelect = document.createElement("select");
      tuneSelect.setAttribute("aria-label", "ABCの曲");
      tuneLabel.append(tuneSelect);
      const playButton = document.createElement("button");
      playButton.type = "button";
      playButton.textContent = "再生";
      playButton.disabled = true;
      const stopButton = document.createElement("button");
      stopButton.type = "button";
      stopButton.textContent = "停止";
      stopButton.disabled = true;
      const statusMessage = document.createElement("p");
      statusMessage.className = "abc-preview-status";
      statusMessage.setAttribute("role", "status");
      statusMessage.textContent = "譜面を読み込んでいます。";
      const score = document.createElement("div");
      score.className = "abc-preview-score";
      toolbar.append(tuneLabel, playButton, stopButton);
      root.append(toolbar, statusMessage, score);
      container.replaceChildren(root);

      const baseUrl = ENTRY_ORIGIN + "/abc/" + status.version;
      let module: AbcPreviewHostModule;
      try {
        module = await options.loadModule(baseUrl + "/dist/entry.js");
      } catch (error) {
        fail(renderGeneration, LOAD_ERROR_MESSAGE, error);
        return;
      }
      if (!isCurrent(renderGeneration)) return;

      let preview: AbcPreviewHostPlayback;
      try {
        preview = module.createAbcPreview(score, text, {
          soundFontUrl: baseUrl + "/soundfont/",
        });
        activePreview = preview;
        if (!Array.isArray(preview.tunes) || preview.tunes.some((tune) => typeof tune.title !== "string")) {
          throw new TypeError("ABC preview returned an invalid tune list.");
        }
      } catch (error) {
        if (activePreview) {
          stopAndDisposePreview();
        }
        fail(renderGeneration, LOAD_ERROR_MESSAGE, error);
        return;
      }

      tuneSelect.replaceChildren(...preview.tunes.map((tune, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = tune.title;
        return option;
      }));
      playButton.disabled = preview.tunes.length === 0;
      tuneSelect.disabled = preview.tunes.length < 2;
      statusMessage.textContent = "";

      const listeners = new AbortController();
      activeListeners = listeners;
      playButton.addEventListener("click", () => {
        if (!isCurrent(renderGeneration) || activePreview !== preview) return;
        const requestGeneration = ++playbackGeneration;
        const index = Number(tuneSelect.value);
        stopButton.disabled = false;
        statusMessage.textContent = "再生を準備しています。";
        let playback: Promise<void>;
        try {
          playback = preview.play(index);
        } catch (error) {
          statusMessage.textContent = PLAY_ERROR_MESSAGE;
          reportError(error);
          return;
        }
        void playback.then(() => {
          if (
            isCurrent(renderGeneration) &&
            activePreview === preview &&
            playbackGeneration === requestGeneration
          ) {
            statusMessage.textContent = "再生中です。";
          }
        }).catch((error: unknown) => {
          if (
            !isCurrent(renderGeneration) ||
            activePreview !== preview ||
            playbackGeneration !== requestGeneration
          ) return;
          statusMessage.textContent = PLAY_ERROR_MESSAGE;
          reportError(error);
        });
      }, { signal: listeners.signal });

      stopButton.addEventListener("click", () => {
        if (!isCurrent(renderGeneration) || activePreview !== preview) return;
        playbackGeneration += 1;
        try {
          preview.stop();
          stopButton.disabled = true;
          statusMessage.textContent = "停止しました。";
        } catch (error) {
          statusMessage.textContent = PLAY_ERROR_MESSAGE;
          reportError(error);
        }
      }, { signal: listeners.signal });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      generation += 1;
      stopAndDisposePreview();
      container.replaceChildren();
    },
  };
}
