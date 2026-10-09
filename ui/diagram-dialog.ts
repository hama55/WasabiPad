import { DiagramDocument, diagramElementSvg, diagramContentBounds, fitDiagramCanvas, readDiagramSvg, type Diagram, type DiagramElement, type DiagramKind, validateStandaloneSvg } from "./diagram";
import { imageDataUrl } from "./diagram-assets";
import { imageMimeType } from "./image-formats";
import { openModal } from "./modal";
import { confirmMessage } from "./prompt";
import { iconButton } from "./icon-button";
import { MENU_ICON, createMenuIcon, type MenuIconClass } from "./menu-icons";

const buttonIcons: Record<string, MenuIconClass> = {
  選択: MENU_ICON.pointer, 四角形: MENU_ICON.rectangle, 楕円: MENU_ICON.ellipse, 直線: MENU_ICON.line,
  矢印: MENU_ICON.arrow, 吹き出し: MENU_ICON.callout, 文字: MENU_ICON.text,
  元に戻す: MENU_ICON.undo, やり直す: MENU_ICON.redo, 削除: MENU_ICON.delete,
  最前面: MENU_ICON.front, 最背面: MENU_ICON.back, 全体を表示: MENU_ICON.fit,
  画像を追加: MENU_ICON.image, 背景を選び直す: MENU_ICON.image, キャンセル: MENU_ICON.close, 閉じる: MENU_ICON.close, OK: MENU_ICON.confirm,
};

export interface DiagramBackground {
  bytes: ArrayBuffer;
  mimeType: string;
  dataUrl: string;
}
export interface DiagramEditorOptions {
  initial: Diagram;
  sources: Map<string, string>;
  save: (diagram: Diagram, backgrounds: Map<string, DiagramBackground>) => Promise<void>;
  missing?: string[];
  initialBackgrounds?: Map<string, DiagramBackground>;
}

