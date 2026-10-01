import { readFile, writeFile, mkdir, mkdtemp, readdir, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, basename } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ABCJS from "abcjs";
import { hasPlayableNotes } from "./abc.ts";
import { audioToWav, BasicMIDI, SoundBankLoader, SpessaLog, SpessaSynthProcessor, SpessaSynthSequencer } from "spessasynth_core";

function bufferOf(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function renderWave(bytes, soundBank, output) {
  const midi = BasicMIDI.fromArrayBuffer(bufferOf(bytes));
  const sampleRate = 22050;
  const synth = new SpessaSynthProcessor(sampleRate, { eventsEnabled: false });
  synth.soundBankManager.addSoundBank(soundBank, "music-preview");
  await synth.processorInitialized;
  synth.setSystemParameter("autoAllocateVoices", true);
  const sequencer = new SpessaSynthSequencer(synth);
  sequencer.loadNewSongList([midi]);
  sequencer.play();
  const sampleCount = Math.ceil(sampleRate * (midi.duration + 2));
  const left = new Float32Array(sampleCount);
  const right = new Float32Array(sampleCount);
  for (let offset = 0; offset < sampleCount; offset += 128) {
    sequencer.processTick();
    synth.process(left, right, offset, Math.min(128, sampleCount - offset));
  }
  await writeFile(output, new Uint8Array(audioToWav([left, right], sampleRate)));
}

function player(data) {
  const select = document.getElementById("tune");
  const audio = document.getElementById("audio");
  const play = document.getElementById("play");
  const stop = document.getElementById("stop");
  const status = document.getElementById("status");
  let generation = 0;
  function reset() {
    generation += 1;
    audio.pause();
    audio.currentTime = 0;
  }
  function choose() {
    reset();
    const tune = data.tunes[Number(select.value)];
    if (tune?.audio) audio.setAttribute("src", tune.audio);
    else audio.removeAttribute("src");
    play.disabled = !tune?.audio;
    stop.disabled = !tune?.audio;
    status.textContent = tune?.error ? `再生不可: ${tune.error}` : data.message || "";
  }
  for (const [index, tune] of data.tunes.entries()) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = tune.title;
    select.append(option);
  }
  select.disabled = data.tunes.length === 0;
  select.addEventListener("change", choose);
  stop.addEventListener("click", () => { reset(); status.textContent = "停止"; });
  play.addEventListener("click", async () => {
    reset();
    const request = generation;
    try {
      await audio.play();
      if (generation !== request) return;
      status.textContent = "再生中";
    } catch (error) {
      if (generation === request) status.textContent = `再生不可: ${error.message}`;
    }
  });
  audio.addEventListener("error", () => { status.textContent = "再生不可: 音声ファイルを読み込めません。"; });
  audio.addEventListener("ended", () => { status.textContent = "再生終了"; });
  window.addEventListener("pagehide", reset);
  choose();
}

