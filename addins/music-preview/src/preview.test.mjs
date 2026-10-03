import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { BasicSoundBank } from "spessasynth_core";

const root = fileURLToPath(new URL("../", import.meta.url));
const abc = "X:1\nT:第一曲\nM:4/4\nL:1/4\nK:C\nC D E F|\nX:2\nT:第二曲\nM:3/4\nL:1/4\nK:G\nG A B|";
const directories = [];

beforeAll(() => {
  const result = spawnSync(process.execPath, [join(root, "build.mjs")], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}, 30000);
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace() {
  const path = await mkdtemp(join(tmpdir(), "wasabipad 音楽 preview "));
  directories.push(path);
  return path;
}

function run(args) {
  return spawnSync(process.execPath, [join(root, "dist", "preview.mjs"), ...args], { encoding: "utf8" });
}

describe("Feature: 音楽外部プレビューのCLI", () => {
  it.skipIf(!process.env.WASABIPAD_TEST_LILYPOND)("Scenario: カーソル注入で複数声部の五線・段・記号の配置とMIDIを変更しない", async () => {
    // Given: 加線・和音・タイ・三連符・複数声部と改ページを持つ上下の五線譜
    const path = await workspace();
    const input = join(path, "geometry.ly");
    const output = join(path, "index.html");
    const source = String.raw`\version "2.26.0"
\layout { \context { \Voice
  \override NoteHead.after-line-breaking = #(lambda (grob) (ly:grob-set-property! grob 'details '((ready . #t))))
  \override NoteHead.output-attributes = #(lambda (grob) (list (cons 'data-custom (if (assq-ref (ly:grob-property grob 'details) 'ready) "ready" "early"))))
  \override Rest.output-attributes = #'((data-custom . "rest"))
} }
upper = { << { <c''' e''' g'''>4~ <c''' e''' g'''>4 \tuplet 3/2 { c''8 d'' e'' } r4 } \\ { c'2 g'2 } >> }
lower = { \clef bass <c, e, g,>2 <g, b, d>2 }
\score { \new PianoStaff << \new Staff { \upper \break \upper \pageBreak \upper \break \upper } \new Staff { \lower \lower \lower \lower } >> \layout {} \midi {} }`;
    await writeFile(input, source);
    // When: 公開CLIと同じ紙面設定のカーソルなし対照を生成する
    const result = run(["--input", input, "--output", output, "--lilypond", process.env.WASABIPAD_TEST_LILYPOND]);
    expect(result.status, result.stderr).toBe(0);
    const directory = join(path, (await readdir(path)).find((name) => name.startsWith("lilypond-")));
    const settings = (await readFile(join(directory, "preview-settings.ly"), "utf8")).split("#(define wp-cursor-file")[0];
    const control = join(path, "control.ly");
    await writeFile(control, settings);
    const baseline = spawnSync(process.env.WASABIPAD_TEST_LILYPOND, ["--svg", "-dno-point-and-click", "-dno-use-paper-size-for-page", `-dinclude-settings=${control.replaceAll("\\", "/")}`, "-o", join(path, "control"), input], { encoding: "utf8" });
    expect(baseline.status, baseline.stderr).toBe(0);
    const geometry = (text) => {
      const dom = new JSDOM(text, { contentType: "image/svg+xml" });
      const document = dom.window.document;
      for (const node of document.querySelectorAll("[data-wp-note]")) {
        for (const attribute of [...node.attributes]) if (attribute.name.startsWith("data-wp-")) node.removeAttribute(attribute.name);
        if (node.tagName === "g" && !node.attributes.length) node.replaceWith(...node.childNodes);
      }
      const value = document.documentElement.outerHTML.replace(/>\s+</g, "><");
      dom.window.close();
      return value;
    };
    // Then: 全ページの描画形状・座標が対照と一致し、カーソル属性と演奏内容を保持する
    for (const page of [1, 2]) {
      const annotated = await readFile(join(directory, `score-${page}.svg`), "utf8");
      expect(annotated).toContain("data-wp-note");
      // Then: 原稿側のafter-line-breakingと属性list/callbackも通常の順序で保持する
      expect(annotated).toContain('data-custom="ready"');
      expect(annotated).toContain('data-custom="rest"');
      expect(annotated).not.toContain('data-custom="early"');
      expect(geometry(annotated)).toBe(geometry(await readFile(join(path, `control-${page}.svg`), "utf8")));
    }
    expect(await readFile(join(directory, "score.mid"))).toEqual(await readFile(join(path, "control.mid")));
    expect(await readFile(input, "utf8")).toBe(source);
  }, 30000);

  it.skipIf(!process.env.WASABIPAD_TEST_LILYPOND)("Scenario: 記譜用とMIDI用scoreが別の場合は対応を推測せず音声を再生する", async () => {
    // Given: 同じ原稿を再利用する記譜専用scoreとMIDI専用score
    const path = await workspace();
    const input = join(path, "separate.ly");
    const output = join(path, "index.html");
    const font = join(path, "sample.sf2");
    const source = String.raw`\version "2.26.0"
notes = { c'4 d' e' f' \pageBreak g' a' b' c'' }
\score { \notes \layout {} }
\score { \unfoldRepeats \notes \midi {} }`;
    await writeFile(input, source);
    await writeFile(font, new Uint8Array(BasicSoundBank.getSampleSoundBankFile()));
    const result = run(["--input", input, "--output", output, "--soundfont", font, "--lilypond", process.env.WASABIPAD_TEST_LILYPOND]);
    expect(result.status, result.stderr).toBe(0);
    const dom = new JSDOM(await readFile(output, "utf8"), { runScripts: "dangerously", beforeParse(window) {
      window.TextDecoder = TextDecoder;
      window.HTMLMediaElement.prototype.pause = () => {};
      window.HTMLMediaElement.prototype.play = async () => {};
    } });
    const document = dom.window.document;
    // When: 生成HTMLで再生を開始する
    expect(document.querySelectorAll("#score img")).toHaveLength(2);
    expect(document.getElementById("play").disabled).toBe(false);
    document.getElementById("play").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Then: 音声再生を維持し、別scoreの位置を特定できない理由を表示する
    expect(document.getElementById("status").textContent).toContain("再生中");
    expect(document.getElementById("status").textContent).toContain("MIDI用 score に対応する記譜用 score を特定できません。");
    expect(document.getElementById("playback-cursor").hidden).toBe(true);
    expect(await readFile(input, "utf8")).toBe(source);
    dom.window.close();
  }, 30000);

  it("Scenario: 音源不足でも空白・日本語パスのABC全曲をオフライン表示する", async () => {
    // Given: 二曲のABCと、存在しないローカル音源
    const path = await workspace();
    const input = join(path, "入力 譜面.abc");
    const output = join(path, "出力.html");
    await writeFile(input, abc);
    // When: 公開CLIからHTMLを生成する
    const result = run(["--input", input, "--output", output, "--soundfont", join(path, "missing.sf2")]);
    expect(result.status, result.stderr).toBe(0);
    const html = await readFile(output, "utf8");
    const dom = new JSDOM(html, { runScripts: "dangerously", beforeParse(window) { window.HTMLMediaElement.prototype.pause = () => {}; } });
    // Then: 全曲が描画され、音源不足を案内し、外部資産を参照しない
    expect(dom.window.document.querySelectorAll("#score svg")).toHaveLength(2);
    // Then: 幅を縮めても全体を縮尺表示できる座標系と縦横比を持つ
    for (const svg of dom.window.document.querySelectorAll("#score svg")) {
      const bounds = svg.getAttribute("viewBox")?.split(" ").map(Number);
      expect(bounds?.slice(0, 2)).toEqual([0, 0]);
      expect(bounds?.[2]).toBeGreaterThan(0);
      expect(bounds?.[3]).toBeGreaterThan(0);
      expect(svg.getAttribute("preserveAspectRatio")).toBe("xMinYMin meet");
      // Then: 短い譜表でも曲名が右へ離れず、左端に揃う
      const title = [...svg.querySelectorAll("text")].find((text) => /第[一二]曲/.test(text.textContent));
      expect(title?.getAttribute("text-anchor")).toBe("start");
      expect(Number(title?.getAttribute("x"))).toBeLessThan(10);
    }
    expect(dom.window.document.querySelector("#tune").textContent).toContain("第二曲");
    expect(dom.window.document.querySelector("#status").textContent).toContain("再生不可");
    expect(dom.window.document.querySelectorAll("script[src], link[href], audio[src]")).toHaveLength(0);
    dom.window.close();
  });

  it("Scenario: ローカル音源から全曲の実音声を生成し、選択・再生・停止できる", async () => {
    // Given: 二曲のABCと既存ライブラリのサンプル音源
    const path = await workspace();
    const input = join(path, "譜面.abc");
    const output = join(path, "index.html");
    const font = join(path, "sample.sf2");
    await writeFile(input, abc);
    await writeFile(font, new Uint8Array(BasicSoundBank.getSampleSoundBankFile()));
    // When: 公開CLIで音声付きプレビューを生成する
    const result = run(["--input", input, "--output", output, "--soundfont", font]);
    expect(result.status, result.stderr).toBe(0);
    for (const name of ["music-1.wav", "music-2.wav"]) {
      const wave = await readFile(join(path, name));
      // Then: 再生可能なPCM WAVに無音ではないサンプルが含まれる
      expect(wave.subarray(0, 4).toString()).toBe("RIFF");
      expect(wave.subarray(8, 12).toString()).toBe("WAVE");
      expect(wave.subarray(44).some((value) => value !== 0)).toBe(true);
    }
    const play = vi.fn(async () => {});
    const pause = vi.fn();
    const dom = new JSDOM(await readFile(output, "utf8"), { runScripts: "dangerously", beforeParse(window) {
      window.HTMLMediaElement.prototype.play = play;
      window.HTMLMediaElement.prototype.pause = pause;
    } });
    const document = dom.window.document;
    const select = document.getElementById("tune");
    select.value = "1";
    select.dispatchEvent(new dom.window.Event("change"));
    expect(document.getElementById("audio").getAttribute("src")).toBe("music-2.wav");
    document.getElementById("play").click();
    await Promise.resolve();
    expect(play).toHaveBeenCalledOnce();
    document.getElementById("stop").click();
    expect(pause).toHaveBeenCalled();
    expect(document.getElementById("audio").currentTime).toBe(0);
    expect(document.getElementById("status").textContent).toBe("停止");
    // Scenario: 再生時刻に合わせて赤線を動かし、停止・終了・曲変更で消す
    // Given: 選択曲と、制御可能な再生時刻
    Object.defineProperty(document.getElementById("audio"), "currentTime", { value: 0, writable: true });
    // When: 再生を開始する
    document.getElementById("play").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cursor = document.getElementById("playback-cursor");
    // Then: 選択曲上に赤線を表示する
    expect(cursor).not.toBeNull();
    expect(cursor.hidden, document.getElementById("status").textContent).toBe(false);
    const firstPosition = cursor.style.left;
    document.getElementById("audio").currentTime = 0.25;
    document.getElementById("audio").dispatchEvent(new dom.window.Event("timeupdate"));
    expect(cursor.style.left).not.toBe(firstPosition);
    document.getElementById("stop").click();
    expect(cursor.hidden).toBe(true);
    document.getElementById("play").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.getElementById("audio").dispatchEvent(new dom.window.Event("ended"));
    expect(cursor.hidden).toBe(true);
    document.getElementById("play").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    select.value = "0";
    select.dispatchEvent(new dom.window.Event("change"));
    expect(cursor.hidden).toBe(true);
    // Scenario: 再生失敗と音声エラーでは赤線を残さない
    // Given/When: 再生が拒否される、または再生中に音声エラーが届く
    play.mockRejectedValueOnce(new Error("blocked"));
    document.getElementById("play").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cursor.hidden).toBe(true);
    document.getElementById("play").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.getElementById("audio").dispatchEvent(new dom.window.Event("error"));
    // Then: 位置表示を停止し、以後の時刻更新でも再表示しない
    document.getElementById("audio").dispatchEvent(new dom.window.Event("timeupdate"));
    expect(cursor.hidden).toBe(true);
    dom.window.close();
  });

  it("Scenario: ABCの繰り返しでは同じ段の演奏位置へ戻る", async () => {
    // Given: 同じ段の途中に繰り返し終止を持つABC
    const path = await workspace();
    const input = join(path, "repeat.abc");
    const output = join(path, "index.html");
    const font = join(path, "sample.sf2");
    await writeFile(input, "X:1\nM:2/4\nL:1/4\nQ:1/4=120\nK:C\n|: C D :| E F |]");
    await writeFile(font, new Uint8Array(BasicSoundBank.getSampleSoundBankFile()));
    const result = run(["--input", input, "--output", output, "--soundfont", font]);
    expect(result.status, result.stderr).toBe(0);
    const dom = new JSDOM(await readFile(output, "utf8"), { runScripts: "dangerously", beforeParse(window) {
      window.HTMLMediaElement.prototype.pause = () => {};
      window.HTMLMediaElement.prototype.play = async () => {};
    } });
    const document = dom.window.document;
    document.getElementById("play").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cursor = document.getElementById("playback-cursor");
    const audio = document.getElementById("audio");
    // When: 繰り返し直前と戻った直後の再生時刻を反映する
    audio.currentTime = 0.9;
    audio.dispatchEvent(new dom.window.Event("timeupdate"));
    const before = parseFloat(cursor.style.left);
    audio.currentTime = 1.01;
    audio.dispatchEvent(new dom.window.Event("timeupdate"));
    // Then: 同じ五線譜上の前方へ戻り、将来の小節を横切らない
    expect(cursor.hidden).toBe(false);
    expect(parseFloat(cursor.style.left)).toBeLessThan(before);
    dom.window.close();
  });

  it.skipIf(!process.env.WASABIPAD_TEST_LILYPOND)("Scenario: LilyPondの複数五線譜と展開された反復を表示し、装飾音の位置不明時も再生できる", async () => {
    // Given: 上下の五線譜と展開反復・テンポ変更を持つ譜面
    const path = await workspace();
    const input = join(path, "cursor.ly");
    const output = join(path, "index.html");
    const font = join(path, "sample.sf2");
    await writeFile(font, new Uint8Array(BasicSoundBank.getSampleSoundBankFile()));
    const sources = [
      '\\version "2.26.0"\n\\score { \\new PianoStaff << \\new Staff { \\repeat unfold 2 { c\'4 d\' } \\tempo 4 = 60 e\'4 f\' } \\new Staff { c2 d e } >> \\layout {} \\midi { \\tempo 4 = 120 } }',
      '\\version "2.26.0"\n\\score { { \\grace { c\'16 } d\'4 e\' f\' g\' } \\layout {} \\midi { \\tempo 4 = 120 } }',
    ];
    for (const [index, source] of sources.entries()) {
      await writeFile(input, source);
      const result = run(["--input", input, "--output", output, "--soundfont", font, "--lilypond", process.env.WASABIPAD_TEST_LILYPOND]);
      expect(result.status, result.stderr).toBe(0);
      const dom = new JSDOM(await readFile(output, "utf8"), { runScripts: "dangerously", beforeParse(window) {
        window.TextDecoder = TextDecoder;
        window.HTMLMediaElement.prototype.pause = () => {};
        window.HTMLMediaElement.prototype.play = async () => {};
      } });
      const document = dom.window.document;
      // When: 公開HTMLから再生する
      expect(document.getElementById("play").disabled).toBe(false);
      document.getElementById("play").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const cursor = document.getElementById("playback-cursor");
      if (!index) {
        // Then: 反復で複数の描画位置があっても正しい位置を決め、上下の譜表を貫く
        expect(cursor.hidden, document.getElementById("status").textContent).toBe(false);
        expect(parseFloat(cursor.style.height)).toBeGreaterThan(50);
        document.getElementById("audio").currentTime = 1.1;
        document.getElementById("audio").dispatchEvent(new dom.window.Event("timeupdate"));
        expect(cursor.hidden).toBe(false);
      } else {
        // Then: 位置対応不明でも再生を維持し、赤線を出さず理由を説明する
        expect(cursor.hidden).toBe(true);
        expect(document.getElementById("status").textContent).toContain("再生中");
        expect(document.getElementById("status").textContent).toContain("装飾音");
      }
      expect(await readFile(input, "utf8")).toBe(source);
      dom.window.close();
    }
  }, 30000);

  it.each([["", "譜面データがありません。"], ["12345", "ABC形式を読み取れません。"]])(
    "Scenario: 空・不正ABCの状態を区別して再生を無効にする (%j)", async (source, message) => {
      // Given: 空入力または譜面ではない入力と、有効な音源
      const path = await workspace();
      const input = join(path, "invalid.abc");
      const output = join(path, "index.html");
      const font = join(path, "sample.sf2");
      await writeFile(input, source);
      await writeFile(font, new Uint8Array(BasicSoundBank.getSampleSoundBankFile()));
      // When: 公開CLIの生成HTMLを開く
      const result = run(["--input", input, "--output", output, "--soundfont", font]);
      expect(result.status, result.stderr).toBe(0);
      const dom = new JSDOM(await readFile(output, "utf8"), { runScripts: "dangerously", beforeParse(window) {
        window.HTMLMediaElement.prototype.pause = () => {};
      } });
      // Then: 入力状態を説明し、再生できる曲を作らない
      expect(dom.window.document.getElementById("score").textContent).toBe(message);
      expect(dom.window.document.getElementById("play").disabled).toBe(true);
      expect(dom.window.document.getElementById("tune").options).toHaveLength(0);
      dom.window.close();
    },
  );

  it("Scenario: LilyPond依存不足は変換失敗として既存ログへ返す", async () => {
    // Given: 実行ファイルが存在しないLilyPond設定
    const path = await workspace();
    const input = join(path, "input.ly");
    await writeFile(input, "\\score { { c'4 } \\layout {} }");
    // When: 公開CLIを実行する
    const result = run(["--input", input, "--output", join(path, "index.html"), "--lilypond", join(path, "missing.exe")]);
    // Then: 正常な譜面と扱わず、診断をstderrへ返す
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("LilyPond を起動できません");
  });

  it.skipIf(!process.env.WASABIPAD_TEST_LILYPOND)("Scenario: 実LilyPondの相対includeと複数ページ・曲を保持し、MIDIなしでも譜面を表示する", async () => {
    // Given: 保存済み相対include、二book・二曲のLilyPondとローカル音源
    const path = await workspace();
    const input = join(path, "入力 譜面.ly");
    const output = join(path, "index.html");
    const font = join(path, "sample.sf2");
    await writeFile(join(path, "notes.ily"), "notes = { c'4 d' e' f' \\pageBreak g' a' b' c'' }");
    const source = '\\version "2.26.0"\n\\include "notes.ily"\n\\book { \\score { \\notes \\layout {} \\midi { \\tempo 4 = 120 } } }\n\\book { \\score { \\notes \\layout {} \\midi { \\tempo 4 = 90 } } }';
    await writeFile(input, source);
    await writeFile(font, new Uint8Array(BasicSoundBank.getSampleSoundBankFile()));
    // When: 実CLIから変換・音声生成する
    const args = ["--input", toNamespacedPath(input), "--output", toNamespacedPath(output), "--soundfont", font, "--lilypond", process.env.WASABIPAD_TEST_LILYPOND];
    const result = run(args);
    expect(result.status, result.stderr).toBe(0);
    let dom = new JSDOM(await readFile(output, "utf8"), { runScripts: "dangerously", beforeParse(window) {
      window.TextDecoder = TextDecoder;
      window.HTMLMediaElement.prototype.play = async () => {};
      window.HTMLMediaElement.prototype.pause = () => {};
    } });
    // Then: 全四ページ・二曲が保持され、入力を自動変更しない
    expect([...dom.window.document.querySelectorAll("#score img")].map((page) => page.alt)).toEqual(["ページ score-1.svg", "ページ score-2.svg", "ページ score-1-1.svg", "ページ score-1-2.svg"]);
    expect([...dom.window.document.getElementById("tune").options].map((option) => option.textContent)).toEqual(["score", "score-1"]);
    expect(dom.window.document.getElementById("play").disabled).toBe(false);
    expect(await readFile(input, "utf8")).toBe(source);
    // Scenario: 同じ原稿を再利用した二曲も、曲・テンポ・改ページ先を取り違えない
    // When: 第一曲を再生し、第二ページへ進む
    const document = dom.window.document;
    const audio = document.getElementById("audio");
    document.getElementById("play").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cursor = document.getElementById("playback-cursor");
    expect(cursor.hidden, document.getElementById("status").textContent).toBe(false);
    expect(cursor.parentElement.querySelector("img").alt).toBe("ページ score-1.svg");
    expect(parseFloat(cursor.style.left)).toBeGreaterThan(0);
    expect(parseFloat(cursor.style.top)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(cursor.style.top) + parseFloat(cursor.style.height)).toBeLessThanOrEqual(100);
    audio.currentTime = 2.1;
    audio.dispatchEvent(new dom.window.Event("timeupdate"));
    expect(cursor.parentElement.querySelector("img").alt).toBe("ページ score-2.svg");
    // Then: 第二曲は独立したページへ移り、90 BPMでは2.1秒時点は第一ページに留まる
    document.getElementById("tune").value = "1";
    document.getElementById("tune").dispatchEvent(new dom.window.Event("change"));
    document.getElementById("play").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    audio.currentTime = 2.1;
    audio.dispatchEvent(new dom.window.Event("timeupdate"));
    expect(cursor.parentElement.querySelector("img").alt).toBe("ページ score-1-1.svg");
    audio.currentTime = 2.8;
    audio.dispatchEvent(new dom.window.Event("timeupdate"));
    expect(cursor.parentElement.querySelector("img").alt).toBe("ページ score-1-2.svg");
    dom.window.close();
    // Given/When: MIDI指定なしの別譜面を同じ公開CLIで変換する
    const noMidi = source.replace(/\\midi\s*\{[^}]*\}/g, "");
    await writeFile(input, noMidi);
    const next = run(args);
    expect(next.status, next.stderr).toBe(0);
    dom = new JSDOM(await readFile(output, "utf8"), { runScripts: "dangerously", beforeParse(window) {
      window.HTMLMediaElement.prototype.pause = () => {};
    } });
    // Then: 譜面を残し再生不可とmidi指定の案内を出す
    expect([...dom.window.document.querySelectorAll("#score img")].map((page) => page.alt)).toEqual(["ページ score-1.svg", "ページ score-2.svg", "ページ score-1-1.svg", "ページ score-1-2.svg"]);
    expect(dom.window.document.getElementById("play").disabled).toBe(true);
    expect(dom.window.document.getElementById("status").textContent).toContain("\\midi {}");
    expect(await readFile(input, "utf8")).toBe(noMidi);
    dom.window.close();
    // Given/When/Then: 構文エラーは成功扱いせず既存ログへ返す
    await writeFile(input, "\\score { invalidSyntax }");
    const failure = run(args);
    expect(failure.status).toBe(1);
    expect(failure.stderr).toContain("LilyPond の変換に失敗");
  }, 30000);

  it.skipIf(!process.env.WASABIPAD_TEST_LILYPOND)("Scenario: LilyPondの途中ページを引き伸ばさず、原稿の段間指定を優先する", async () => {
    // Given: タイトルと明示的改ページを持つ短い楽譜
    const path = await workspace();
    const input = join(path, "spacing.ly");
    const output = join(path, "index.html");
    const source = '\\version "2.26.0"\n\\header { title = "Compact" tagline = ##f }\n\\score { { c\'4 d\' e\' f\' \\pageBreak g\' a\' b\' c\'\' } \\layout {} }';
    const heights = async (text) => {
      await writeFile(input, text);
      // When: 公開CLIでSVGページを生成する
      const result = run(["--input", input, "--output", output, "--lilypond", process.env.WASABIPAD_TEST_LILYPOND]);
      expect(result.status, result.stderr).toBe(0);
      const dom = new JSDOM(await readFile(output, "utf8"));
      const pages = [...dom.window.document.querySelectorAll("#score img")].map((image) => {
        const svg = new JSDOM(Buffer.from(image.src.split(",")[1], "base64").toString(), { contentType: "image/svg+xml" });
        const height = Number(svg.window.document.documentElement.getAttribute("viewBox").split(/\s+/)[3]);
        svg.window.close();
        return height;
      });
      dom.window.close();
      expect(await readFile(input, "utf8")).toBe(text);
      return pages;
    };
    // Then: 二ページを保持し、短い途中ページも用紙高まで伸ばさない
    const compact = await heights(source);
    expect(compact).toHaveLength(2);
    expect(compact[0]).toBeLessThan(80);
    // Given/When/Then: 明示的な段間の指定は表示用既定値より優先する
    const spaced = await heights('\\paper { markup-system-spacing.basic-distance = #80 }\n' + source);
    expect(spaced[0]).toBeGreaterThan(compact[0] + 30);
  }, 30000);

  it.skipIf(!process.env.WASABIPAD_TEST_LILYPOND)("Scenario: LilyPondの段の左端を揃え、ページ番号だけ省く", async () => {
    // Given: 小節番号と明示改ページを持つ短い譜面
    const path = await workspace();
    const input = join(path, "aligned.ly");
    const output = join(path, "index.html");
    const source = '\\version "2.26.0"\n\\score { { c\'4 d\' e\' f\' \\pageBreak g\' a\' b\' c\'\' } \\layout {} }';
    const pages = async (prefix = "", score = source) => {
      await writeFile(input, prefix + score);
      // When: 公開CLIで二ページを生成する
      const result = run(["--input", input, "--output", output, "--lilypond", process.env.WASABIPAD_TEST_LILYPOND]);
      expect(result.status, result.stderr).toBe(0);
      const dom = new JSDOM(await readFile(output, "utf8"));
      const resultPages = [...dom.window.document.querySelectorAll("#score img")].map((image) => {
        const svg = new JSDOM(Buffer.from(image.src.split(",")[1], "base64").toString(), { contentType: "image/svg+xml" });
        const document = svg.window.document;
        const line = [...document.querySelectorAll("line")].find((line) =>
          line.getAttribute("y1") === line.getAttribute("y2") && Number(line.getAttribute("x2")) - Number(line.getAttribute("x1")) > 40);
        let start = Number(line?.getAttribute("x1"));
        for (let node = line?.parentElement; node; node = node.parentElement) {
          const translate = node.getAttribute("transform")?.match(/translate\(\s*([-\d.]+)/);
          if (translate) start += Number(translate[1]);
        }
        const numbers = [...document.querySelectorAll("tspan")].filter((text) => text.textContent === "2").length;
        const name = [...document.querySelectorAll("tspan")].find((text) => text.textContent === "Bass Clarinet");
        const nameX = Number(name?.parentElement?.parentElement?.getAttribute("transform")?.match(/translate\(\s*([-\d.]+)/)?.[1]);
        const left = Number(document.documentElement.getAttribute("viewBox").split(/\s+/)[0]);
        svg.window.close();
        return { start, numbers, nameX, left };
      });
      dom.window.close();
      expect(await readFile(input, "utf8")).toBe(prefix + score);
      return resultPages;
    };
    // Then: 左端が一致し、第二ページの小節番号2だけ残る
    const aligned = await pages();
    expect(aligned).toHaveLength(2);
    expect(aligned[0].start).toBeCloseTo(aligned[1].start, 2);
    expect(aligned[1].numbers).toBe(1);
    // Given/When/Then: 原稿が字下げとページ番号を指定した場合は優先する
    const explicit = await pages('\\paper { indent = 15\\mm print-page-number = ##t }\n');
    expect(explicit[0].start).toBeGreaterThan(explicit[1].start + 5);
    expect(explicit[1].numbers).toBe(2);
    // Scenario: 楽器名のための余白を確保し、原稿の配置指定を優先する
    // Given/When: 楽器名付きの譜面を既定配置と原稿指定で変換する
    const named = source.replace("\\score { {", '\\score { \\new Staff \\with { instrumentName = "Bass Clarinet" } {');
    const defaults = await pages("", named);
    const original = await pages('\\layout { \\context { \\Staff \\override InstrumentName.padding = #0.3 } }\n', named);
    // Then: 名前を切らずに余白を増やし、明示配置を上書きしない
    expect(defaults[0].nameX).toBeGreaterThanOrEqual(defaults[0].left);
    expect(defaults[0].nameX).toBeLessThan(original[0].nameX - 1);
  }, 30000);
});