export function openDiagramEditor(options: DiagramEditorOptions): Promise<void> {
  return new Promise((resolve) => {
    const model = new DiagramDocument(options.initial);
    const original = JSON.stringify(model.value);
    const backgrounds = new Map(options.initialBackgrounds);
    const sources = new Map(options.sources);
    let selected: number | null = null;
    let tool: DiagramKind | "select" = "select";
    let pending = false, confirming = false, closed = false;
    let drag: { clientX: number; clientY: number; scaleX: number; scaleY: number; initial: Diagram; element: DiagramElement | null; mode: string; id: number } | null = null;
    const { box, close } = openModal({ onCancel: () => { void cancel(); } }, "diagram-editor");
    box.innerHTML = `<div class="pf-title diagram-heading"><span>図を編集</span><button type="button" aria-label="閉じる">×</button></div>
      <div class="diagram-tools"></div><div class="diagram-properties"></div>
      <div class="diagram-viewport"><div class="diagram-canvas-frame"><svg class="diagram-canvas" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="図の編集領域" tabindex="0"></svg></div></div>
      <div class="diagram-message" role="status" aria-live="polite"></div>
      <div class="pf-btns"><button class="diagram-cancel">キャンセル</button><button class="pf-ok">OK</button></div>`;
    const toolbar = box.querySelector<HTMLElement>(".diagram-tools")!;
    const properties = box.querySelector<HTMLElement>(".diagram-properties")!;
    const canvas = box.querySelector<SVGSVGElement>(".diagram-canvas")!;
    const frame = box.querySelector<HTMLElement>(".diagram-canvas-frame")!;
    const message = box.querySelector<HTMLElement>(".diagram-message")!;
    const ok = box.querySelector<HTMLButtonElement>(".pf-ok")!;
    for (const [selector, label] of [[".diagram-heading button", "閉じる"], [".diagram-cancel", "キャンセル"], [".pf-ok", "OK"]]) {
      const b = box.querySelector<HTMLButtonElement>(selector)!;
      b.title = label; b.setAttribute("aria-label", label); b.replaceChildren(createMenuIcon(buttonIcons[label]));
    }
    function contentBounds(diagram: Diagram) {
      return diagramContentBounds(diagram, (element) => {
        const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
        group.innerHTML = diagramElementSvg(element); group.style.visibility = "hidden"; canvas.append(group);
        try { return group.querySelector<SVGGraphicsElement>("text")!.getBBox(); }
        finally { group.remove(); }
      });
    }
    const change = (diagram: Diagram) => model.change(fitDiagramCanvas(diagram, contentBounds(diagram)));
    for (const [edge, label] of [["e", "図の幅を変更"], ["s", "図の高さを変更"], ["se", "図の幅と高さを変更"]] as const) {
      const handle = document.createElement("button"); handle.type = "button"; handle.dataset.canvasResize = edge;
      handle.className = "diagram-canvas-resize"; handle.title = label; handle.setAttribute("aria-label", label); frame.append(handle);
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || pending || confirming || drag) return;
        event.preventDefault(); handle.focus();
        drag = { clientX: event.clientX, clientY: event.clientY, scaleX: Number(zoom.value) / 100,
          scaleY: Number(zoom.value) / 100, initial: model.value, element: null, mode: `canvas-${edge}`, id: -1 };
      });
      handle.addEventListener("keydown", (event) => {
        if (pending || confirming || drag || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        const d = model.value;
        try { change({ ...d, width: Math.max(1, Math.min(10000, d.width + (edge.includes("e") ? event.key === "ArrowRight" ? 10 : event.key === "ArrowLeft" ? -10 : 0 : 0))),
          height: Math.max(1, Math.min(10000, d.height + (edge.includes("s") ? event.key === "ArrowDown" ? 10 : event.key === "ArrowUp" ? -10 : 0 : 0))) }); render(); }
        catch (error) { message.textContent = String(error); }
      });
    }
    const button = (label: string, action: () => void, host = toolbar) => {
      const b = iconButton("", "", label); b.append(createMenuIcon(buttonIcons[label]));
      b.addEventListener("click", () => { if (!pending && !confirming && !drag) action(); }); host.append(b); return b;
    };
    const tools = new Map<string, HTMLButtonElement>();
    for (const [kind, label] of [["select", "選択"], ["rect", "四角形"], ["ellipse", "楕円"], ["line", "直線"], ["arrow", "矢印"], ["callout", "吹き出し"], ["text", "文字"]] as const) {
      tools.set(kind, button(label, () => { tool = kind; render(); }));
    }
    const undo = button("元に戻す", () => { model.undo(); selected = null; render(); });
    const redo = button("やり直す", () => { model.redo(); selected = null; render(); });
    button("削除", () => { if (selected !== null) model.remove(selected); selected = null; render(); });
    button("最前面", () => { if (selected !== null) model.reorder(selected, true); render(); });
    button("最背面", () => { if (selected !== null) model.reorder(selected, false); render(); });

    const input = (label: string, type: string, value: string, onChange: (value: string) => void, min?: string, max?: string) => {
      const wrapper = document.createElement("label"); wrapper.textContent = label;
      const field = document.createElement("input"); field.type = type; field.value = value;
      if (min) field.min = min; if (max) field.max = max;
      field.setAttribute("aria-label", label); wrapper.append(field); properties.append(wrapper);
      field.addEventListener("change", () => {
        if (pending || confirming || drag) return;
        try { if (!field.checkValidity()) throw new Error(`${label}の範囲を確認してください`); onChange(field.value); message.textContent = ""; render(); }
        catch (error) { message.textContent = String(error); }
      });
      return field;
    };
    const updateSelected = (changes: Partial<DiagramElement>) => { if (selected !== null) change({ ...model.value, elements: model.value.elements.map((e) => e.id === selected ? { ...e, ...changes } : e) }); };
    const stroke = input("線の色", "color", "#ff0000", (value) => updateSelected({ stroke: value }));
    const strokeWidth = input("線の太さ", "number", "2", (value) => updateSelected({ strokeWidth: Number(value) }), "0", "100");
    const fill = input("塗りつぶし", "color", "#ffffff", (value) => { if (!transparent.checked) updateSelected({ fill: value }); });
    const transparent = input("透明", "checkbox", "", () => updateSelected({ fill: transparent.checked ? "none" : fill.value }));
    transparent.checked = true;
    const textColor = input("文字色", "color", "#000000", (value) => updateSelected({ textColor: value }));
    const fontSize = input("文字サイズ", "number", "20", (value) => updateSelected({ fontSize: Number(value) }), "1", "300");
    const width = input("図の幅", "number", String(model.value.width), (value) => change({ ...model.value, width: Number(value) }), "1", "10000");
    const height = input("図の高さ", "number", String(model.value.height), (value) => change({ ...model.value, height: Number(value) }), "1", "10000");
    width.step = height.step = "any";
    const zoom = input("倍率 %", "number", "100", () => {}, "5", "400");
    button("全体を表示", () => { fit(); render(); });
    const file = document.createElement("input"); file.type = "file"; file.accept = "image/png,image/jpeg,image/gif,image/webp,image/bmp,image/svg+xml,image/avif";
    file.hidden = true; box.append(file);
    let replacementId: number | null = null;
    button("画像を追加", () => { replacementId = null; file.click(); });
    const replaceBackground = button("背景を選び直す", () => {
      replacementId = model.value.elements.find((e) => e.kind === "image" && e.id === selected)?.id ?? model.value.elements.find((e) => e.kind === "image")?.id ?? null;
      file.click();
    });
    file.addEventListener("change", async () => {
      const selectedFile = file.files?.[0]; if (!selectedFile || pending) return;
      setPending(true);
      try {
        const bytes = await selectedFile.arrayBuffer();
        const mimeType = imageMimeType(selectedFile.name);
        if (mimeType === "image/svg+xml") {
          const svg = new TextDecoder().decode(bytes);
          if (readDiagramSvg(svg)) throw new Error("編集図は背景に取り込めません。本文の「図を編集」から開いてください。");
          validateStandaloneSvg(svg);
        }
        const dataUrl = imageDataUrl(bytes, mimeType);
        const dimensions = await imageDimensions(dataUrl);
        if (closed) return;
        let index = backgrounds.size + 1;
        const extension = selectedFile.name.split(".").pop()?.toLowerCase() ?? "png";
        while (sources.has(`background-${index}.${extension}`)) index += 1;
        const src = `background-${index}.${extension}`;
        const existing = model.value.elements.find((e) => e.kind === "image" && e.id === replacementId);
        if (existing) change({ ...model.value, elements: model.value.elements.map((e) => e.id === existing.id ? { ...e, src } : e) });
        else {
          const blank = model.value.elements.length === 0;
          const id = Math.max(0, ...model.value.elements.map((e) => e.id)) + 1;
          change({ width: blank ? Math.min(10000, dimensions.width) : model.value.width,
            height: blank ? Math.min(10000, dimensions.height) : model.value.height,
            elements: [{ id, kind: "image", src, x: 0, y: 0, width: dimensions.width, height: dimensions.height }, ...model.value.elements] });
          selected = id;
        }
        backgrounds.set(src, { bytes, mimeType, dataUrl }); sources.set(src, dataUrl);
        message.textContent = ""; fit(); render();
      } catch (error) { if (!closed) message.textContent = `背景画像を読み込めませんでした: ${String(error)}`; }
      finally { setPending(false); file.value = ""; }
    });

    const textEditor = document.createElement("textarea"); textEditor.className = "diagram-text-editor";
    textEditor.setAttribute("aria-label", "説明文"); textEditor.placeholder = "説明文（改行できます）"; textEditor.hidden = true;
    box.insertBefore(textEditor, box.querySelector(".diagram-viewport"));
    textEditor.addEventListener("change", () => {
      if (pending || confirming || drag) return;
      try { updateSelected({ text: textEditor.value }); message.textContent = ""; }
      catch (error) { message.textContent = String(error); }
      render();
    });
    canvas.addEventListener("dblclick", (event) => {
      const node = (event.target as Element).closest("[data-element]");
      const element = model.value.elements.find((e) => e.id === Number(node?.getAttribute("data-element")));
      if (element && ["text", "callout"].includes(element.kind)) { selected = element.id; render(); textEditor.focus(); }
    });

    const point = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: (event.clientX - rect.left) * model.value.width / (rect.width || model.value.width),
        y: (event.clientY - rect.top) * model.value.height / (rect.height || model.value.height) };
    };
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || pending || confirming) return;
      event.preventDefault(); canvas.focus();
      const p = point(event), target = event.target as Element;
      const handle = target.getAttribute("data-handle");
      const id = Number(target.closest("[data-element]")?.getAttribute("data-element") ?? -1);
      const element = model.value.elements.find((e) => e.id === id) ?? null;
      const initial = model.value;
      const rect = canvas.getBoundingClientRect();
      const start = { clientX: event.clientX, clientY: event.clientY,
        scaleX: rect.width / initial.width || Number(zoom.value) / 100, scaleY: rect.height / initial.height || Number(zoom.value) / 100, initial };
      if (handle && selected !== null) drag = { ...start, element: model.value.elements.find((e) => e.id === selected) ?? null, mode: handle, id: selected };
      else if (tool === "select") {
        selected = element?.id ?? null;
        if (element) drag = { ...start, element, mode: "move", id: element.id };
      } else {
        const id = Math.max(0, ...initial.elements.map((e) => e.id)) + 1;
        const element: DiagramElement = { id, kind: tool, x: p.x, y: p.y, width: 0, height: 0,
          stroke: stroke.value, strokeWidth: Number(strokeWidth.value), fill: transparent.checked ? "none" : fill.value,
          textColor: textColor.value, fontSize: Number(fontSize.value), ...["text", "callout"].includes(tool) ? { text: "説明" } : {} };
        drag = { ...start, element, mode: "create", id }; selected = id;
      }
      render();
    });
    const move = (event: PointerEvent) => {
      if (!drag) return;
      try {
      const dx = (event.clientX - drag.clientX) / drag.scaleX, dy = (event.clientY - drag.clientY) / drag.scaleY;
      if (drag.mode.startsWith("canvas-")) {
        const d = drag.initial, edge = drag.mode.slice(7);
        model.value = fitDiagramCanvas({ ...d,
          width: edge.includes("e") ? Math.max(1, Math.min(10000, d.width + dx)) : d.width,
          height: edge.includes("s") ? Math.max(1, Math.min(10000, d.height + dy)) : d.height }, contentBounds(d));
        render(); return true;
      }
      if (!drag.element) return;
      const e = { ...drag.element };
      if (drag.mode === "create") { e.width = dx; e.height = dy; }
      else if (drag.mode === "move") { e.x += dx; e.y += dy; }
      else {
        let left = Math.min(e.x, e.x + e.width), right = Math.max(e.x, e.x + e.width);
        let top = Math.min(e.y, e.y + e.height), bottom = Math.max(e.y, e.y + e.height);
        if (drag.mode.includes("w")) left += dx; else right += dx;
        if (drag.mode.includes("n")) top += dy; else bottom += dy;
        e.x = e.width < 0 ? right : left; e.width = (e.width < 0 ? -1 : 1) * (right - left);
        e.y = e.height < 0 ? bottom : top; e.height = (e.height < 0 ? -1 : 1) * (bottom - top);
      }
      const next = { ...drag.initial, elements: drag.mode === "create" ? [...drag.initial.elements, e] : drag.initial.elements.map((item) => item.id === e.id ? e : item) };
      model.value = fitDiagramCanvas(next, contentBounds(next));
      render();
      return true;
      } catch (error) { message.textContent = String(error); return false; }
    };
    const up = (event: PointerEvent) => {
      if (!drag) return;
      const moved = move(event);
      let changed = model.value;
      if (drag.mode === "create") {
        changed = { ...changed, elements: changed.elements.map((e) => e.id === drag!.id && Math.abs(e.width) < 2 && Math.abs(e.height) < 2 ? { ...e, width: 160, height: 90 } : e) };
        tool = "select";
      }
      model.value = drag.initial; drag = null;
      try { change(changed); if (moved !== false) message.textContent = ""; } catch (error) { message.textContent = String(error); }
      render();
    };
    const cancelDrag = () => { if (drag) { model.value = drag.initial; drag = null; render(); } };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", cancelDrag);
    const key = (event: KeyboardEvent) => {
      if (pending || confirming || !box.contains(document.activeElement)) return;
      const editing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
      if (editing) return;
      if (drag) {
        if (event.ctrlKey && ["z", "y"].includes(event.key.toLowerCase()) || event.key === "Delete") { event.preventDefault(); event.stopPropagation(); }
        return;
      }
      if (event.ctrlKey && ["z", "y"].includes(event.key.toLowerCase())) {
        event.preventDefault(); event.stopPropagation();
        if (event.key.toLowerCase() === "y" || event.shiftKey) model.redo(); else model.undo(); selected = null; render();
      } else if (event.key === "Delete" && selected !== null) { event.preventDefault(); model.remove(selected); selected = null; render(); }
    };
    box.addEventListener("keydown", key);

    function fit() {
      const viewport = box.querySelector<HTMLElement>(".diagram-viewport")!;
      const availableWidth = viewport.clientWidth || Math.min(window.innerWidth * .8, 1000) || 800;
      const availableHeight = viewport.clientHeight || Math.min(window.innerHeight * .5, 600) || 600;
      zoom.value = String(Math.max(5, Math.min(100, Math.floor(Math.min((availableWidth - 36) / model.value.width, (availableHeight - 36) / model.value.height) * 100))));
    }
    function render() {
      const d = model.value;
      canvas.setAttribute("viewBox", `0 0 ${d.width} ${d.height}`);
      canvas.style.width = `${d.width * Number(zoom.value) / 100}px`; canvas.style.height = `${d.height * Number(zoom.value) / 100}px`;
      frame.style.width = canvas.style.width; frame.style.height = canvas.style.height;
      width.value = String(d.width); height.value = String(d.height);
      canvas.innerHTML = d.elements.map((e) => `<g data-element="${e.id}" pointer-events="${e.kind === "image" ? "all" : "bounding-box"}">${diagramElementSvg(e, e.src ? sources.get(e.src) ?? "" : "")}</g>`).join("");
      const e = d.elements.find((e) => e.id === selected);
      if (e) {
        const x = Math.min(e.x, e.x + e.width), y = Math.min(e.y, e.y + e.height), w = Math.abs(e.width), h = Math.abs(e.height);
        canvas.insertAdjacentHTML("beforeend", `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#0078d4" stroke-dasharray="4 3" pointer-events="none"/>` +
          [["nw", x, y], ["ne", x + w, y], ["sw", x, y + h], ["se", x + w, y + h]].map(([corner, cx, cy]) => `<rect data-handle="${corner}" x="${Number(cx) - 4}" y="${Number(cy) - 4}" width="8" height="8" fill="#ffffff" stroke="#0078d4"/>`).join(""));
        stroke.value = e.stroke ?? "#ff0000"; strokeWidth.value = String(e.strokeWidth ?? 2);
        transparent.checked = !e.fill || e.fill === "none"; if (e.fill && e.fill !== "none") fill.value = e.fill;
        textColor.value = e.textColor ?? "#000000"; fontSize.value = String(e.fontSize ?? 20);
      }
      textEditor.hidden = !e || !["text", "callout"].includes(e.kind);
      if (!textEditor.hidden && document.activeElement !== textEditor) textEditor.value = e?.text ?? "";
      undo.disabled = !model.canUndo; redo.disabled = !model.canRedo;
      replaceBackground.disabled = !d.elements.some((e) => e.kind === "image");
      for (const [kind, button] of tools) button.setAttribute("aria-pressed", String(kind === tool));
    }
    function finish() {
      if (closed) return; closed = true;
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", cancelDrag); close(); resolve();
    }
    function setPending(value: boolean) {
      pending = value;
      if (closed) return;
      for (const control of box.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement>("input,button,textarea")) control.disabled = value;
      if (!value) render();
    }
    async function cancel() {
      if (pending || confirming || closed) return;
      cancelDrag();
      if (JSON.stringify(model.value) !== original) {
        confirming = true;
        const discard = await confirmMessage("図の編集", "変更を破棄しますか？", "破棄", "編集に戻る");
        confirming = false;
        if (!discard) return;
      }
      finish();
    }
    ok.addEventListener("click", async () => {
      if (pending || confirming || drag) return;
      if (document.activeElement === textEditor) textEditor.blur();
      if (JSON.stringify(model.value) === original || model.value.elements.length === 0 && options.initial.elements.length === 0) { finish(); return; }
      setPending(true); message.textContent = "保存中…";
      try { await options.save(fitDiagramCanvas(model.value, contentBounds(model.value), true), backgrounds); finish(); }
      catch (error) { message.textContent = `保存できませんでした: ${String(error)}`; }
      finally { setPending(false); }
    });
    box.querySelector(".diagram-cancel")!.addEventListener("click", () => { void cancel(); });
    box.querySelector(".diagram-heading button")!.addEventListener("click", () => { void cancel(); });
    if (options.missing?.length) message.textContent = "背景画像が見つからないか、読み込めません。背景画像を選び直してください。";
    fit(); render(); canvas.focus();
  });
}

export async function imageDimensions(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("画像を表示できません"));
    image.src = src;
  });
}
