# Stack
- TypeScript + Vite + Vitest + jsdom; npm package scripts are authoritative in `package.json`.
- Tauri/Rust backend; Windows-specific process/window integration uses `windows-sys` under `src-tauri/`.
- IPC bindings are generated; source contract changes require the repository sync/check scripts.
- Rust tests run through Cargo; Windows behavior may need real Windows GUI validation beyond unit tests.