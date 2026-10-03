import { readFile, writeFile, mkdir, mkdtemp, readdir, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, basename, resolve } from "node:path";
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

function player(data, tracks) {
  const select = document.getElementById("tune");
  const audio = document.getElementById("audio");
  const play = document.getElementById("play");
  const stop = document.getElementById("stop");
  const status = document.getElementById("status");
  let generation = 0;
  let frame;
  let running = false;
  let visibleSystem;
  const cursor = document.createElement("div");
  cursor.id = "playback-cursor";
  cursor.setAttribute("aria-hidden", "true");
  cursor.hidden = true;
  document.getElementById("score").append(cursor);
  function hideCursor() {
    running = false;
    window.cancelAnimationFrame?.(frame);
    cursor.hidden = true;
    visibleSystem = undefined;
  }
  function updateCursor() {
    if (!running) return;
    const track = tracks[Number(select.value)];
    if (!track?.events.length || audio.currentTime >= track.duration) { cursor.hidden = true; return; }
    const events = track.events;
    let low = 0;
    let high = events.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (events[middle].time <= audio.currentTime) low = middle + 1;
      else high = middle;
    }
    if (!low) { cursor.hidden = true; return; }
    const event = events[low - 1];
    const nextTime = events[low]?.time ?? track.duration;
    const progress = Math.max(0, Math.min(1, (audio.currentTime - event.time) / (nextTime - event.time || 1)));
    const target = event.target ?? track.target;
    target.append(cursor);
    cursor.style.left = `${100 * (event.x + Math.max(0, event.endX - event.x) * progress)}%`;
    cursor.style.top = `${100 * event.y}%`;
    cursor.style.height = `${100 * event.height}%`;
    cursor.hidden = false;
    if (visibleSystem !== `${Number(select.value)}:${event.system}`) {
      visibleSystem = `${Number(select.value)}:${event.system}`;
      const rect = cursor.getBoundingClientRect();
      const controls = document.getElementById("controls").getBoundingClientRect();
      if (rect.height > 0 && (rect.top < controls.bottom || rect.bottom > window.innerHeight)) {
        cursor.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
  }
  function tick() {
    updateCursor();
    if (running) frame = window.requestAnimationFrame?.(tick);
  }
  function reset() {
    generation += 1;
    hideCursor();
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
      const track = tracks[Number(select.value)];
      if (!track?.events.length) status.textContent += `（再生位置表示不可: ${track?.reason || "譜面との位置対応がありません。"}）`;
      running = true;
      tick();
    } catch (error) {
      if (generation === request) { hideCursor(); status.textContent = `再生不可: ${error.message}`; }
    }
  });
  audio.addEventListener("timeupdate", updateCursor);
  audio.addEventListener("error", () => { reset(); status.textContent = "再生不可: 音声ファイルを読み込めません。"; });
  audio.addEventListener("ended", () => { reset(); status.textContent = "再生終了"; });
  window.addEventListener("pagehide", reset);
  choose();
}

