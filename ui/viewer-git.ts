import type { GitHistory, GitChangedFile, GitFileDiff } from "./api";
import { GIT_PREVIEW_MIN_RATIO, GIT_PREVIEW_MAX_RATIO } from "./preview-layout";

export interface GitPreviewState {
  head: string | null;
  branch: string | null;
  count: number;
  expanded: string[];
  commit: string | null;
  file: string | null;
  historyScroll: number;
  diffScroll: number;
}

export interface GitPreviewTarget {
  path: string;
  documentPath: string;
  state: GitPreviewState | null;
  collapsed: boolean;
}

export function isGitPreviewState(value: unknown): value is GitPreviewState {
  if (!value || typeof value !== "object") return false;
  const state = value as GitPreviewState;
  const isNullableOid = (value: unknown) => value === null || typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
  return isNullableOid(state.head) && isNullableOid(state.commit) && (state.branch === null || typeof state.branch === "string")
    && (state.file === null || typeof state.file === "string")
    && Number.isInteger(state.count) && state.count >= 0
    && Array.isArray(state.expanded) && state.expanded.every(value => value !== null && isNullableOid(value))
    && Number.isFinite(state.historyScroll) && state.historyScroll >= 0
    && Number.isFinite(state.diffScroll) && state.diffScroll >= 0;
}

export interface GitPreviewPorts {
  history: (path: string, head: string | null, offset: number) => Promise<GitHistory>;
  files: (path: string, commit: string) => Promise<GitChangedFile[]>;
  diff: (path: string, commit: string, file: string) => Promise<GitFileDiff>;
  getRatio: () => number;
  saveRatio: (ratio: number) => void;
  onState: (state: GitPreviewState) => void;
}

