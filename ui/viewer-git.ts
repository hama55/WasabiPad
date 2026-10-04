import type { GitHistory, GitBranch, GitChangedFile, GitFileDiff } from "./api";
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
  collapsed: boolean;
}

export interface GitPreviewPorts {
  branches: (path: string) => Promise<GitBranch[]>;
  worktreeFiles: (path: string) => Promise<GitChangedFile[]>;
  worktreeDiff: (path: string, file: string) => Promise<GitFileDiff>;
  history: (path: string, head: string | null, offset: number) => Promise<GitHistory>;
  files: (path: string, commit: string) => Promise<GitChangedFile[]>;
  diff: (path: string, commit: string, file: string) => Promise<GitFileDiff>;
  getRatio: () => number;
  saveRatio: (ratio: number) => void;
}

export function createGitPreviewController(host: HTMLElement, summary: HTMLElement, path: string, ports: GitPreviewPorts) {
  const listeners = new AbortController();
  const root = document.createElement("section");
  root.className = "git-preview";
  const historyPane = document.createElement("div");
  historyPane.className = "git-history";
  const branch = document.createElement("button");
  branch.type = "button";
  branch.setAttribute("aria-label", "閲覧ブランチを選択");
  branch.setAttribute("aria-expanded", "false");
  const branchPanel = document.createElement("div");
  branchPanel.className = "git-branch-panel";
  branchPanel.setAttribute("popover", "auto");
  branchPanel.setAttribute("aria-label", "ブランチ一覧");
  const branchSearch = document.createElement("input");
  branchSearch.type = "search";
  branchSearch.placeholder = "ブランチを検索";
  branchSearch.setAttribute("aria-label", "ブランチを検索");
  const branchChoices = document.createElement("div");
  branchPanel.append(branchSearch, branchChoices);
  const worktree = document.createElement("details");
  worktree.dataset.commit = "worktree";
  const worktreeLabel = document.createElement("summary");
  const worktreeBody = document.createElement("div");
  worktreeBody.className = "git-files";
  worktree.append(worktreeLabel, worktreeBody);
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
  historyPane.append(worktree, branch, branchPanel, error, tree, more);
  root.append(historyPane, separator, diffPane);
  host.replaceChildren(root);
  let disposed = false;
  let visible = true;
  let generation = 0;
  let diffGeneration = 0;
  let history: GitHistory | null = null;
  let selectedBranch: GitBranch | null = null;
  let workingBranch: string | null = null;
  let workingHead: string | null = null;
  let branches: GitBranch[] = [];
  const initialState = (): GitPreviewState => ({ head: null, branch: null, count: 100, expanded: [], commit: null, file: null, historyScroll: 0, diffScroll: 0 });
  let state = initialState();
  const fileCache = new Map<string, GitChangedFile[]>();

  function publish() {
    if (disposed) return;
    state = { ...state, expanded: Array.from(historyPane.querySelectorAll<HTMLDetailsElement>("details[data-commit]")).filter(item => item.open).map(item => item.dataset.commit!), historyScroll: historyPane.scrollTop, diffScroll: diffPane.scrollTop };
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
    historyPane.querySelectorAll<HTMLButtonElement>("button[data-file]").forEach(button => {
      const selected = button.dataset.file === file && button.dataset.commit === commit;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    diffPane.textContent = "差分を読み込み中…";
    publish();
    try {
      const result = await (commit === "worktree" ? ports.worktreeDiff(path, file) : ports.diff(path, commit, file));
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
      summary.textContent = `${commit === "worktree" ? "未コミット" : commit.slice(0, 8)} · ${file}`;
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
      if (!files) { files = await (commit === "worktree" ? ports.worktreeFiles(path) : ports.files(path, commit)); fileCache.set(commit, files); }
      if (disposed || request !== generation || !details.isConnected && !root.contains(details)) return;
      body.replaceChildren();
      body.dataset.loaded = "1";
      if (files.length === 0) body.textContent = commit === "worktree" ? "変更なし" : "変更ファイルなし";
      for (const file of files) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.file = file.path;
        button.dataset.commit = commit;
        const labels = commit === "worktree" ? file.status === "U" ? "競合" : [file.indexStatus ? "ステージ済み" : "", file.worktreeStatus === "?" ? "未追跡" : file.worktreeStatus ? "未ステージ" : ""].filter(Boolean).join("・") : "";
        button.textContent = `${file.status}${labels ? `（${labels}）` : ""}  ${file.oldPath ? `${file.oldPath} → ` : ""}${file.path}`;
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
  async function load(refresh = false, branchSwitch = false) {
    if (disposed || !visible) return false;
    const request = ++generation;
    tree.setAttribute("inert", "");
    worktree.setAttribute("inert", "");
    branch.disabled = true;
    branchPanel.setAttribute("inert", "");
    closeBranches();
    ++diffGeneration;
    error.hidden = true;
    more.disabled = true;
    const saved = { ...state, expanded: [...state.expanded] };
    try {
      const [working, changed] = await Promise.all([ports.history(path, selectedBranch || refresh ? null : saved.head, 0), ports.worktreeFiles(path)]);
      if (disposed || request !== generation) return false;
      let disappeared = false;
      if (selectedBranch && refresh) {
        const choices = await ports.branches(path);
        if (disposed || request !== generation) return false;
        const selected = selectedBranch;
        selectedBranch = choices.find(item => item.name === selected.name && item.remote === selected.remote) ?? null;
        disappeared = selectedBranch === null;
      }
      const first = selectedBranch ? await ports.history(path, refresh || branchSwitch ? selectedBranch.oid : saved.head ?? selectedBranch.oid, 0) : working;
      if (disposed || request !== generation) return false;
      history = first;
      fileCache.set("worktree", changed);
      worktreeBody.removeAttribute("data-loaded");
      workingBranch = working.branch;
      workingHead = working.head;
      worktreeLabel.textContent = `未コミット · ${working.branch ?? "detached HEAD"}`;
      const shownBranch = selectedBranch?.name ?? first.branch;
      const branchChanged = branchSwitch || disappeared || refresh && (shownBranch !== saved.branch || shownBranch === null && first.head !== saved.head);
      const wanted = branchChanged ? 100 : saved.count;
      while (history.hasMore && (history.commits.length < wanted || refresh && !branchChanged && saved.commit !== null && saved.commit !== "worktree" && !history.commits.some(commit => commit.oid === saved.commit))) {
        const page = await ports.history(path, history.head, history.commits.length);
        if (disposed || request !== generation) return false;
        history.commits.push(...page.commits);
        history.hasMore = page.hasMore;
      }
      state = { ...saved, head: first.head, branch: shownBranch, count: history.commits.length };
      if (branchChanged) state = { ...state, expanded: [], commit: null, file: null, historyScroll: 0, diffScroll: 0 };
      branch.textContent = `${selectedBranch?.remote ? "リモート · " : ""}${shownBranch ?? (first.head ? `detached HEAD · ${first.head.slice(0, 8)}` : "HEAD")} ▾`;
      more.hidden = !history.hasMore;
      const selected = state.commit === "worktree" && changed.length ? "worktree"
        : state.commit && history.commits.some(commit => commit.oid === state.commit) ? state.commit
        : !branchSwitch && changed.length ? "worktree" : history.commits[0]?.oid;
      const initial = !state.commit || state.commit !== selected;
      if (selected && initial) state.expanded = [...new Set([...state.expanded, selected])];
      worktree.open = state.expanded.includes("worktree");
      await populate(worktree, "worktree", request);
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
      if (disappeared) { error.textContent = "閲覧ブランチが見つからないため現在の作業HEADを表示しています"; error.hidden = false; }
      return true;
    } catch (reason) { if (!disposed && request === generation) showError(reason); return !disposed && request === generation; }
    finally { if (!disposed && request === generation) { more.disabled = false; branch.disabled = false; tree.removeAttribute("inert"); worktree.removeAttribute("inert"); branchPanel.removeAttribute("inert"); } }
  }

  function closeBranches() {
    branchPanel.hidePopover?.();
    branchPanel.removeAttribute("data-open");
    branch.setAttribute("aria-expanded", "false");
    branch.focus();
  }
  function chooseBranch(choice: GitBranch | null) {
    if (disposed || !visible || branch.disabled) return;
    selectedBranch = choice;
    closeBranches();
    void load(true, true);
  }
  function renderBranches() {
    branchChoices.replaceChildren();
    const query = branchSearch.value.toLocaleLowerCase();
      if (workingBranch === null && "detached head".includes(query)) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = workingHead ? `detached HEAD · ${workingHead.slice(0, 8)}` : "HEAD（コミットなし）";
        button.dataset.branch = "current-head";
        button.addEventListener("click", () => chooseBranch(null), { signal: listeners.signal });
        branchChoices.append(button);
      }
    for (const remote of [false, true]) {
      const matches = branches.filter(item => item.remote === remote && item.name.toLocaleLowerCase().includes(query));
      if (!matches.length) continue;
      const heading = document.createElement("strong");
      heading.textContent = remote ? "リモート（取得済み）" : "ローカル";
      branchChoices.append(heading);
      for (const choice of matches) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = choice.name;
        button.dataset.branch = choice.name;
        button.addEventListener("click", () => chooseBranch(choice), { signal: listeners.signal });
        branchChoices.append(button);
      }
    }
    if (!branchChoices.childElementCount) branchChoices.textContent = "ブランチがありません";
  }
  branch.addEventListener("click", async () => {
    const request = generation;
    try {
      branches = await ports.branches(path);
      if (disposed || !visible || request !== generation) return;
      branchSearch.value = "";
      renderBranches();
      branchPanel.showPopover?.();
      branchPanel.setAttribute("data-open", "");
      branch.setAttribute("aria-expanded", "true");
      branchSearch.focus();
    } catch (reason) { if (!disposed && request === generation) showError(reason); }
  }, { signal: listeners.signal });
  branchPanel.addEventListener("toggle", event => {
    if ((event as ToggleEvent).newState === "closed") { branch.setAttribute("aria-expanded", "false"); branch.focus(); }
  }, { signal: listeners.signal });
  branchSearch.addEventListener("input", renderBranches, { signal: listeners.signal });
  branchSearch.addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); branchChoices.querySelector<HTMLButtonElement>("button")?.click(); }
    else if (event.key === "Escape") { event.preventDefault(); closeBranches(); }
  }, { signal: listeners.signal });
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
  historyPane.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const details = target.closest("details");
      if (details) { event.preventDefault(); details.open = event.key === "ArrowRight"; }
      return;
    }
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const items = Array.from(historyPane.querySelectorAll<HTMLElement>("summary, button[data-file]")).filter(item => item.tagName === "SUMMARY" || item.closest("details")?.open);
    const index = items.indexOf(target);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
    items[next]?.focus();
  }, { signal: listeners.signal });
  historyPane.addEventListener("scroll", publish, { signal: listeners.signal });
  diffPane.addEventListener("scroll", publish, { signal: listeners.signal });
  more.addEventListener("click", () => { void loadMore(); }, { signal: listeners.signal });
  worktree.addEventListener("toggle", publish, { signal: listeners.signal });
  return {
    load,
    refresh: () => load(true),
    setVisible: (next: boolean) => {
      if (disposed || next === visible) return;
      publish();
      visible = next;
      ++generation;
      ++diffGeneration;
      closeBranches();
      if (visible) { state = initialState(); selectedBranch = null; fileCache.clear(); void load(); }
    },
    dispose: () => { publish(); disposed = true; ++generation; ++diffGeneration; listeners.abort(); },
  };
}