function jsonForScript(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function lilyTracks(data) {
  const positions = new Map();
  const scores = new Set();
  let invalidGeometry = false;
  function point(node, x = 0, y = 0) {
    for (let parent = node; parent; parent = parent.parentElement) {
      const transform = parent.getAttribute("transform") || "";
      const operations = [...transform.matchAll(/(translate|scale|matrix)\s*\(([^)]*)\)/g)];
      if (transform.replace(/(translate|scale|matrix)\s*\(([^)]*)\)/g, "").trim()) throw new Error("unsupported transform");
      for (const operation of operations.reverse()) {
        const values = operation[2].trim().split(/[\s,]+/).map(Number);
        if (operation[1] === "translate") { x += values[0]; y += values[1] || 0; }
        else if (operation[1] === "scale") { x *= values[0]; y *= values[1] ?? values[0]; }
        else { const [a, b, c, d, e, f] = values; [x, y] = [a * x + c * y + e, b * x + d * y + f]; }
      }
    }
    return { x, y };
  }
  for (const target of document.querySelectorAll(".lily-page")) {
    try {
      const image = target.querySelector("img");
      const xml = new TextDecoder().decode(Uint8Array.from(atob(image.src.split(",")[1]), (c) => c.charCodeAt(0)));
      const svg = new DOMParser().parseFromString(xml, "image/svg+xml").documentElement;
      const [left, top, width, height] = svg.getAttribute("viewBox").trim().split(/\s+/).map(Number);
      const intrinsic = svg.getAttribute("width");
      if (intrinsic?.endsWith("mm")) target.style.maxWidth = `${parseFloat(intrinsic) * 96 / 25.4}px`;
      for (const note of svg.querySelectorAll("[data-wp-score][data-wp-note]")) {
        scores.add(note.getAttribute("data-wp-score"));
        const key = `${note.getAttribute("data-wp-score")}:${note.getAttribute("data-wp-note")}`;
        const geometry = note.querySelector("[transform]") ?? note;
        const origin = point(geometry);
        const upper = point(geometry, 0, Number(note.getAttribute("data-wp-top")));
        const lower = point(geometry, 0, Number(note.getAttribute("data-wp-top")) + Number(note.getAttribute("data-wp-height")));
        const right = point(geometry, Number(note.getAttribute("data-wp-right")));
        const position = { target, x: (origin.x - left) / width, y: (upper.y - top) / height,
          height: (lower.y - upper.y) / height, endX: (right.x - left) / width,
          system: note.getAttribute("data-wp-system"), moment: Number(note.getAttribute("data-wp-moment")) };
        if (![position.x, position.y, position.height, position.endX].every(Number.isFinite) || position.height <= 0) throw new Error("invalid position");
        if (!positions.has(key)) positions.set(key, []);
        positions.get(key).push(position);
      }
    } catch { invalidGeometry = true; }
  }
  return data.tunes.map((tune) => {
    const cursor = tune.cursor;
    const unavailable = (reason) => ({ events: [], reason });
    if (!cursor?.events.length) return unavailable(cursor?.reason || "位置対応を取得できません。");
    if (invalidGeometry) return unavailable("譜面の座標を読み取れません。");
    const events = [];
    for (const event of cursor.events) {
      if (!scores.has(event.key.split(":")[0])) return unavailable("MIDI用 score に対応する記譜用 score を特定できません。");
      const candidates = positions.get(event.key) || [];
      const matched = candidates.length === 1 ? candidates : candidates.filter((position) => Math.abs(position.moment - event.moment) < 0.000001);
      if (matched.length !== 1) return unavailable("譜面上の位置を一意に対応付けできません。");
      events.push({ ...matched[0], time: event.time });
    }
    events.sort((a, b) => a.time - b.time || a.x - b.x);
    const moments = events.filter((event, index) => !index || event.time !== events[index - 1].time);
    for (let index = 0; index < moments.length; index += 1) {
      const event = moments[index];
      const next = moments[index + 1];
      if (next?.system === event.system && next.x > event.x) event.endX = next.x;
      else if (next?.system === event.system) event.endX = event.x;
    }
    return { events: moments, duration: cursor.duration };
  });
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
  let cursorRecords = [];
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
    const cursorFile = join(directory, "cursor.jsonl");
    const cursorInclude = join(dirname(fileURLToPath(import.meta.url)), "cursor.ily");
    // Loaded before the source so explicit paper/header settings remain authoritative.
    await writeFile(settings, "\\paper { ragged-bottom = ##t ragged-last-bottom = ##t top-margin = 2\\mm bottom-margin = 2\\mm indent = 0\\mm print-page-number = ##f }\n\\header { tagline = ##f }\n\\layout { \\context { \\Staff \\override InstrumentName.self-alignment-X = #RIGHT \\override InstrumentName.padding = #1.5 } \\context { \\StaffGroup \\override InstrumentName.self-alignment-X = #RIGHT \\override InstrumentName.padding = #1.5 } }\n" +
      `#(define wp-cursor-file ${JSON.stringify(cursorFile.replaceAll("\\", "/"))})\n\\include ${JSON.stringify(cursorInclude.replaceAll("\\", "/"))}\n`, "utf8");
    const result = spawnSync(values.lilypond || "lilypond", [
      "--svg", "-dno-point-and-click", "-dno-use-paper-size-for-page", `-dinclude-settings=${settings.replaceAll("\\", "/")}`,
      "-I", `${dirname(values.input).replaceAll("\\", "/")}/`, "-o", join(directory, "score"), values.input,
    ], { stdio: "inherit", windowsHide: true, shell: false });
    if (result.error) throw new Error(`LilyPond を起動できません: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`LilyPond の変換に失敗しました (${result.status ?? result.signal})。`);
    try {
      cursorRecords = (await readFile(cursorFile, "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    } catch { cursorRecords = []; }
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
        score += `<div class="lily-page"><img alt="ページ ${file.replaceAll('"', "&quot;")}" src="data:image/svg+xml;base64,${content}"></div>`;
      } else if ([".midi", ".mid"].includes(extname(file))) {
        const bytes = await readFile(path);
        const midi = BasicMIDI.fromArrayBuffer(bufferOf(bytes));
        const identity = cursorRecords.filter((record) => record[0] === "file" && resolve(directory, record[2]) === path);
        const records = identity.length === 1 ? cursorRecords.filter((record) => record[0] === "event" && record[1] === identity[0][1]) : [];
        const events = records.map((record) => ({ key: `${record[1]}:${record[2]}`, moment: record[3], time: midi.midiTicksToSeconds(record[3] * 4 * midi.timeDivision) }));
        const reason = !records.length ? "曲の位置対応を取得できません。" : records.some((record) => record[4] !== 0) ? "装飾音の時刻対応を確定できません。" : "";
        data.tunes.push({ title: basename(file, extname(file)), bytes, cursor: { events: reason ? [] : events, duration: midi.duration, reason } });
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
<title>音楽プレビュー</title><style>body{font-family:system-ui,sans-serif;margin:8px;background:#fff;color:#222}#controls{position:sticky;top:0;z-index:2;background:#fff;padding:4px 0}select,button{font:inherit;margin-right:8px}#score svg{width:100%;height:100%}#score img{width:100%;height:auto;display:block}.lily-page{position:relative;max-width:100%}#score>div{margin-bottom:8px}#status{min-height:1.5em;margin:4px 0}#playback-cursor{position:absolute;width:2px;background:#d71920;z-index:1;pointer-events:none;transform:translateX(-1px)}</style>
<div id="controls"><label>曲 <select id="tune"></select></label><button id="play" type="button">再生</button><button id="stop" type="button">停止</button><audio id="audio" preload="none"></audio><p id="status" role="status"></p></div>
<main id="score">${score}</main><script>${abcScript.replace(/<\/script/gi, "<\\/script")}</script><script>
const data = ${jsonForScript(data)};
const tracks = ${abcText === undefined ? `(${lilyTracks.toString()})(data)` : `MusicAbc.render(document.getElementById("score"),${jsonForScript(abcText)})`};
(${player.toString()})(data, tracks);</script></html>`;
  await writeFile(values.output, html, "utf8");
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
