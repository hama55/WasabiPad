// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addSoundBank: vi.fn(),
  ready: Promise.resolve(),
  stopAll: vi.fn(),
  destroy: vi.fn(),
  loadNewSongList: vi.fn(),
  pause: vi.fn(),
  play: vi.fn(),
}));

vi.mock("spessasynth_lib", () => ({
  WorkletSynthesizer: class {
    soundBankManager = { addSoundBank: mocks.addSoundBank };
    get isReady() { return mocks.ready; }
    stopAll = mocks.stopAll;
    destroy = mocks.destroy;
  },
  Sequencer: class {
    loadNewSongList = mocks.loadNewSongList;
    pause = mocks.pause;
    play = mocks.play;
  },
}));

import { createLilypondPreview } from "./entry";

describe("Feature: LilyPondプレビューアドイン", () => {
  let objectUrlIndex: number;
  let audioContexts: Array<{ close: ReturnType<typeof vi.fn> }>;

  beforeEach(() => {
    objectUrlIndex = 0;
    audioContexts = [];
    mocks.addSoundBank.mockReset().mockResolvedValue(undefined);
    mocks.ready = Promise.resolve();
    mocks.stopAll.mockReset();
    mocks.destroy.mockReset();
    mocks.loadNewSongList.mockReset();
    mocks.pause.mockReset();
    mocks.play.mockReset();

    class TestURL extends URL {
      static createObjectURL = vi.fn(() => `blob:lilypond-${++objectUrlIndex}`);
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", TestURL);
    vi.stubGlobal("AudioContext", class {
      state = "suspended";
      audioWorklet = { addModule: vi.fn(async () => {}) };
      resume = vi.fn(async () => {});
      close = vi.fn(async () => {});
      constructor() { audioContexts.push(this); }
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    })));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("Scenario: 複数ページを順番に安全な画像URLで表示する", async () => {
    // Given: SVG形式の全ページが渡される
    const container = document.createElement("div");
    const pages = [
      { fileName: "score-1.svg", content: '<svg xmlns="http://www.w3.org/2000/svg"><text>一頁</text></svg>' },
      { fileName: "score-2.svg", content: '<svg xmlns="http://www.w3.org/2000/svg"><text>二頁</text></svg>' },
    ];

    // When: プレビューを作る
    const preview = createLilypondPreview(container, { svgPages: pages, midiFiles: [] }, {
      soundFontUrl: "http://wasabi-addin.localhost/lilypond/1.0.0/soundfont/piano.sf2",
      workletUrl: "http://wasabi-addin.localhost/lilypond/1.0.0/dist/spessasynth_processor.min.js",
    });

    // Then: 全ページを順番にblob画像として表示し、MIDIがなければ再生案内を出す
    const images = [...container.querySelectorAll("img")];
    expect(images).toHaveLength(2);
    expect(images.map((image) => image.alt)).toEqual(["score-1.svg", "score-2.svg"]);
    expect(images.map((image) => image.getAttribute("src"))).toEqual(["blob:lilypond-1", "blob:lilypond-2"]);
    expect(container.textContent).toContain("譜面のみ表示しています");
    expect(container.textContent).toContain("\\midi {}");
    expect(preview.tunes).toEqual([]);
    await expect(preview.play(0)).rejects.toThrow("MIDI");
    preview.dispose();
  });

  it("Scenario: ネットワーク上の音源URLを受け付けない", () => {
    // Given: 公式アドイン外の音源URL
    const container = document.createElement("div");

    // When: そのURLでプレビューを作ろうとする
    expect(() => createLilypondPreview(container, { svgPages: [], midiFiles: [] }, {
      soundFontUrl: "https://example.invalid/piano.sf2",
      workletUrl: "http://wasabi-addin.localhost/lilypond/1.0.0/dist/processor.js",
    })).toThrow("ローカルのLilyPondアドインURL");

    // Then: 外部音源を取得せず、拒否される
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Scenario: MIDI曲を選んで先頭から再生し停止できる", async () => {
    // Given: 二曲分のMIDIとローカル音源、ローカルworkletがある
    const container = document.createElement("div");
    const midiFiles = [
      { displayName: "第一曲", bytes: [77, 84, 104, 100] },
      { displayName: "第二曲", bytes: [77, 84, 104, 100, 0] },
    ];
    const preview = createLilypondPreview(container, { svgPages: [], midiFiles }, {
      soundFontUrl: "http://wasabi-addin.localhost/lilypond/1.0.0/soundfont/piano.sf2",
      workletUrl: "http://wasabi-addin.localhost/lilypond/1.0.0/dist/spessasynth_processor.min.js",
    });

    // When: 二曲目を再生し、停止する
    await preview.play(1);
    preview.stop();

    // Then: ローカル資産を読み、選択した曲を読み込んで再生・停止する
    expect(preview.tunes).toEqual([{ title: "第一曲" }, { title: "第二曲" }]);
    expect(fetch).toHaveBeenCalledWith(
      "http://wasabi-addin.localhost/lilypond/1.0.0/soundfont/piano.sf2",
      expect.any(Object),
    );
    expect(mocks.loadNewSongList).toHaveBeenCalledWith([
      { binary: new Uint8Array(midiFiles[1].bytes).buffer, fileName: "第二曲" },
    ]);
    expect(mocks.play).toHaveBeenCalledOnce();
    expect(mocks.pause).toHaveBeenCalledOnce();
    expect(mocks.stopAll).toHaveBeenCalledWith(true);
  });

  it("Scenario: 停止後の再生は閉じた音声コンテキストを再利用しない", async () => {
    // Given: MIDI曲を持つプレビュー
    const preview = createLilypondPreview(document.createElement("div"), {
      svgPages: [], midiFiles: [{ displayName: "曲", bytes: [77, 84, 104, 100] }],
    }, {
      soundFontUrl: "http://wasabi-addin.localhost/lilypond/1.0.0/soundfont/piano.sf2",
      workletUrl: "http://wasabi-addin.localhost/lilypond/1.0.0/dist/spessasynth_processor.min.js",
    });

    // When: 再生を停止してから同じ曲を再生する
    await preview.play(0);
    preview.stop();
    await preview.play(0);

    // Then: 停止時に音声コンテキストを閉じ、再生時には新しいものを作る
    expect(audioContexts).toHaveLength(2);
    expect(audioContexts[0].close).toHaveBeenCalledOnce();
    preview.dispose();
    expect(audioContexts[1].close).toHaveBeenCalledOnce();
  });

  it("Scenario: 破棄すると再生を停止し音源とblob URLを解放する", async () => {
    // Given: ページとMIDIを持つプレビュー
    const container = document.createElement("div");
    const preview = createLilypondPreview(container, {
      svgPages: [{ fileName: "page.svg", content: "<svg xmlns=\"http://www.w3.org/2000/svg\"/>" }],
      midiFiles: [{ displayName: "曲", bytes: [77, 84, 104, 100] }],
    }, {
      soundFontUrl: "http://wasabi-addin.localhost/lilypond/1.0.0/soundfont/piano.sf2",
      workletUrl: "http://wasabi-addin.localhost/lilypond/1.0.0/dist/spessasynth_processor.min.js",
    });
    await preview.play(0);

    // When: プレビューを破棄する
    preview.dispose();

    // Then: 再生と音源を解放し、ページ用URLをrevokeする
    expect(mocks.pause).toHaveBeenCalledOnce();
    expect(mocks.stopAll).toHaveBeenCalledWith(true);
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(audioContexts[0].close).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:lilypond-1");
  });

  it("Scenario: 初期化中に停止した古い再生は後から発音しない", async () => {
    // Given: 音源読み込みが遅れている
    const container = document.createElement("div");
    const preview = createLilypondPreview(container, {
      svgPages: [],
      midiFiles: [{ displayName: "曲", bytes: [77, 84, 104, 100] }],
    }, {
      soundFontUrl: "http://wasabi-addin.localhost/lilypond/1.0.0/soundfont/piano.sf2",
      workletUrl: "http://wasabi-addin.localhost/lilypond/1.0.0/dist/spessasynth_processor.min.js",
    });
    let resolveSoundBank!: () => void;
    mocks.addSoundBank.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveSoundBank = resolve;
    }));

    // When: 音源待ちの間に停止し、その後読み込みが完了する
    const pendingPlay = preview.play(0);
    await vi.waitFor(() => expect(mocks.addSoundBank).toHaveBeenCalledOnce());
    preview.stop();
    resolveSoundBank();
    await pendingPlay;

    // Then: 古い初期化は破棄され、再生を開始しない
    expect(mocks.play).not.toHaveBeenCalled();
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it.todo("Scenario: 実機WebViewでユーザー操作から音が鳴り、停止で無音になる");
});
