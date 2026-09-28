// @vitest-environment jsdom
import * as ABCJS from "abcjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAbcPreview } from "./entry";

const soundFontUrl = "http://wasabi-addin.localhost/abc/1.0.0/soundfonts/";
const oneTune = "X:1\nT:Single Tune\nM:4/4\nL:1/4\nK:C\nC D E F|";

function fakeSynthConstructor(synth: object): typeof ABCJS.synth.CreateSynth {
  return class {
    constructor() {
      return synth as ABCJS.MidiBuffer;
    }
  } as unknown as typeof ABCJS.synth.CreateSynth;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Feature: ABC preview add-in", () => {
  it("Scenario: one valid tune is rendered and listed", () => {
    const container = document.createElement("div");
    const preview = createAbcPreview(container, oneTune, { soundFontUrl });

    expect(preview.tunes).toEqual([{ title: "Single Tune" }]);
    expect(container.querySelector("svg")).not.toBeNull();
    preview.dispose();
  });

  it("Scenario: every valid tune is rendered and listed", () => {
    const container = document.createElement("div");
    const abc = `${oneTune}\nX:2\nT:Second Tune\nM:3/4\nL:1/4\nK:G\nG A B|`;

    const preview = createAbcPreview(container, abc, { soundFontUrl });

    expect(preview.tunes).toEqual([{ title: "Single Tune" }, { title: "Second Tune" }]);
    expect(container.querySelectorAll("svg")).toHaveLength(2);
    preview.dispose();
  });

  it("Scenario: empty input is distinct from invalid ABC and neither can play", async () => {
    const emptyContainer = document.createElement("div");
    const emptyPreview = createAbcPreview(emptyContainer, " \n", { soundFontUrl });
    expect(emptyPreview.tunes).toEqual([]);
    expect(emptyContainer.textContent).toContain("譜面データがありません。");
    expect(emptyContainer.querySelector("svg")).toBeNull();
    await expect(emptyPreview.play(0)).rejects.toThrow(RangeError);

    const invalidContainer = document.createElement("div");
    const invalidPreview = createAbcPreview(invalidContainer, "12345", { soundFontUrl });
    expect(invalidPreview.tunes).toEqual([]);
    expect(invalidContainer.textContent).toContain("ABC形式を読み取れません。");
    expect(invalidContainer.querySelector("svg")).toBeNull();
    await expect(invalidPreview.play(0)).rejects.toThrow(RangeError);
  });

  it("Scenario: a remote sound font URL is rejected", () => {
    const container = document.createElement("div");
    expect(() =>
      createAbcPreview(container, oneTune, {
        soundFontUrl: "https://example.invalid/soundfonts/",
      }),
    ).toThrow(TypeError);
  });

  it("Scenario: playback starts the selected tune and stop halts it", async () => {
    const container = document.createElement("div");
    const synth = {
      init: vi.fn(async () => ({ status: "created" as const })),
      prime: vi.fn(async () => ({ status: "ready", duration: 1 })),
      start: vi.fn(),
      stop: vi.fn(() => 0),
    };
    const createSynth = vi
      .spyOn(ABCJS.synth, "CreateSynth")
      .mockImplementation(fakeSynthConstructor(synth));
    const abc = `${oneTune}\nX:2\nT:Second Tune\nM:3/4\nL:1/4\nK:G\nG A B|`;
    const preview = createAbcPreview(container, abc, { soundFontUrl });
    expect(createSynth).not.toHaveBeenCalled();

    await preview.play(1);

    expect(createSynth).toHaveBeenCalledOnce();
    expect(synth.init).toHaveBeenCalledWith(
      expect.objectContaining({
        visualObj: expect.objectContaining({ metaText: expect.objectContaining({ title: "Second Tune" }) }),
        options: { soundFontUrl },
      }),
    );
    expect(synth.start).toHaveBeenCalledOnce();
    preview.stop();
    expect(synth.stop).toHaveBeenCalledOnce();
  });

  it("Scenario: an older prime completion cannot start after a newer play request", async () => {
    let finishOldPrime: (() => void) | undefined;
    const oldSynth = {
      init: vi.fn(async () => ({ status: "created" as const })),
      prime: vi.fn(
        () =>
          new Promise<{ status: string; duration: number }>((resolve) => {
            finishOldPrime = () => resolve({ status: "ready", duration: 1 });
          }),
      ),
      start: vi.fn(),
      stop: vi.fn(() => 0),
    };
    const newSynth = {
      init: vi.fn(async () => ({ status: "created" as const })),
      prime: vi.fn(async () => ({ status: "ready", duration: 1 })),
      start: vi.fn(),
      stop: vi.fn(() => 0),
    };
    const createSynth = vi.spyOn(ABCJS.synth, "CreateSynth");
    createSynth
      .mockImplementationOnce(fakeSynthConstructor(oldSynth))
      .mockImplementationOnce(fakeSynthConstructor(newSynth));
    const container = document.createElement("div");
    const abc = `${oneTune}\nX:2\nT:Second Tune\nM:3/4\nL:1/4\nK:G\nG A B|`;
    const preview = createAbcPreview(container, abc, { soundFontUrl });

    const oldPlay = preview.play(0);
    await vi.waitFor(() => expect(oldSynth.prime).toHaveBeenCalledOnce());
    await preview.play(1);
    finishOldPrime?.();
    await oldPlay;

    expect(newSynth.start).toHaveBeenCalledOnce();
    expect(oldSynth.start).not.toHaveBeenCalled();
    expect(oldSynth.stop).toHaveBeenCalled();
  });

  it.todo("Scenario: local MP3 sound fonts play and stop in both Tauri preview WebViews with network disabled");
});
