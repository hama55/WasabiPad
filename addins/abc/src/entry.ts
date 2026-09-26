import * as ABCJS from "abcjs";

export interface AbcPreviewOptions {
  soundFontUrl: string;
}

export interface AbcPreviewTune {
  title: string;
}

export interface AbcPreview {
  tunes: AbcPreviewTune[];
  play(index: number): Promise<void>;
  stop(): void;
  dispose(): void;
}

const EMPTY_MESSAGE = "譜面データがありません。";
const INVALID_MESSAGE = "ABC形式を読み取れません。";
const PLAYBACK_ERROR_MESSAGE = "再生を開始できませんでした。音源ファイルを確認してください。";

function localSoundFontUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("soundFontUrl must be a local wasabi-addin URL.");
  }

  const segments = url.pathname.split("/");
  const version = segments[2] ?? "";
  const safeVersion = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  const subpathSegments = segments.slice(3);
  if (subpathSegments.at(-1) === "") subpathSegments.pop();
  const safeSubpath = subpathSegments.every((segment) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment));

  if (
    url.origin !== "http://wasabi-addin.localhost" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    segments[0] !== "" ||
    segments[1] !== "abc" ||
    !safeVersion.test(version) ||
    !safeSubpath ||
    value.includes("%")
  ) {
    throw new TypeError("soundFontUrl must point to local ABC add-in assets.");
  }

  return `${url.origin}${url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`}`;
}

function hasPlayableNotes(tune: ABCJS.TuneObject): boolean {
  return tune.lines.some((line) =>
    line.staff?.some((staff) =>
      staff.voices?.some((voice) =>
        voice.some((item) => item.el_type === "note" && (item.pitches?.length ?? 0) > 0),
      ),
    ),
  );
}

function safeStop(synth: ABCJS.MidiBuffer | undefined): void {
  try {
    synth?.stop();
  } catch {
    // Audio may not have been initialized yet.
  }
}

function setStatus(container: HTMLElement, message: string): void {
  let status = container.querySelector<HTMLElement>("[data-abc-preview-status]");
  if (!status) {
    status = container.ownerDocument.createElement("p");
    status.dataset.abcPreviewStatus = "true";
    status.setAttribute("role", "status");
    container.appendChild(status);
  }
  status.textContent = message;
}

function clearStatus(container: HTMLElement): void {
  container.querySelector("[data-abc-preview-status]")?.remove();
}

export function createAbcPreview(
  container: HTMLElement,
  abcText: string,
  options: AbcPreviewOptions,
): AbcPreview {
  const soundFontUrl = localSoundFontUrl(options.soundFontUrl);
  let currentSynth: ABCJS.MidiBuffer | undefined;
  let generation = 0;
  let disposed = false;
  const visualObjects: ABCJS.TuneObject[] = [];

  container.replaceChildren();

  if (abcText.trim().length === 0) {
    setStatus(container, EMPTY_MESSAGE);
  } else {
    try {
      const tuneCount = ABCJS.numberOfTunes(abcText);
      for (let index = 0; index < tuneCount; index += 1) {
        const tuneContainer = container.ownerDocument.createElement("div");
        const rendered = ABCJS.renderAbc(tuneContainer, abcText, { startingTune: index });
        const visualObj = rendered?.[0];
        if (!visualObj || !hasPlayableNotes(visualObj)) {
          throw new Error("No playable music was parsed.");
        }
        visualObjects.push(visualObj);
        container.appendChild(tuneContainer);
      }
      if (visualObjects.length === 0) {
        throw new Error("No tune was parsed.");
      }
    } catch {
      visualObjects.length = 0;
      container.replaceChildren();
      setStatus(container, INVALID_MESSAGE);
    }
  }

  const tunes = visualObjects.map((tune, index) => ({
    title: tune.metaText.title?.trim() || `曲${index + 1}`,
  }));

  const stop = (): void => {
    generation += 1;
    safeStop(currentSynth);
    currentSynth = undefined;
  };

  return {
    tunes,
    async play(index: number): Promise<void> {
      if (disposed) {
        throw new Error("ABC preview has been disposed.");
      }
      if (!Number.isInteger(index) || index < 0 || index >= visualObjects.length) {
        throw new RangeError("The requested ABC tune is unavailable.");
      }

      stop();
      const requestGeneration = generation;
      const synth = new ABCJS.synth.CreateSynth();
      currentSynth = synth;
      clearStatus(container);

      try {
        await synth.init({
          visualObj: visualObjects[index],
          options: { soundFontUrl },
        });
        if (disposed || requestGeneration !== generation) {
          safeStop(synth);
          return;
        }

        await synth.prime();
        if (disposed || requestGeneration !== generation) {
          safeStop(synth);
          return;
        }

        synth.start();
      } catch (error) {
        safeStop(synth);
        if (disposed || requestGeneration !== generation) {
          return;
        }
        currentSynth = undefined;
        setStatus(container, PLAYBACK_ERROR_MESSAGE);
        throw error;
      }
    },
    stop,
    dispose(): void {
      disposed = true;
      stop();
    },
  };
}
