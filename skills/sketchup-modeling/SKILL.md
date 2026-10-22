---
name: sketchup-modeling
description: Drive a live SketchUp Pro 2023 session from DSH through the dsh-su bridge plugin — inspect the model, run Ruby task scripts with the metric su_kit library, save .skp files, and capture viewport PNGs for visual QA. Use whenever the user asks to model, edit, measure, or render in SketchUp, to continue an existing SU project, or to deliver a .skp.
---

# SketchUp modelling through dsh-su

SketchUp stays open as a warm process; every task is one bridge round-trip. Never restart SketchUp per task and never edit .skp files by hand.

## Start every task here

1. `su_status` — is the bridge alive? Which model is open? Which extension version is installed?
2. `su_ensure` — installs/updates the bundled SketchUp extension, reuses a running bridge or launches SketchUp with the configured template, waits for the port, and sets document units to metres.
   - `fresh: true` resets the document — only with explicit user intent.
   - If SketchUp is already open *without* the bridge, restart it so the extension loads (or let `su_ensure` start a second instance).
3. Do the work with `su_run` (multi-step Ruby script) or `su_eval` (quick inspection).
4. Prove it visually with `su_capture` + `read_image`.
5. Save with `su_save`; run a read-back check (reopen in a fresh instance or re-inspect counts/bbox) before claiming success.

## Tools

| tool | purpose |
| --- | --- |
| `su_status` | bridge / model / extension / paths |
| `su_install_extension` | copy the bundled "DSH Bridge" extension into Plugins |
| `su_ensure` | install + launch/reuse + wait + set units |
| `su_run` | run a `.rb` task script inside SketchUp; returns `$dsh_result` |
| `su_eval` | evaluate a Ruby snippet; returns `$dsh_result` |
| `su_save` | save the active document as `.skp` (workspace-restricted) |
| `su_capture` | write a viewport PNG (workspace-restricted) |
| `su_stop` | quit the bridge-owning SketchUp session |

Task scripts run inside SketchUp (Ruby 2.7) and can use the bundled metric kit:

```ruby
require 'su_kit'
k = SuKit::Kit.new
k.reset                       # empty model + metres
k.tag('01-SOLID', 'C8BFA8')
k.box([0, 0, 0], 1.2, 1.2, 2.0, tag: '01-SOLID')
k.material('MAT-A', 'C8BFA8'); k.paint(k.model.entities[0], 'MAT-A')
k.camera([3, -3, 2], [0.6, 0.6, 1.0], lens: 50); k.zoom_extents
k.capture('preview.png', 1600, 1000)
k.save('model.skp')
$dsh_result = { 'counts' => k.counts, 'bbox_m' => k.bbox_m, 'summary' => k.summary }
```

Kit API: `reset units tag use_tag box cylinder polygon_extrude polyline arc_2d group
erase_all smooth_curves material paint camera zoom_extents dolly_out capture bbox_m
counts summary save export` plus the v1.1 helpers `Chrono box_f seg_box_f cyl_f
sphere_f glass_f edge_hide! text3d white_studio! shadow_setup! frame_view!
sanity_bounds! deep_counts`.

## Hard-won rules (SketchUp 2023 / Ruby 2.7)

- SketchUp 2023 is **Ruby 2.7**: no endless methods (`def x = …`), no rightward assignment.
- Wrap bulk geometry in `model.start_operation('task', true)` … `commit_operation`; without it every `add_face` triggers a transaction/redraw and the build becomes ~100× slower.
- Avoid intersecting primitives (posts through glass, bands through fascia): overlap forces face splitting. Keep parts non-intersecting.
- Split large builds into per-floor / per-part subgroups; a single huge group degrades to O(n²).
- `entities.clear!` (with `!`), not `clear`.
- `model.modified=` does not exist; `cmd_quit` auto-saves to the bridge data folder to avoid modal prompts.
- `add_arc(center, xaxis, NORMAL, radius, a0, a1, segs)` — the third argument is the plane normal (pass `Z_AXIS` for XY).
- `add_3d_text` sizes are in **inches**, and `A * B` transformation means apply B first.
- `Geom::Vector3d` does not support `vector * scalar`; compute components.
- SketchUp's `Array#sum { }` may return nil (plugins override it) — use `inject(0)`.
- Task scripts are pre-compiled by the server: a `SyntaxError` comes back immediately instead of hanging.
- Dense tiny geometry + black edges reads as a black blob at distance — hide edges on glass/louvres: `k.edge_hide!(group, material_names: ['MAT-Glass-Clear'])`.
- Two SketchUp instances: only one can own port 47311. `su_ensure` reuses the bridge if present; otherwise it may launch a new instance.

## Deliverable conventions

- One clear `.skp` deliverable inside the workspace; keep helper scripts under a project folder (e.g. `su-work/<project>/tasks/`).
- Before delivery: read-back validation (`su_run` a validation script or reopen the saved file), `su_capture` + `read_image`, and report dimensions / counts / bbox in the final answer.
- Parameterise task scripts with `$ARGS` (`su_run` `args`) so the model can be re-generated or varied without rewriting code.
