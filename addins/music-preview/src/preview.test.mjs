import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    dom.window.close();
  });

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
    const source = '\\version "2.26.0"\n\\include "notes.ily"\n\\book { \\score { \\notes \\layout {} \\midi {} } }\n\\book { \\score { \\notes \\layout {} \\midi {} } }';
    await writeFile(input, source);
    await writeFile(font, new Uint8Array(BasicSoundBank.getSampleSoundBankFile()));
    // When: 実CLIから変換・音声生成する
    const args = ["--input", toNamespacedPath(input), "--output", toNamespacedPath(output), "--soundfont", font, "--lilypond", process.env.WASABIPAD_TEST_LILYPOND];
    const result = run(args);
    expect(result.status, result.stderr).toBe(0);
    let dom = new JSDOM(await readFile(output, "utf8"), { runScripts: "dangerously", beforeParse(window) {
      window.HTMLMediaElement.prototype.pause = () => {};
    } });
    // Then: 全四ページ・二曲が保持され、入力を自動変更しない
    expect([...dom.window.document.querySelectorAll("#score img")].map((page) => page.alt)).toEqual(["ページ score-1.svg", "ページ score-2.svg", "ページ score-1-1.svg", "ページ score-1-2.svg"]);
    expect([...dom.window.document.getElementById("tune").options].map((option) => option.textContent)).toEqual(["score", "score-1"]);
    expect(dom.window.document.getElementById("play").disabled).toBe(false);
    expect(await readFile(input, "utf8")).toBe(source);
    dom.window.close();
    // Given/When: MIDI指定なしの別譜面を同じ公開CLIで変換する
    const noMidi = source.replaceAll("\\midi {}", "");
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
});