function jsonForScript(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

async function main() {
  const { values } = parseArgs({ options: {
    input: { type: "string" }, output: { type: "string" },
    soundfont: { type: "string" }, lilypond: { type: "string" },
  } });
  for (const key of ["input", "output"]) {
    if (!values[key] || !isAbsolute(values[key])) throw new Error(`--${key} に絶対パスを指定してください。`);
  }
  if (values.soundfont && !isAbsolute(values.soundfont)) throw new Error("--soundfont にローカル音源の絶対パスを指定してください。");
  // LilyPond does not accept the extended Windows paths returned by the runner.
  if (process.platform === "win32") {
    for (const key of Object.keys(values)) {
      values[key] = values[key].replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
    }
  }
  const extension = extname(values.input).toLowerCase();
  if (![".abc", ".ly", ".ily"].includes(extension)) throw new Error("入力は ABC または LilyPond ファイルにしてください。");
  SpessaLog.setLogLevel(false, false, false);
  const outputDirectory = dirname(values.output);
  await mkdir(outputDirectory, { recursive: true });
  const data = { tunes: [], message: "" };
  let score = "";
  let abcText;
  if (extension === ".abc") {
    abcText = await readFile(values.input, "utf8");
    const book = new ABCJS.TuneBook(abcText);
    const parsed = ABCJS.parseOnly(abcText);
    const valid = abcText.trim() && parsed.length > 0 && parsed.every(hasPlayableNotes);
    for (const [index, tune] of (valid ? book.tunes : []).entries()) {
      try {
        const bytes = ABCJS.synth.getMidiFile(abcText, { midiOutputType: "binary", startingTune: index })[0];
        data.tunes.push({ title: tune.title?.trim() || `曲${index + 1}`, bytes });
      } catch (error) {
        data.tunes.push({ title: tune.title?.trim() || `曲${index + 1}`, error: error.message });
      }
    }
    if (!data.tunes.length) data.message = abcText.trim() ? "ABC形式を読み取れません。" : "譜面データがありません。";
  } else {
    const directory = await mkdtemp(join(outputDirectory, "lilypond-"));
    const settings = join(directory, "preview-settings.ly");
    // Loaded before the source so explicit paper/header settings remain authoritative.
    await writeFile(settings, "\\paper { ragged-bottom = ##t ragged-last-bottom = ##t top-margin = 2\\mm bottom-margin = 2\\mm indent = 0\\mm print-page-number = ##f }\n\\header { tagline = ##f }\n\\layout { \\context { \\Staff \\override InstrumentName.self-alignment-X = #RIGHT \\override InstrumentName.padding = #1.5 } \\context { \\StaffGroup \\override InstrumentName.self-alignment-X = #RIGHT \\override InstrumentName.padding = #1.5 } }\n", "utf8");
    const result = spawnSync(values.lilypond || "lilypond", [
      "--svg", "-dno-point-and-click", "-dno-use-paper-size-for-page", `-dinclude-settings=${settings.replaceAll("\\", "/")}`,
      "-I", `${dirname(values.input).replaceAll("\\", "/")}/`, "-o", join(directory, "score"), values.input,
    ], { stdio: "inherit", windowsHide: true, shell: false });
    if (result.error) throw new Error(`LilyPond を起動できません: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`LilyPond の変換に失敗しました (${result.status ?? result.signal})。`);
    const files = await Promise.all((await readdir(directory)).map(async (name) => ({ name, metadata: await stat(join(directory, name), { bigint: true }) })));
    // ponytail: coarse file timestamps can tie; use an output manifest if strict source order becomes necessary.
    files.sort((a, b) => {
      const time = a.metadata.birthtimeNs - b.metadata.birthtimeNs || a.metadata.mtimeNs - b.metadata.mtimeNs;
      return time < 0n ? -1 : time > 0n ? 1 : a.name.localeCompare(b.name, "en", { numeric: true });
    });
    for (const { name: file } of files) {
      const path = join(directory, file);
      if (extname(file) === ".svg") {
        const content = (await readFile(path)).toString("base64");
        score += `<img alt="ページ ${file.replaceAll('"', "&quot;")}" src="data:image/svg+xml;base64,${content}">`;
      } else if ([".midi", ".mid"].includes(extname(file))) {
        data.tunes.push({ title: basename(file, extname(file)), bytes: await readFile(path) });
      }
    }
    if (!score) throw new Error("LilyPond が譜面の SVG を生成しませんでした。\\layout {} を確認してください。");
    if (!data.tunes.length) data.message = "再生不可: MIDI がありません。譜面の score 内に \\midi {} を追加し、更新してください。";
  }
  let soundBank;
  let soundError;
  if (data.tunes.length) {
    try {
      if (!values.soundfont) throw new Error("--soundfont に SF2/SF3 音源を指定してください。");
      soundBank = SoundBankLoader.fromArrayBuffer(bufferOf(await readFile(values.soundfont)));
    } catch (error) {
      soundError = `音源を読み込めません: ${error.message}`;
    }
  }
  for (const [index, tune] of data.tunes.entries()) {
    try {
      if (tune.error) continue;
      if (soundError) throw new Error(soundError);
      const file = `music-${index + 1}.wav`;
      await renderWave(tune.bytes, soundBank, join(outputDirectory, file));
      tune.audio = file;
    } catch (error) {
      tune.error = error.message;
    } finally {
      delete tune.bytes;
    }
  }
  const abcScript = abcText === undefined ? "" : await readFile(join(dirname(fileURLToPath(import.meta.url)), "abc.js"), "utf8");
  const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src 'self' file: http://asset.localhost https://asset.localhost">
<title>音楽プレビュー</title><style>body{font-family:system-ui,sans-serif;margin:8px;background:#fff;color:#222}#controls{position:sticky;top:0;z-index:1;background:#fff;padding:4px 0}select,button{font:inherit;margin-right:8px}#score svg{width:100%;height:100%}#score img{max-width:100%;height:auto;display:block;margin:8px auto}#score>div{margin-bottom:8px}#status{min-height:1.5em;margin:4px 0}</style>
<div id="controls"><label>曲 <select id="tune"></select></label><button id="play" type="button">再生</button><button id="stop" type="button">停止</button><audio id="audio" preload="none"></audio><p id="status" role="status"></p></div>
<main id="score">${score}</main><script>${abcScript.replace(/<\/script/gi, "<\\/script")}</script><script>
${abcText === undefined ? "" : `MusicAbc.render(document.getElementById("score"),${jsonForScript(abcText)});`}
(${player.toString()})(${jsonForScript(data)});</script></html>`;
  await writeFile(values.output, html, "utf8");
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