export function createGitPreviewController(host: HTMLElement, summary: HTMLElement, path: string, ports: GitPreviewPorts, restored?: GitPreviewState | null) {
  const listeners = new AbortController();
  const root = document.createElement("section");
  root.className = "git-preview";
  const historyPane = document.createElement("div");
  historyPane.className = "git-history";
  const branch = document.createElement("strong");
  const tree = document.createElement("div");
  tree.className = "git-commits";
  tree.setAttribute("aria-label", "コミット履歴と変更ファイル");
  const more = document.createElement("button");
  more.type = "button";
  more.textContent = "さらに読み込む";
  more.dataset.action = "git-more";
  more.hidden = true;
  const error = document.createElement("p");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const separator = document.createElement("div");
  separator.className = "git-separator";
  separator.tabIndex = 0;
  separator.setAttribute("role", "separator");
  separator.setAttribute("aria-orientation", "horizontal");
  separator.setAttribute("aria-label", "Gitプレビュー上下の高さ");
  const diffPane = document.createElement("div");
  diffPane.className = "git-diff";
  diffPane.tabIndex = 0;
  diffPane.setAttribute("aria-label", "選択ファイルの差分");
  historyPane.append(branch, error, tree, more);
  root.append(historyPane, separator, diffPane);
  host.replaceChildren(root);
  let disposed = false;
  let visible = true;
  let generation = 0;
  let diffGeneration = 0;
  let history: GitHistory | null = null;
  let state: GitPreviewState = restored ?? { head: null, branch: null, count: 100, expanded: [], commit: null, file: null, historyScroll: 0, diffScroll: 0 };
  const fileCache = new Map<string, GitChangedFile[]>();

  function publish() {
    if (disposed) return;
    state = { ...state, expanded: Array.from(tree.querySelectorAll<HTMLDetailsElement>("details[data-commit]")).filter(item => item.open).map(item => item.dataset.commit!), historyScroll: historyPane.scrollTop, diffScroll: diffPane.scrollTop };
    ports.onState({ ...state, expanded: [...state.expanded] });
  }
  function showError(reason: unknown) {
    error.textContent = String(reason);
    error.hidden = false;
    summary.textContent = "Git履歴を読み込めません";
  }
  async function selectFile(commit: string, file: string) {
    const request = ++diffGeneration;
    state.commit = commit;
    state.file = file;
    state.diffScroll = 0;
    tree.querySelectorAll<HTMLButtonElement>("button[data-file]").forEach(button => {
      const selected = button.dataset.file === file && button.dataset.commit === commit;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    diffPane.textContent = "差分を読み込み中…";
    publish();
    try {
      const result = await ports.diff(path, commit, file);
      if (disposed || request !== diffGeneration) return;
      const title = document.createElement("h3");
      title.textContent = file;
      const pre = document.createElement("pre");
      if (result.binary) pre.textContent = "バイナリファイルが変更されています";
      else for (const line of result.text.split(/(?<=\n)/)) {
        const span = document.createElement("span");
        span.className = line.startsWith("+") && !line.startsWith("+++") ? "git-added" : line.startsWith("-") && !line.startsWith("---") ? "git-deleted" : line.startsWith("@@") ? "git-hunk" : "";
        span.textContent = line;
        pre.append(span);
      }
      diffPane.replaceChildren(title, pre);
      if (result.truncated) {
        const note = document.createElement("p");
        note.className = "git-truncated";
        note.textContent = "差分の一部を省略（上限: 1 MiB / 2万行）";
        diffPane.append(note);
      }
      summary.textContent = `${commit.slice(0, 8)} · ${file}`;
      diffPane.scrollTop = 0;
      publish();
    } catch (reason) {
      if (!disposed && request === diffGeneration) { diffPane.textContent = `差分を読み込めません: ${String(reason)}`; publish(); }
    }
  }
  async function populate(details: HTMLDetailsElement, commit: string, request: number) {
    const body = details.querySelector<HTMLDivElement>(".git-files")!;
    if (body.dataset.loaded) return;
    body.textContent = "変更ファイルを読み込み中…";
    try {
      let files = fileCache.get(commit);
      if (!files) { files = await ports.files(path, commit); fileCache.set(commit, files); }
      if (disposed || request !== generation || !details.isConnected && !root.contains(details)) return;
      body.replaceChildren();
      body.dataset.loaded = "1";
      if (files.length === 0) body.textContent = "変更ファイルなし";
      for (const file of files) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.file = file.path;
        button.dataset.commit = commit;
        button.textContent = `${file.status}  ${file.oldPath ? `${file.oldPath} → ` : ""}${file.path}`;
        button.setAttribute("aria-pressed", String(state.commit === commit && state.file === file.path));
        button.classList.toggle("selected", state.commit === commit && state.file === file.path);
        button.addEventListener("click", () => { if (!tree.hasAttribute("inert")) void selectFile(commit, file.path); }, { signal: listeners.signal });
        body.append(button);
      }
    } catch (reason) { if (!disposed && request === generation) body.textContent = `変更ファイルを読み込めません: ${String(reason)}`; }
  }
  async function renderTree(request: number) {
    const expanded = new Set(state.expanded);
    const nodes = history!.commits.map(commit => {
      const details = document.createElement("details");
      details.dataset.commit = commit.oid;
      const label = document.createElement("summary");
      label.textContent = `${commit.oid.slice(0, 8)}  ${commit.message.split("\n")[0]}`;
      label.title = `${commit.message}\n${commit.author}\n${commit.date}`;
      const metadata = document.createElement("div");
      metadata.className = "git-metadata";
      metadata.textContent = `${commit.author} · ${commit.date}`;
      const body = document.createElement("div");
      body.className = "git-files";
      details.append(label, metadata, body);
      details.open = expanded.has(commit.oid);
      details.addEventListener("toggle", () => {
        if (disposed || request !== generation) return;
        if (details.open) void populate(details, commit.oid, request);
        publish();
      }, { signal: listeners.signal });
      return details;
    });
    tree.replaceChildren(...nodes);
    await Promise.all(nodes.filter(item => item.open).map(item => populate(item, item.dataset.commit!, request)));
  }
  async function load(refresh = false) {
    if (disposed || !visible) return false;
    const request = ++generation;
    tree.setAttribute("inert", "");
    ++diffGeneration;
    error.hidden = true;
    more.disabled = true;
    const saved = { ...state, expanded: [...state.expanded] };
    try {
      const first = await ports.history(path, refresh ? null : saved.head, 0);
      if (disposed || request !== generation) return false;
      history = first;
      const branchChanged = refresh && (first.branch !== saved.branch || first.branch === null && first.head !== saved.head);
      const wanted = branchChanged ? 100 : saved.count;
      while (history.hasMore && (history.commits.length < wanted || refresh && !branchChanged && saved.commit !== null && !history.commits.some(commit => commit.oid === saved.commit))) {
        const page = await ports.history(path, history.head, history.commits.length);
        if (disposed || request !== generation) return false;
        history.commits.push(...page.commits);
        history.hasMore = page.hasMore;
      }
      state = { ...saved, head: first.head, branch: first.branch, count: history.commits.length };
      if (branchChanged) state = { ...state, expanded: [], commit: null, file: null, historyScroll: 0, diffScroll: 0 };
      branch.textContent = first.branch ?? (first.head ? `detached HEAD · ${first.head.slice(0, 8)}` : "HEAD");
      more.hidden = !history.hasMore;
      const selected = state.commit && history.commits.some(commit => commit.oid === state.commit) ? state.commit : history.commits[0]?.oid;
      const initial = !state.commit || state.commit !== selected;
      if (selected && initial) state.expanded = [...new Set([...state.expanded, selected])];
      await renderTree(request);
      if (disposed || request !== generation) return false;
      if (selected) {
        const files = fileCache.get(selected) ?? await ports.files(path, selected);
        if (disposed || request !== generation) return false;
        fileCache.set(selected, files);
        const file = files.find(file => file.path === state.file)?.path ?? files[0]?.path;
        if (file) {
          const scroll = initial ? 0 : saved.diffScroll;
          await selectFile(selected, file);
          if (disposed || request !== generation) return false;
          diffPane.scrollTop = scroll;
        } else { state.commit = selected; state.file = null; diffPane.textContent = "変更ファイルなし"; }
      } else { state.commit = null; state.file = null; tree.textContent = "コミットがありません"; diffPane.textContent = ""; summary.textContent = "コミットがありません"; }
      historyPane.scrollTop = branchChanged ? 0 : saved.historyScroll;
      publish();
      return true;
    } catch (reason) { if (!disposed && request === generation) showError(reason); return !disposed && request === generation; }
    finally { if (!disposed && request === generation) { more.disabled = false; tree.removeAttribute("inert"); } }
  }
  async function loadMore() {
    if (!history?.hasMore || more.disabled) return;
    const request = generation;
    more.disabled = true;
    try {
      const page = await ports.history(path, history.head, history.commits.length);
      if (disposed || request !== generation) return;
      publish();
      history.commits.push(...page.commits);
      history.hasMore = page.hasMore;
      state.count = history.commits.length;
      await renderTree(request);
      if (disposed || request !== generation) return;
      more.hidden = !page.hasMore;
      historyPane.scrollTop = state.historyScroll;
      publish();
    } catch (reason) { if (!disposed && request === generation) showError(reason); }
    finally { if (!disposed && request === generation) more.disabled = false; }
  }
  function setRatio(ratio: number, save = false) {
    ratio = Math.min(GIT_PREVIEW_MAX_RATIO, Math.max(GIT_PREVIEW_MIN_RATIO, ratio));
    root.style.gridTemplateRows = `minmax(0, ${ratio}fr) 6px minmax(0, ${1 - ratio}fr)`;
    separator.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    if (save) ports.saveRatio(ratio);
  }
  setRatio(ports.getRatio());
  separator.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    separator.setPointerCapture(event.pointerId);
  }, { signal: listeners.signal });
  separator.addEventListener("pointermove", (event) => {
    if (!separator.hasPointerCapture(event.pointerId)) return;
    const bounds = root.getBoundingClientRect();
    if (bounds.height > 0) setRatio((event.clientY - bounds.top) / bounds.height);
  }, { signal: listeners.signal });
  separator.addEventListener("pointerup", (event) => {
    if (!separator.hasPointerCapture(event.pointerId)) return;
    separator.releasePointerCapture(event.pointerId);
    ports.saveRatio(Number(separator.getAttribute("aria-valuenow")) / 100);
  }, { signal: listeners.signal });
  separator.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    setRatio(Number(separator.getAttribute("aria-valuenow")) / 100 + (event.key === "ArrowDown" ? 0.05 : -0.05), true);
  }, { signal: listeners.signal });
  tree.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const details = target.closest("details");
      if (details) { event.preventDefault(); details.open = event.key === "ArrowRight"; }
      return;
    }
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const items = Array.from(tree.querySelectorAll<HTMLElement>("summary, button[data-file]")).filter(item => item.tagName === "SUMMARY" || item.closest("details")?.open);
    const index = items.indexOf(target);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
    items[next]?.focus();
  }, { signal: listeners.signal });
  historyPane.addEventListener("scroll", publish, { signal: listeners.signal });
  diffPane.addEventListener("scroll", publish, { signal: listeners.signal });
  more.addEventListener("click", () => { void loadMore(); }, { signal: listeners.signal });
  return {
    load,
    refresh: () => load(true),
    setVisible: (next: boolean) => {
      if (disposed || next === visible) return;
      publish();
      visible = next;
      ++generation;
      ++diffGeneration;
      if (visible) void load();
    },
    dispose: () => { publish(); disposed = true; ++generation; ++diffGeneration; listeners.abort(); },
  };
}
