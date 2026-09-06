import { VirtualEditor, type EditorPorts } from "./editor";
import { InlinePreview, type InlinePreviewPorts } from "./inline-preview";
import { EditingStatusBar, type StatusBarPorts } from "./statusbar";

export interface EditingSurfaceHostElements {
  editor: HTMLElement;
  preview: HTMLElement;
  statusbar: HTMLElement;
}

export interface EditingSurfaceHostPorts {
  editor: EditorPorts;
  preview: InlinePreviewPorts;
  statusbar: StatusBarPorts;
}

export class EditingSurfaceHost {
  readonly editor: VirtualEditor;
  readonly preview: InlinePreview;
  readonly statusbar: EditingStatusBar;

  constructor(elements: EditingSurfaceHostElements, ports: EditingSurfaceHostPorts) {
    this.statusbar = new EditingStatusBar(elements.statusbar, ports.statusbar);
    this.preview = new InlinePreview(elements.preview, ports.preview);
    this.editor = new VirtualEditor(elements.editor, ports.editor);
  }
}
