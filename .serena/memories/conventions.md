# Conventions
- Tests follow BDD/Gherkin comments: Feature, Scenario, Given, When, Then; preserve tests for existing behavior.
- Prefer shared helpers/types and keep UI wiring in `ui/main.ts`; keep domain restrictions in the relevant helper instead of duplicating caller guards.
- External integration is explicit, not automatic; only saved real files are eligible, while unsaved, virtual, and archive-entry content remains excluded.
- Do not hand-edit generated IPC files without running the repository sync/check flow.
- Preserve memory-only handling for password-protected archive plaintext; do not add temp/cache/transmission paths for protected data.