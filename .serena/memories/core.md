# WasabiPad source map
- Tauri desktop app: TypeScript UI under `ui/`, Rust backend under `src-tauri/`, shared Rust protocol/core under `core/` and `shared/`.
- Domain boundaries and terminology: `CONTEXT.md`; architecture decisions: `docs/adr/`.
- UI entry/wiring: `ui/main.ts`; document/session state: `ui/document-controller.ts`, `ui/session.ts`.
- File tree operations: `ui/sidebar.ts`, `ui/folder-actions.ts`; editor: `ui/editor.ts`; preview: `ui/viewer.ts`.
- Read focused module memories before changing the relevant area: `mem:tech_stack`, `mem:conventions`, `mem:task_completion`.