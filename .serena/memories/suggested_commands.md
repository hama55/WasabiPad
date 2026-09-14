# Windows commands
- UI tests: `npm test`; focused test: `npx vitest run ui/<file>.test.ts`.
- Type check/build: `npx tsc --noEmit`, `npx vite build`.
- IPC/generated checks: `npm run check:ipc`, `npm run check:generated`.
- Backend tests: `cargo test -p wasabipad -- --test-threads=1`.
- Diff whitespace/status: `git diff --check`, `git status --short`.
- Use PowerShell paths and `rg` for repository search.