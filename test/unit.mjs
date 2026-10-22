// Unit test: module shape, tool registration, skill registration, pure helpers.
// Uses transient stubs for the DSH-provided peer modules.
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = dirname(HERE)
const NODE_MODULES = join(PKG, 'node_modules')
const STUB_ROOT = join(NODE_MODULES, '@deepseek-ai')

const DSH_TOOLS_STUB = `export function defineTool(def) { return { ...def, __isTool: true } }\n`
const SCHEMA_STUB = `
function chain(type) {
  const s = {
    type,
    default(v) { s.defaultValue = v; return s },
    description(d) { s.description = d; return s },
    items(i) { s.items = i; return s },
  }
  return s
}
const Schema = {
  object: (shape) => ({ type: 'object', shape }),
  string: () => chain('string'),
  number: () => chain('number'),
  integer: () => chain('integer'),
  boolean: () => chain('boolean'),
  array: (item) => ({ type: 'array', item }),
}
export default Schema
`

async function installStubs() {
  await rm(NODE_MODULES, { recursive: true, force: true })
  await mkdir(join(STUB_ROOT, 'dsh-tools'), { recursive: true })
  await mkdir(join(STUB_ROOT, 'schemastery'), { recursive: true })
  await writeFile(
    join(STUB_ROOT, 'dsh-tools', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0-test', type: 'module', main: 'index.js' }),
  )
  await writeFile(join(STUB_ROOT, 'dsh-tools', 'index.js'), DSH_TOOLS_STUB)
  await writeFile(
    join(STUB_ROOT, 'schemastery', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/schemastery', version: '0.0.0-test', type: 'module', main: 'index.js' }),
  )
  await writeFile(join(STUB_ROOT, 'schemastery', 'index.js'), SCHEMA_STUB)
}

const EXPECTED_TOOLS = [
  'su_status',
  'su_install_extension',
  'su_ensure',
  'su_run',
  'su_eval',
  'su_save',
  'su_capture',
  'su_stop',
]

const CONFIG = {
  sketchupExecutable: 'D:\\su\\SketchUp.exe',
  templatePath: 'D:\\su\\resources\\zh-cn\\Templates\\Temp01a - Simple.skp',
  pluginsDirectory: '',
  host: '127.0.0.1',
  port: 47311,
  timeoutMs: 180000,
  launchTimeoutMs: 240000,
  maxOutputChars: 20000,
  restrictToWorkspace: true,
  autoInstallExtension: true,
  registerSkill: true,
}

await installStubs()
try {
  const plugin = await import(`../index.js?unit=${Date.now()}`)

  assert.equal(plugin.name, 'su-modeling')
  assert.deepEqual(plugin.inject, ['tools', 'skills'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.Config, 'object')

  const tools = []
  const skills = []
  const ctx = {
    tools: { register(tool) { tools.push(tool) } },
    skills: { register(skill) { skills.push(skill) } },
  }
  plugin.apply(ctx, CONFIG)

  assert.deepEqual(tools.map((tool) => tool.name), EXPECTED_TOOLS, 'registered tool names')
  for (const tool of tools) {
    assert.equal(tool.__isTool, true)
    assert.equal(typeof tool.execute, 'function', `${tool.name} executes`)
    assert.equal(typeof tool.parameters, 'object', `${tool.name} has parameters`)
    assert.equal(typeof tool.output.render, 'function', `${tool.name} has renderer`)
    assert.equal(tool.output.schema.type, 'object', `${tool.name} output schema`)
  }

  assert.equal(skills.length, 1, 'one bundled skill')
  assert.equal(skills[0].name, 'sketchup-modeling')
  assert.equal(skills[0].provider, 'dsh-su')
  assert.equal(skills[0].source, 'bundled')
  assert.ok(skills[0].description.length > 40)
  assert.ok(skills[0].content.includes('su_kit'))

  // pure path helpers
  const { isWithin, sessionWorkspace, extensionState } = plugin.internals
  const ws = resolve('C:\\test-workspace')
  assert.equal(isWithin(ws, resolve(ws, 'nested', 'file.skp')), true)
  assert.equal(isWithin(ws, resolve(ws, '..', 'outside.skp')), false)
  assert.equal(sessionWorkspace({ agent: { session: { header: { cwd: ws } } } }), ws)

  // extension metadata (no install side effects)
  const ext = await extensionState({ pluginsDirectory: resolve('C:\\definitely-missing-plugins-dir') })
  assert.equal(ext.bundledVersion, plugin.internals.PACKAGE_VERSION)
  assert.equal(ext.installedVersion, null)
  assert.equal(ext.upToDate, false)

  console.log(JSON.stringify({
    ok: true,
    plugin: plugin.name,
    version: plugin.internals.PACKAGE_VERSION,
    tools: tools.map((tool) => tool.name),
    skill: skills[0].name,
  }, null, 2))
} finally {
  await rm(NODE_MODULES, { recursive: true, force: true })
}
