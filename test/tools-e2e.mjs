// End-to-end test of the actual plugin tools (not just the bridge client):
//   su_status -> su_ensure -> su_run -> su_save -> su_capture -> su_status -> su_stop
// Safety: refuses to run while any bridge is answering (never touches a user's
// live document) and uses its own launched SketchUp instance.
//
// Requirements: SketchUp installed (auto-detected or SU_EXE/SU_TEMPLATE set).
// Run with: node test/tools-e2e.mjs
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { makeHarness, execContext, PKG } from './harness.mjs'
import { SuBridgeClient } from '../lib/su-bridge.js'
import { detectSketchUpExecutable, detectTemplatePath } from '../lib/sketchup-extension.js'

const TMP = join(PKG, 'test', 'tmp')
const SKP = join(TMP, 'tools-e2e.skp')
const PNG = join(TMP, 'tools-e2e.png')
const SCRIPT = 'test/fixtures/smoke.rb' // relative to the workspace root (repo checkout)

const step = (message) => console.log(`[e2e] ${message}`)

if (!detectSketchUpExecutable()) {
  throw new Error('SketchUp executable not found; install SketchUp or set SU_EXE')
}
const probe = new SuBridgeClient({ port: Number(process.env.SU_PORT || 47311) })
if (await probe.alive(2000)) {
  throw new Error("a bridge is already running; refusing to reset a user's live document")
}

await mkdir(TMP, { recursive: true })
await rm(SKP, { force: true })
await rm(PNG, { force: true })
const { tools, cleanup } = await makeHarness()
const exec = execContext()

try {
  step('1/8 su_status (before) — expect unavailable')
  const statusBefore = await tools.get('su_status').execute({}, exec)
  assert.equal(statusBefore.available, false)
  assert.equal(typeof statusBefore.hint, 'string')

  step('2/8 su_ensure — install extension + launch SketchUp + wait for bridge')
  const ensured = await tools.get('su_ensure').execute({}, exec)
  assert.equal(ensured.reused, false)
  assert.ok(ensured.launched?.pid)
  assert.equal(ensured.info.has_model, true)
  assert.equal(ensured.setup?.length_unit, 4)
  assert.equal(ensured.extension.upToDate, true)
  assert.equal(typeof ensured.note, 'string')
  step(`   launched pid=${ensured.launched.pid} note="${ensured.note}"`)

  step('3/8 su_run — smoke script inside SketchUp')
  const run = await tools.get('su_run').execute({ script: SCRIPT, args: { demo: 'e2e' } }, exec)
  assert.equal(run.result?.kit, true)
  assert.equal(run.result?.counts?.faces, 6)
  assert.equal(run.result?.bbox_m?.size?.[2], 2)

  step('4/8 su_run path restriction')
  await assert.rejects(
    () => tools.get('su_run').execute({ script: 'C:\\Windows\\win.ini' }, exec),
    /workspace|does not exist/u,
  )

  step('5/8 su_save + no-overwrite guard')
  const saved = await tools.get('su_save').execute({ output_path: 'test/tmp/tools-e2e.skp' }, exec)
  assert.equal(saved.saved, true)
  assert.equal(saved.path, SKP)
  assert.ok(saved.bytes > 5_000)
  await assert.rejects(
    () => tools.get('su_save').execute({ output_path: 'test/tmp/tools-e2e.skp' }, exec),
    /already exists/u,
  )

  step('6/8 su_capture — viewport PNG')
  const captured = await tools.get('su_capture').execute(
    { output_path: 'test/tmp/tools-e2e.png', width: 1024, height: 768 },
    exec,
  )
  assert.equal(captured.imagePath, PNG)
  assert.ok(captured.bytes > 5_000)

  step('7/8 su_status (during) — expect available')
  const statusDuring = await tools.get('su_status').execute({}, exec)
  assert.equal(statusDuring.available, true)
  assert.equal(statusDuring.model?.title, 'tools-e2e') // saving renames the document

  step('8/8 su_stop — quit the test instance')
  const stopped = await tools.get('su_stop').execute({ wait_ms: 30000 })
  assert.equal(stopped.closed, true)

  const skpInfo = await stat(SKP)
  const pngInfo = await stat(PNG)
  await readFile(PNG) // readable

  console.log(JSON.stringify({
    ok: true,
    ensured: {
      pid: ensured.launched.pid,
      note: ensured.note,
      existingProcesses: ensured.existingProcesses.map((entry) => entry.pid),
      extension: ensured.extension.installedVersion,
    },
    run: { faces: run.result.counts.faces, bbox: run.result.bbox_m.size, elapsedMs: run.elapsedMs },
    saved: { path: SKP, bytes: skpInfo.size },
    captured: { path: PNG, bytes: pngInfo.size },
    statusDuring: { available: statusDuring.available, model: statusDuring.model.title },
    stopped,
  }, null, 2))
} finally {
  // Never leave a test SketchUp instance behind, even when an assertion fails.
  try {
    if (await probe.alive(1500)) await tools.get('su_stop').execute({ wait_ms: 30000 })
  } catch {
    // ignore cleanup failures
  }
  await cleanup()
}

export { existsSync, detectTemplatePath }
