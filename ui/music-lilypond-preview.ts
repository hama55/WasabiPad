export interface LilypondAddonStatus {
  version: string;
  enabled: boolean;
}

export interface LilypondPreviewResult {
  svgPages: Array<{ fileName: string; content: string }>;
  midiFiles: Array<{ displayName: string; bytes: number[] }>;
}

export interface LilypondPreviewPlayback {
  tunes: Array<{ title: string }>;
  play(index: number): Promise<void>;
  stop(): void;
  dispose(): void;
}

export interface LilypondPreviewModule {
  createLilypondPreview(
    container: HTMLElement,
    result: LilypondPreviewResult,
    options: { soundFontUrl: string; workletUrl: string },
  ): LilypondPreviewPlayback;
}

export interface LilypondPreviewHostOptions {
  getStatus: () => Promise<LilypondAddonStatus | null>;
  loadModule: (url: string) => Promise<LilypondPreviewModule>;
  generate: (text: string, sourcePath: string | null) => Promise<LilypondPreviewResult>;
  cancelGeneration: () => void | Promise<void>;
  confirmExecution: () => Promise<boolean>;
  reportError: (error: unknown) => void;
}

export interface LilypondPreviewHost {
  setSource(text: string, sourcePath: string | null): Promise<void>;
  dispose(): void;
}

interface SourceSnapshot {
  text: string;
  sourcePath: string | null;
}

interface HostElements {
  root: HTMLElement;
  updateButton: HTMLButtonElement;
  tuneSelect: HTMLSelectElement;
  playButton: HTMLButtonElement;
  stopButton: HTMLButtonElement;
  status: HTMLElement;
  score: HTMLElement;
}

const ENTRY_ORIGIN = "http://wasabi-addin.localhost";
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NOT_INSTALLED_MESSAGE = "LilyPondアドイン未導入です。設定から追加してください。";
const DISABLED_MESSAGE = "LilyPondアドインは無効です。設定から有効にしてください。";

