# Completion checks
- Run focused tests while editing, then the full `npm test` once.
- Required final checks for UI/backend changes: `npx tsc --noEmit`, `npm run check:ipc`, `npm run check:generated`, `npx vite build`, `cargo test -p wasabipad -- --test-threads=1`, and `git diff --check`.
- Inspect `git diff` and `git status --short`; parent task commits after verification.