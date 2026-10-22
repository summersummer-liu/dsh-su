# Changelog

## 0.1.1 - 2026-10-22

- Fix: tool renderers now return DSH content parts (`[{ type: 'text', text }]`) instead of a bare JSON string; every `su_*` tool previously failed with "output.render returned non-lossless JSON".
- Fix: renderer signature mismatch (`render(args, value)` vs `renderJson(value)`) that produced `undefined` text.
- Tests: unit test now asserts the render contract for all 8 tools.
## 0.1.0 — 2026-10-22

Initial release.

- DSH plugin with 8 SketchUp tools: `su_status`, `su_install_extension`, `su_ensure`,
  `su_run`, `su_eval`, `su_save`, `su_capture`, `su_stop`.
- Bundled self-contained SketchUp extension `dsh_su_bridge` (TCP JSON-lines server on
  port 47311, auto-embedded in SketchUp's Plugins folder, `Extensions → DSH Bridge`
  menu with status / log folder / restart).
- Bundled `su_kit` metric modelling kit and `sketchup-modeling` agent skill.
- Automatic SketchUp executable / template detection, workspace-restricted paths,
  overwrite guards, transient-error retries.
- Unit tests, real-SketchUp integration test, end-to-end plugin tool test.