export function createLilypondPreviewHost(
  container: HTMLElement,
  options: LilypondPreviewHostOptions,
): LilypondPreviewHost {
  let generation = 0;
  let playbackGeneration = 0;
  let disposed = false;
  let executionConfirmed = false;
  let source: SourceSnapshot | null = null;
  let addonStatus: LilypondAddonStatus | null = null;
  let elements: HostElements | null = null;
  let activePreview: LilypondPreviewPlayback | null = null;
  let playbackEnabled = false;

  function reportError(error: unknown): void {
    try {
      options.reportError(error);
    } catch {
      // Error reporting must not interrupt cleanup or the visible status.
    }
  }

  function isCurrent(requestGeneration: number): boolean {
    return !disposed && generation === requestGeneration;
  }

  async function cancelGeneration(): Promise<void> {
    try {
      await options.cancelGeneration();
    } catch (error) {
      reportError(error);
    }
  }

  function ensureElements(): HostElements {
    if (elements) return elements;
    const document = container.ownerDocument;
    const root = document.createElement("section");
    root.className = "viewer-lilypond-preview";
    const toolbar = document.createElement("div");
    toolbar.className = "lilypond-preview-toolbar";

    const updateButton = document.createElement("button");
    updateButton.type = "button";
    updateButton.textContent = "譜面を更新";
    updateButton.disabled = true;
    const tuneLabel = document.createElement("label");
    tuneLabel.append(document.createTextNode("曲 "));
    const tuneSelect = document.createElement("select");
    tuneSelect.setAttribute("aria-label", "LilyPondの曲");
    tuneSelect.disabled = true;
    tuneLabel.append(tuneSelect);

    const playButton = document.createElement("button");
    playButton.type = "button";
    playButton.dataset.action = "play";
    playButton.textContent = "再生";
    playButton.disabled = true;
    const stopButton = document.createElement("button");
    stopButton.type = "button";
    stopButton.textContent = "停止";
    stopButton.disabled = true;
    toolbar.append(updateButton, tuneLabel, playButton, stopButton);

    const status = document.createElement("p");
    status.className = "lilypond-preview-host-status";
    status.setAttribute("role", "status");
    const score = document.createElement("div");
    score.className = "lilypond-preview-host-score";
    root.append(toolbar, status, score);
    container.replaceChildren(root);

    elements = { root, updateButton, tuneSelect, playButton, stopButton, status, score };
    updateButton.addEventListener("click", () => {
      void updateScore();
    });
    playButton.addEventListener("click", startPlayback);
    stopButton.addEventListener("click", stopPlayback);
    return elements;
  }

  function setStatus(message: string): void {
    if (elements) elements.status.textContent = message;
  }

  function stopPlayback(): void {
    playbackGeneration += 1;
    const preview = activePreview;
    if (preview) {
      try {
        preview.stop();
      } catch (error) {
        reportError(error);
        setStatus("再生を停止できませんでした。");
      }
    }
    if (elements) {
      elements.stopButton.disabled = true;
      elements.playButton.disabled = !playbackEnabled;
      if (playbackEnabled) setStatus("停止しました。");
    }
  }

  function stopForSourceChange(): void {
    playbackEnabled = false;
    stopPlayback();
    if (elements) {
      elements.playButton.disabled = true;
      elements.tuneSelect.disabled = true;
    }
  }

  function enableUpdateButton(): void {
    if (elements) elements.updateButton.disabled = false;
  }

  function describeStatus(status: LilypondAddonStatus | null): string | null {
    if (status === null) return NOT_INSTALLED_MESSAGE;
    if (!status.enabled) return DISABLED_MESSAGE;
    if (typeof status.version !== "string" || !SAFE_VERSION.test(status.version)) {
      return "LilyPondアドインの版情報が不正です。";
    }
    return null;
  }

  function setUnavailableMessage(message: string): void {
    addonStatus = null;
    if (elements) elements.updateButton.disabled = true;
    const stalePrefix = activePreview ? "未更新です。" : "";
    setStatus(stalePrefix + message);
  }

  function errorDetail(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function updateScore(): Promise<void> {
    return runUpdate();
  }

  async function runUpdate(): Promise<void> {
    if (disposed || !source || !elements) return;
    const requestGeneration = ++generation;
    stopForSourceChange();
    elements.updateButton.disabled = true;
    elements.stopButton.disabled = true;
    setStatus(activePreview ? "未更新です。譜面を更新しています。" : "譜面を更新しています。");

    await cancelGeneration();
    if (!isCurrent(requestGeneration)) return;

    let status: LilypondAddonStatus | null;
    try {
      status = await options.getStatus();
    } catch (error) {
      if (isCurrent(requestGeneration)) {
        enableUpdateButton();
        setStatus(`状態を確認できませんでした。${errorDetail(error)}`);
        reportError(error);
      }
      return;
    }
    if (!isCurrent(requestGeneration)) return;
    const unavailableMessage = describeStatus(status);
    if (unavailableMessage) {
      setUnavailableMessage(unavailableMessage);
      return;
    }
    addonStatus = status;

    if (!executionConfirmed) {
      let confirmed: boolean;
      try {
        confirmed = await options.confirmExecution();
      } catch (error) {
        if (isCurrent(requestGeneration)) {
          enableUpdateButton();
          setStatus(`実行確認を完了できませんでした。${errorDetail(error)}`);
          reportError(error);
        }
        return;
      }
      if (!isCurrent(requestGeneration)) return;
      if (!confirmed) {
        enableUpdateButton();
        setStatus("譜面の更新を中止しました。");
        return;
      }
      executionConfirmed = true;
    }

    let result: LilypondPreviewResult;
    try {
      result = await options.generate(source.text, source.sourcePath);
    } catch (error) {
      if (isCurrent(requestGeneration)) {
        enableUpdateButton();
        setStatus(activePreview
          ? `更新失敗・前回結果: ${errorDetail(error)}`
          : `更新に失敗しました: ${errorDetail(error)}`);
        reportError(error);
      }
      return;
    }
    if (!isCurrent(requestGeneration)) return;
    if (!Array.isArray(result?.svgPages) || !Array.isArray(result?.midiFiles)) {
      const error = new TypeError("LilyPond生成結果の形式が不正です。");
      enableUpdateButton();
      setStatus(activePreview
        ? `更新失敗・前回結果: ${error.message}`
        : `更新に失敗しました: ${error.message}`);
      reportError(error);
      return;
    }

    const currentStatus = addonStatus;
    if (!currentStatus) return;
    const baseUrl = `${ENTRY_ORIGIN}/lilypond/${currentStatus.version}`;
    let module: LilypondPreviewModule;
    try {
      module = await options.loadModule(`${baseUrl}/dist/entry.js`);
    } catch (error) {
      if (isCurrent(requestGeneration)) {
        enableUpdateButton();
        setStatus(activePreview
          ? `更新失敗・前回結果: ${errorDetail(error)}`
          : `プレビューを読み込めませんでした: ${errorDetail(error)}`);
        reportError(error);
      }
      return;
    }
    if (!isCurrent(requestGeneration)) return;

    const nextScore = container.ownerDocument.createElement("div");
    nextScore.className = "lilypond-preview-host-score";
    let nextPreview: LilypondPreviewPlayback;
    try {
      nextPreview = module.createLilypondPreview(nextScore, result, {
        soundFontUrl: `${baseUrl}/soundfont/FluidR3Mono_GM.sf3`,
        workletUrl: `${baseUrl}/dist/spessasynth_processor.min.js`,
      });
      if (!Array.isArray(nextPreview.tunes) || nextPreview.tunes.some((tune) => typeof tune.title !== "string")) {
        throw new TypeError("LilyPondアドインが不正な曲一覧を返しました。");
      }
    } catch (error) {
      enableUpdateButton();
      setStatus(activePreview
        ? `更新失敗・前回結果: ${errorDetail(error)}`
        : `プレビューを作成できませんでした: ${errorDetail(error)}`);
      reportError(error);
      return;
    }

    const previousPreview = activePreview;
    elements.score.replaceWith(nextScore);
    elements.score = nextScore;
    activePreview = nextPreview;
    playbackEnabled = nextPreview.tunes.length > 0;
    elements.tuneSelect.replaceChildren(...nextPreview.tunes.map((tune, index) => {
      const option = container.ownerDocument.createElement("option");
      option.value = String(index);
      option.textContent = tune.title;
      return option;
    }));
    elements.tuneSelect.disabled = nextPreview.tunes.length < 2;
    elements.playButton.disabled = !playbackEnabled;
    elements.stopButton.disabled = true;
    enableUpdateButton();
    setStatus(playbackEnabled
      ? "譜面を更新しました。"
      : "譜面を更新しました。MIDIがありません。再生するには楽譜に \\midi {} を追加してください。");
    if (previousPreview) disposePreview(previousPreview);
  }

  function disposePreview(preview: LilypondPreviewPlayback): void {
    let failed = false;
    let cleanupError: unknown;
    try {
      preview.stop();
    } catch (error) {
      failed = true;
      cleanupError = error;
    }
    try {
      preview.dispose();
    } catch (error) {
      if (!failed) cleanupError = error;
      failed = true;
    }
    if (failed) reportError(cleanupError);
  }

  function startPlayback(): void {
    if (disposed || !playbackEnabled || !activePreview || !elements) return;
    const preview = activePreview;
    const requestGeneration = ++playbackGeneration;
    const tuneIndex = Number(elements.tuneSelect.value);
    elements.stopButton.disabled = false;
    setStatus("再生を準備しています。");
    let playback: Promise<void>;
    try {
      playback = preview.play(tuneIndex);
    } catch (error) {
      elements.stopButton.disabled = true;
      setStatus(`再生できませんでした: ${errorDetail(error)}`);
      reportError(error);
      return;
    }
    void playback.then(() => {
      if (disposed || activePreview !== preview || playbackGeneration !== requestGeneration) return;
      setStatus("再生中です。");
    }).catch((error: unknown) => {
      if (disposed || activePreview !== preview || playbackGeneration !== requestGeneration) return;
      elements!.stopButton.disabled = true;
      setStatus(`再生できませんでした: ${errorDetail(error)}`);
      reportError(error);
    });
  }

  return {
    async setSource(text: string, sourcePath: string | null): Promise<void> {
      if (disposed) return;
      if (activePreview && source?.text === text && source.sourcePath === sourcePath) return;
      const requestGeneration = ++generation;
      source = { text, sourcePath };
      const ui = ensureElements();
      stopForSourceChange();
      ui.updateButton.disabled = true;
      setStatus(activePreview ? "未更新です。" : "LilyPondアドインの状態を確認しています。");
      await cancelGeneration();
      if (!isCurrent(requestGeneration)) return;

      let status: LilypondAddonStatus | null;
      try {
        status = await options.getStatus();
      } catch (error) {
        if (isCurrent(requestGeneration)) {
          setStatus(`状態を確認できませんでした。${errorDetail(error)}`);
          reportError(error);
        }
        return;
      }
      if (!isCurrent(requestGeneration)) return;
      addonStatus = status;
      const unavailableMessage = describeStatus(status);
      if (unavailableMessage) {
        setUnavailableMessage(unavailableMessage);
        return;
      }
      ui.updateButton.disabled = false;
      const relativeReferenceHint = sourcePath === null
        ? " 相対参照を使う場合は先に保存してください。"
        : "";
      setStatus(activePreview
        ? `未更新です。前回の譜面を保持しています。${relativeReferenceHint}`
        : `譜面を更新するには「譜面を更新」を選択してください。${relativeReferenceHint}`);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      generation += 1;
      playbackGeneration += 1;
      void cancelGeneration();
      if (activePreview) {
        disposePreview(activePreview);
        activePreview = null;
      }
      playbackEnabled = false;
      container.replaceChildren();
    },
  };
}
