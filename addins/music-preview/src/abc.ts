import * as ABCJS from "abcjs";

export function hasPlayableNotes(tune: ABCJS.TuneObject): boolean {
  return tune.lines.some((line) => line.staff?.some((staff) =>
    staff.voices?.some((voice) => voice.some((item) =>
      item.el_type === "note" && (item.pitches?.length ?? 0) > 0))));
}

// Rendering from the pending ABC preview; playback belongs to the shared WAV player.
export function render(container: HTMLElement, text: string): void {
  container.replaceChildren();
  if (!text.trim()) {
    container.textContent = "譜面データがありません。";
    return;
  }
  try {
    const count = ABCJS.numberOfTunes(text);
    if (!count) throw new Error("No tunes");
    for (let index = 0; index < count; index += 1) {
      const page = container.ownerDocument.createElement("div");
      const tune = ABCJS.renderAbc(page, text, { startingTune: index })[0];
      if (!tune || !hasPlayableNotes(tune)) {
        throw new Error("No notes");
      }
      container.append(page);
    }
  } catch {
    container.replaceChildren();
    container.textContent = "ABC形式を読み取れません。";
  }
}
