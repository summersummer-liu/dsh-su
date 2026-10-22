# Smoke script for test/integration.mjs — runs inside SketchUp via the bridge.
require 'su_kit'

k = SuKit::Kit.new
k.reset
k.tag('SMOKE', 'C8BFA8')
k.box([0, 0, 0], 1.2, 1.2, 2.0, tag: 'SMOKE')
k.camera([3.2, -3.2, 2.6], [0.6, 0.6, 1.0], lens: 50)
k.zoom_extents

$dsh_result = {
  'kit' => true,
  'counts' => k.counts,
  'bbox_m' => k.bbox_m,
  'summary' => k.summary
}
