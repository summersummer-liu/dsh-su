// Shared test harness: installs transient stubs for DSH peer modules, imports
// the plugin entry, applies it to a mock context, and captures registered tools.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PKG = dirname(HERE)
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

export const CONFIG = {
  sketchupExecutable: process.env.SU_EXE || '',
  templatePath: process.env.SU_TEMPLATE || '',
  pluginsDirectory: process.env.SU_PLUGINS || '',
  host: '127.0.0.1',
  port: Number(process.env.SU_PORT || 47311),
  timeoutMs: 180000,
  launchTimeoutMs: 240000,
  maxOutputChars: 20000,
  restrictToWorkspace: true,
  autoInstallExtension: true,
  registerSkill: true,
}

// Tests operate inside the plugin checkout so no personal workspace is needed.
export const WORKSPACE = process.env.DSH_TEST_WORKSPACE || resolve(PKG)

export function execContext() {
  return { signal: undefined, agent: { session: { header: { cwd: WORKSPACE } } } }
}

export async function makeHarness() {
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

  const plugin = await import(`../index.js?harness=${Date.now()}`)
  const tools = new Map()
  const skills = []
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool) } },
    skills: { register(skill) { skills.push(skill) } },
  }
  plugin.apply(ctx, CONFIG)

  return {
    plugin,
    tools,
    skills,
    ctx,
    async cleanup() {
      await rm(NODE_MODULES, { recursive: true, force: true })
    },
  }
}
