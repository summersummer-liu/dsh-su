// Integration test: real SketchUp instance, real bridge, save + capture.
// Safety: refuses to run when a bridge is already answering, because the smoke
// script resets the document (it must never touch a user's open model).
//
// Requirements: SketchUp installed (auto-detected or SU_EXE/SU_TEMPLATE set).
// Run with: node test/integration.mjs
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SuBridgeClient } from '../lib/su-bridge.js'
import {
  ensureExtension,
  writeBridgeConfig,
  launchSketchUp,
  waitForBridge,
  waitForBridgeClosed,
  sketchupProcesses,
  defaultPluginsDirectory,
  detectSketchUpExecutable,
  detectTemplatePath,
} from '../lib/sketchup-extension.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = dirname(HERE)
const TMP = join(HERE, 'tmp')

const SKETCHUP = process.env.SU_EXE || detectSketchUpExecutable()
const TEMPLATE = process.env.SU_TEMPLATE || detectTemplatePath()
const PORT = Number(process.env.SU_PORT || 47311)

if (!existsSync(SKETCHUP)) throw new Error('SketchUp executable not found; install SketchUp or set SU_EXE')
if (!TEMPLATE || !existsSync(TEMPLATE)) throw new Error('SketchUp template not found; set SU_TEMPLATE to a .skp template')

await mkdir(TMP, { recursive: true })
const SKP = join(TMP, 'dsh-su-smoke.skp')
const PNG = join(TMP, 'dsh-su-smoke.png')
const SCRIPT = join(HERE, 'fixtures', 'smoke.rb')
await readFile(SCRIPT, 'utf8') // ensure fixture exists

const client = new SuBridgeClient({ port: PORT })
if (await client.alive(2000)) {
  throw new Error(`a bridge is already running on ${client.endpoint}; refusing to reset a user's live document`)
}

const install = await ensureExtension(PKG, { pluginsDirectory: defaultPluginsDirectory(), force: true })
const configPath = await writeBridgeConfig({ port: PORT })
const launched = launchSketchUp({ executable: SKETCHUP, templatePath: TEMPLATE })
const started = Date.now()
const ping = await waitForBridge(client, { launchTimeoutMs: 240000 })
const info = await client.info()
const setup = await client.setup({ lengthUnit: 4 })
const run = await client.run(SCRIPT)
const saved = await client.save(SKP)
const captured = await client.capture(PNG, { width: 1280, height: 900 })
const skpInfo = await stat(SKP)
const pngInfo = await stat(PNG)

assert.equal(saved.exists, true, 'skp written')
assert.ok(skpInfo.size > 5_000, 'skp is not empty')
assert.equal(captured.exists, true, 'png written')
assert.ok(pngInfo.size > 5_000, 'png is not empty')
assert.equal(run.result?.kit, true, 'su_kit loaded inside SketchUp')

const quit = await client.quit()
const closed = await waitForBridgeClosed(client, { waitMs: 30000 })

console.log(JSON.stringify({
  ok: true,
  endpoint: client.endpoint,
  install,
  configPath,
  launched,
  processesBeforeLaunch: sketchupProcesses().length,
  bootMs: Date.now() - started,
  ping,
  model: info.model?.title,
  setup,
  run: { elapsedMs: run.elapsed_ms, result: run.result },
  saved: { path: SKP, bytes: skpInfo.size },
  captured: { path: PNG, bytes: pngInfo.size },
  quit,
  closed,
}, null, 2))
