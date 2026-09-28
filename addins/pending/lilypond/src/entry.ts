import { Sequencer, WorkletSynthesizer } from "spessasynth_lib";

export interface LilypondSvgPage {
  fileName: string;
  content: string;
}

export interface LilypondMidiFile {
  displayName: string;
  bytes: number[];
}

export interface LilypondPreviewInput {
  svgPages: LilypondSvgPage[];
  midiFiles: LilypondMidiFile[];
}

export interface LilypondPreviewOptions {
  soundFontUrl: string;
  workletUrl: string;
}

export interface LilypondTune {
  title: string;
}

export interface LilypondPreview {
  tunes: LilypondTune[];
  play(index: number): Promise<void>;
  stop(): void;
  dispose(): void;
}

interface PlaybackRuntime {
  context: AudioContext;
  synth?: WorkletSynthesizer;
  sequencer?: Sequencer;
  initializing: boolean;
  closed: boolean;
}

const ADDIN_ORIGIN = "http://wasabi-addin.localhost";

function requireLocalAssetUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label}はローカルのLilyPondアドインURLである必要があります。`);
  }

  if (
    url.origin !== ADDIN_ORIGIN ||
    !url.pathname.startsWith("/lilypond/") ||
    /%(?:2e|2f|5c)/i.test(url.pathname) ||
    url.pathname.includes("\\") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${label}はローカルのLilyPondアドインURLである必要があります。`);
  }

  return url.href;
}

function disposeRuntime(runtime: PlaybackRuntime): void {
  if (runtime.closed) return;
  runtime.closed = true;
  try {
    runtime.sequencer?.pause();
  } finally {
    try {
      runtime.synth?.stopAll(true);
    } finally {
      try {
        runtime.synth?.destroy();
      } finally {
        void runtime.context.close().catch(() => {});
      }
    }
  }
}

export function createLilypondPreview(
  container: HTMLElement,
  input: LilypondPreviewInput,
  options: LilypondPreviewOptions,
): LilypondPreview {
  const soundFontUrl = requireLocalAssetUrl(options.soundFontUrl, "音源URL");
  const workletUrl = requireLocalAssetUrl(options.workletUrl, "AudioWorklet URL");
  const blobUrls: string[] = [];
  let generation = 0;
  let runtime: PlaybackRuntime | undefined;
  let disposed = false;

  container.replaceChildren();
  const pagesElement = document.createElement("div");
  pagesElement.className = "lilypond-preview-pages";
  for (const page of input.svgPages) {
    const image = document.createElement("img");
    image.alt = page.fileName;
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    const pageUrl = URL.createObjectURL(new Blob([page.content], { type: "image/svg+xml" }));
    blobUrls.push(pageUrl);
    image.src = pageUrl;
    pagesElement.append(image);
  }
  container.append(pagesElement);

  const statusElement = document.createElement("p");
  statusElement.className = "lilypond-preview-status";
  statusElement.setAttribute("role", "status");
  if (input.midiFiles.length === 0) {
    statusElement.textContent = "譜面のみ表示しています。再生するにはLilyPondソースに \\midi {} を追加し、更新してください。";
  }
  container.append(statusElement);

  const tunes = input.midiFiles.map((midiFile) => ({ title: midiFile.displayName }));

  function stop(): void {
    generation += 1;
    const active = runtime;
    if (!active || active.closed) return;
    runtime = undefined;
    disposeRuntime(active);
  }

  async function play(index: number): Promise<void> {
    if (disposed) throw new Error("LilyPondプレビューは破棄済みです。");
    if (!Number.isInteger(index) || index < 0 || index >= input.midiFiles.length) {
      throw new Error("再生するMIDI曲がありません。");
    }

    const requestGeneration = ++generation;
    if (runtime) {
      disposeRuntime(runtime);
      runtime = undefined;
    }

    const context = new AudioContext();
    const active: PlaybackRuntime = { context, initializing: true, closed: false };
    runtime = active;
    statusElement.textContent = "";

    try {
      // Call resume synchronously from the user's playback gesture.
      const resume = context.resume();
      const moduleRegistration = context.audioWorklet.addModule(workletUrl);
      await Promise.all([resume, moduleRegistration]);
      if (!isCurrent(active, requestGeneration)) {
        return;
      }

      const response = await fetch(soundFontUrl, { cache: "no-store", credentials: "omit" });
      if (!response.ok) throw new Error(`音源を読み込めませんでした (${response.status})。`);
      const soundFont = await response.arrayBuffer();
      if (!isCurrent(active, requestGeneration)) {
        return;
      }

      const synth = new WorkletSynthesizer(context);
      active.synth = synth;
      await synth.soundBankManager.addSoundBank(soundFont, "lilypond-soundfont");
      if (!isCurrent(active, requestGeneration)) {
        return;
      }

      await synth.isReady;
      if (!isCurrent(active, requestGeneration)) {
        return;
      }

      const midi = input.midiFiles[index];
      const sequencer = new Sequencer(synth);
      active.sequencer = sequencer;
      sequencer.loadNewSongList([{
        binary: new Uint8Array(midi.bytes).buffer,
        fileName: midi.displayName,
      }]);
      sequencer.play();
      active.initializing = false;
    } catch (error) {
      const requestIsCurrent = !disposed && generation === requestGeneration && runtime === active;
      if (runtime === active) {
        runtime = undefined;
        disposeRuntime(active);
      }
      if (requestIsCurrent) {
        statusElement.textContent = error instanceof Error
          ? `再生できませんでした: ${error.message}`
          : "再生できませんでした。";
      }
      if (!requestIsCurrent) return;
      throw error;
    }
  }

  function isCurrent(active: PlaybackRuntime, requestGeneration: number): boolean {
    return !disposed && !active.closed && runtime === active && generation === requestGeneration;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    generation += 1;
    if (runtime) {
      disposeRuntime(runtime);
      runtime = undefined;
    }
    for (const blobUrl of blobUrls) URL.revokeObjectURL(blobUrl);
    blobUrls.length = 0;
    container.replaceChildren();
  }

  return { tunes, play, stop, dispose };
}
