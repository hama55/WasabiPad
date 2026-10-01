import * as ABCJS from "abcjs";

export function hasPlayableNotes(tune: ABCJS.TuneObject): boolean {
  return tune.lines.some((line) => line.staff?.some((staff) =>
    staff.voices?.some((voice) => voice.some((item) =>
      item.el_type === "note" && (item.pitches?.length ?? 0) > 0))));
}

// Rendering from the pending ABC preview; playback belongs to the shared WAV player.
export function render(container: HTMLElement, text: string) {
  const tracks: Array<{ target: HTMLElement; events: Array<{ time: number; x: number; endX: number; y: number; height: number; system: number }>; duration: number }> = [];
  container.replaceChildren();
  if (!text.trim()) {
    container.textContent = "譜面データがありません。";
    return tracks;
  }
  try {
    const count = ABCJS.numberOfTunes(text);
    if (!count) throw new Error("No tunes");
    for (let index = 0; index < count; index += 1) {
      const page = container.ownerDocument.createElement("div");
      const tune = ABCJS.renderAbc(page, text, {
        startingTune: index, responsive: "resize",
        afterParsing: (parsed) => { parsed.formatting.titleleft ??= true; },
        paddingtop: 4, paddingbottom: 4, paddingleft: 4, paddingright: 4,
      })[0];
      if (!tune || !hasPlayableNotes(tune)) {
        throw new Error("No notes");
      }
      container.append(page);
      const timing = new ABCJS.TimingCallbacks(tune, {});
      const viewBox = page.querySelector("svg")!.getAttribute("viewBox")!.split(/\s+/).map(Number);
      const events = timing.noteTimings.filter((event) => event.type === "event" && event.left != null).map((event) => ({
        time: event.milliseconds / 1000, x: event.left! / viewBox[2], endX: (event.endX ?? event.left!) / viewBox[2],
        y: event.top! / viewBox[3], height: event.height! / viewBox[3], system: event.line ?? 0,
      }));
      tracks.push({ target: page, events, duration: timing.noteTimings.at(-1)!.milliseconds / 1000 });
    }
  } catch {
    container.replaceChildren();
    container.textContent = "ABC形式を読み取れません。";
    tracks.length = 0;
  }
  return tracks;
}
