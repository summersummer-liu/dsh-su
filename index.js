// ============================================================================
// dsh-su — DeepSeek Harness ↔ SketchUp bridge plugin
// ----------------------------------------------------------------------------
// Provides DSH tools that drive a live SketchUp session over the bundled
// "DSH Bridge" SketchUp extension (TCP JSON lines, default 127.0.0.1:47311).
//
// Tools: su_status, su_install_extension, su_ensure, su_run, su_eval,
//        su_save, su_capture, su_stop
// Skill: sketchup-modeling (bundled)
// ============================================================================
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

import { SuBridgeClient } from './lib/su-bridge.js'
import {
  ensureExtension,
  writeBridgeConfig,
  sketchupProcesses,
  launchSketchUp,
  waitForBridge,
  waitForBridgeClosed,
  defaultPluginsDirectory,
  bridgeDataDirectory,
  candidateSketchUpExecutables,
  candidateTemplatePaths,
  detectSketchUpExecutable,
  detectTemplatePath,
  EXTENSION_DIR_NAME,
  LOADER_NAME,
} from './lib/sketchup-extension.js'

export const name = 'su-modeling'
export const inject = ['tools', 'skills']

export const Config = Schema.object({
  sketchupExecutable: Schema.string().default(''),
  templatePath: Schema.string().default(''),
  pluginsDirectory: Schema.string().default(''),
  host: Schema.string().default('127.0.0.1'),
  port: Schema.number().default(47311),
  timeoutMs: Schema.number().default(180000),
  launchTimeoutMs: Schema.number().default(240000),
  maxOutputChars: Schema.number().default(20000),
  restrictToWorkspace: Schema.boolean().default(true),
  autoInstallExtension: Schema.boolean().default(true),
  registerSkill: Schema.boolean().default(true),
})

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))
const PACKAGE_VERSION = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version
const SKILL_ROOT = join(PACKAGE_ROOT, 'skills', 'sketchup-modeling')
const SKILL_PATH = join(SKILL_ROOT, 'SKILL.md')

const renderJson = (_args, value) => JSON.stringify(value, null, 2)

function clip(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max)}\n… (${value.length - max} chars truncated)`
}

function assertConfig(config) {
  for (const key of ['port', 'timeoutMs', 'launchTimeoutMs', 'maxOutputChars']) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) {
      throw new Error(`su-modeling: ${key} must be a positive finite number`)
    }
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('su-modeling: port must be an integer in 1..65535')
  }
  for (const key of ['sketchupExecutable', 'templatePath', 'pluginsDirectory', 'host']) {
    if (typeof config[key] !== 'string') throw new Error(`su-modeling: ${key} must be a string`)
  }
}

/** Resolve SketchUp executable + startup template: explicit config wins,
 *  otherwise common install locations are probed. */
function resolveRuntimePaths(config) {
  const configuredExecutable = config.sketchupExecutable.trim()
  const configuredTemplate = config.templatePath.trim()
  const executable = configuredExecutable || detectSketchUpExecutable() || ''
  const templatePath = configuredTemplate || detectTemplatePath() || ''
  return {
    executable,
    templatePath,
    executableSource: configuredExecutable ? 'config' : executable ? 'auto-detected' : 'missing',
    templateSource: configuredTemplate ? 'config' : templatePath ? 'auto-detected' : 'missing',
    candidates: {
      executables: candidateSketchUpExecutables(),
      templates: candidateTemplatePaths().slice(0, 12),
    },
  }
}

// ---- workspace helpers (same policy as dsh-blender) -------------------------
function sessionWorkspace(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return resolve(typeof cwd === 'string' && cwd.trim() !== '' ? cwd : process.cwd())
}

function isWithin(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel))
}

async function resolveWorkspacePath(rawPath, exec, config, { mustExist = false, kind = 'path' } = {}) {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') throw new Error(`${kind} must be a non-empty string`)
  const workspace = sessionWorkspace(exec)
  const target = resolve(isAbsolute(rawPath) ? rawPath : join(workspace, rawPath))
  if (config.restrictToWorkspace && !isWithin(workspace, target)) {
    throw new Error(`${kind} must stay inside the dsh session workspace: ${workspace}`)
  }
  if (mustExist) {
    const info = await stat(target).catch(() => null)
    if (info === null) throw new Error(`${kind} does not exist: ${target}`)
    if (!info.isFile()) throw new Error(`${kind} must be a regular file: ${target}`)
  }
  return target
}

async function assertWritableTarget(target, allowOverwrite, kind) {
  const info = await stat(target).catch(() => null)
  if (info !== null && !allowOverwrite) {
    throw new Error(`${kind} already exists: ${target} (pass allow_overwrite=true to replace it)`)
  }
  await mkdir(dirname(target), { recursive: true })
}

// ---- bridge / extension helpers --------------------------------------------
function makeClient(config) {
  return new SuBridgeClient({ host: config.host, port: config.port, timeoutMs: config.timeoutMs })
}

/** Retry a bridge call a few times so a rebooting/closing SketchUp cannot turn
 *  a transient ECONNRESET into a hard plugin failure. */
async function retryTransient(fn, attempts = 3, delayMs = 800) {
  let last = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      last = error
      if (attempt < attempts - 1) await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs))
    }
  }
  throw last
}

async function bundledVersion() {
  return (await readFile(join(PACKAGE_ROOT, 'sketchup', EXTENSION_DIR_NAME, 'VERSION'), 'utf8')).trim()
}

async function extensionState(config) {
  const pluginsDirectory = config.pluginsDirectory || defaultPluginsDirectory()
  const version = await bundledVersion()
  let installedVersion = null
  if (pluginsDirectory) {
    try {
      installedVersion = (await readFile(join(pluginsDirectory, EXTENSION_DIR_NAME, 'VERSION'), 'utf8')).trim()
    } catch {
      installedVersion = null
    }
  }
  return {
    packageVersion: PACKAGE_VERSION,
    bundledVersion: version,
    installedVersion,
    upToDate: installedVersion !== null && installedVersion === version,
    pluginsDirectory,
    extensionDirectory: pluginsDirectory ? join(pluginsDirectory, EXTENSION_DIR_NAME) : null,
    loaderPath: pluginsDirectory ? join(pluginsDirectory, LOADER_NAME) : null,
    dataDirectory: bridgeDataDirectory(),
  }
}

async function ensureSession(config, exec, { fresh = false, installExtension = true, launch = true } = {}) {
  const client = makeClient(config)
  const existing = sketchupProcesses()
  let install = null
  const before = await extensionState(config)
  if (installExtension && !before.upToDate) {
    install = await ensureExtension(PACKAGE_ROOT, { pluginsDirectory: before.pluginsDirectory })
  }
  await writeBridgeConfig({ port: config.port })

  let reused = false
  let launched = null
  let ping = await client.ping()
  if (!ping) {
    if (!launch) {
      const detail = existing.length
        ? `SketchUp is open (pid ${existing.map((entry) => entry.pid).join(', ')}) but this instance has no bridge — restart SketchUp so the extension loads, or call su_ensure again with launch enabled.`
        : 'Launch SketchUp with su_ensure (or open it manually; the extension auto-starts the bridge).'
      throw new Error(`SketchUp bridge is not running at ${client.endpoint}. ${detail}`)
    }
    launched = await (async () => {
      const paths = resolveRuntimePaths(config)
      if (!paths.executable) {
        throw new Error(
          'SketchUp executable not found. Set sketchupExecutable in the dsh-su plugin config ' +
            '(or the SU_EXE environment variable).',
        )
      }
      if (!existsSync(paths.executable)) throw new Error(`SketchUp executable does not exist: ${paths.executable}`)
      if (paths.templatePath && !existsSync(paths.templatePath)) {
        throw new Error(`SketchUp startup template does not exist: ${paths.templatePath}`)
      }
      return launchSketchUp({ executable: paths.executable, templatePath: paths.templatePath })
    })()
    ping = await waitForBridge(client, { launchTimeoutMs: config.launchTimeoutMs, signal: exec?.signal })
  } else {
    reused = true
  }

  const info = await retryTransient(() => client.info())
  let setup = null
  if (info.has_model) setup = await retryTransient(() => client.setup({ lengthUnit: 4 }))
  if (fresh && info.has_model) await client.call('reset', {}, { timeoutMs: 30000 })
  const finalInfo = fresh && info.has_model ? await client.info() : info

  const note = reused
    ? 'Reused the already-running bridge session.'
    : existing.length > 0
      ? `Started a new SketchUp instance (pid ${launched?.pid}) because ${existing.length} already-running instance(s) had no bridge. Restart those instances if you want them to host the bridge instead.`
      : `Launched SketchUp (pid ${launched?.pid}) with the configured template.`

  return {
    endpoint: client.endpoint,
    reused,
    launched,
    note,
    existingProcesses: existing,
    install,
    extension: await extensionState(config),
    setup,
    ping,
    info: finalInfo,
  }
}

// ---- skill registration -----------------------------------------------------
function readSkillDefinition(path) {
  const raw = readFileSync(path, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(raw)
  if (match === null) throw new Error(`su-modeling: invalid skill frontmatter at ${path}`)
  const nameMatch = /^name:\s*(.+)$/mu.exec(match[1])
  const descriptionMatch = /^description:\s*(.+)$/mu.exec(match[1])
  if (nameMatch === null || descriptionMatch === null) {
    throw new Error(`su-modeling: skill requires name and description at ${path}`)
  }
  return { name: nameMatch[1].trim(), description: descriptionMatch[1].trim(), content: match[2].trim() }
}

function registerSkills(ctx, config) {
  if (!config.registerSkill) return
  const definition = readSkillDefinition(SKILL_PATH)
  ctx.skills.register({
    ...definition,
    source: 'bundled',
    provider: 'dsh-su',
    resourceBase: { kind: 'directory', path: SKILL_ROOT },
  })
}

// ---- tool factory -----------------------------------------------------------
function createTools(config) {
  const tools = []

  tools.push(defineTool({
    name: 'su_status',
    description: 'Check the SketchUp ↔ DSH bridge: whether SketchUp is reachable on the bridge port, the active model, installed extension version, and configured paths. Call this first.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          available: { type: 'boolean', required: true },
          endpoint: { type: 'string', required: true },
          bridge: { type: 'json', required: true },
          model: { type: 'json', required: true },
          sketchup: { type: 'json', required: true },
          extension: { type: 'json', required: true },
          hint: { type: 'string', required: true },
          workspaceRoot: { type: 'string', required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const client = makeClient(config)
      const ping = await client.ping()
      let info = null
      if (ping !== null) {
        try {
          info = await client.info()
        } catch {
          info = null
        }
      }
      const processes = sketchupProcesses()
      const runtime = resolveRuntimePaths(config)
      const hint = ping !== null
        ? 'Bridge reachable; SketchUp can be driven now.'
        : processes.length > 0
          ? `SketchUp is open (pid ${processes.map((entry) => entry.pid).join(', ')}) but this instance has no bridge. Restart it so the DSH Bridge extension loads, then call su_status again (or call su_ensure to start a bridge-capable instance).`
          : !runtime.executable
            ? `SketchUp executable not found. Set sketchupExecutable in the plugin config. Probed: ${runtime.candidates.executables.join(' | ')}`
            : 'SketchUp is not running. Call su_ensure to install/update the extension and launch it.'
      return {
        available: ping !== null,
        endpoint: client.endpoint,
        bridge: ping,
        model: info?.model ?? null,
        sketchup: {
          executable: runtime.executable,
          executableSource: runtime.executableSource,
          templatePath: runtime.templatePath,
          templateSource: runtime.templateSource,
          processes,
          ...(runtime.executable ? {} : { candidates: runtime.candidates }),
        },
        extension: await extensionState(config),
        hint,
        workspaceRoot: sessionWorkspace(exec),
      }
    },
  }))

  tools.push(defineTool({
    name: 'su_install_extension',
    description: 'Copy the bundled "DSH Bridge" SketchUp extension into SketchUp\'s Plugins folder (and update it when the version changed). A SketchUp instance that is already open must be restarted before the extension loads.',
    parameters: {
      force: { type: 'boolean', description: 'Reinstall even when the installed version already matches. Defaults to false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          installed: { type: 'boolean', required: true },
          version: { type: 'string', required: true },
          previousVersion: { type: 'json', required: true },
          pluginsDirectory: { type: 'string', required: true },
          loaderPath: { type: 'string', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const result = await ensureExtension(PACKAGE_ROOT, {
        pluginsDirectory: config.pluginsDirectory || defaultPluginsDirectory(),
        force: args.force === true,
      })
      return {
        installed: result.installed,
        version: result.version,
        previousVersion: result.previousVersion,
        pluginsDirectory: result.pluginsDirectory,
        loaderPath: result.loaderPath,
        note: result.installed
          ? 'Extension files written. Restart SketchUp if it is open; the bridge then starts automatically.'
          : 'Installed version already matches the bundled extension.',
      }
    },
  }))

  tools.push(defineTool({
    name: 'su_ensure',
    description: 'Ensure a bridge-capable SketchUp session: install/update the extension, reuse a running bridge, or launch SketchUp with the configured template and wait for the bridge. Sets document units to metres. Call before any modeling task.',
    parameters: {
      fresh: { type: 'boolean', description: 'Reset the active document to an empty model after connecting (destructive; only with explicit intent).' },
      install_extension: { type: 'boolean', description: 'Install/update the bundled extension before connecting. Defaults to true.' },
      launch: { type: 'boolean', description: 'Launch SketchUp when the bridge is not running. Defaults to true.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          endpoint: { type: 'string', required: true },
          reused: { type: 'boolean', required: true },
          launched: { type: 'json', required: true },
          note: { type: 'string', required: true },
          existingProcesses: { type: 'json', required: true },
          install: { type: 'json', required: true },
          extension: { type: 'json', required: true },
          setup: { type: 'json', required: true },
          info: { type: 'json', required: true },
          workspaceRoot: { type: 'string', required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const session = await ensureSession(config, exec, {
        fresh: args.fresh === true,
        installExtension: args.install_extension !== false,
        launch: args.launch !== false,
      })
      return { ...session, workspaceRoot: sessionWorkspace(exec) }
    },
  }))

  tools.push(defineTool({
    name: 'su_run',
    description: 'Run a Ruby task script inside the live SketchUp session through the bridge. The script should `require \'su_kit\'` for metric modelling helpers and may set `$dsh_result` (JSON-safe) to return evidence. Returns the script result and elapsed time.',
    parameters: {
      script: { type: 'string', required: true, description: 'Absolute path (or workspace-relative) to a .rb script inside the dsh workspace.' },
      args: { type: 'json', description: 'Optional hash of arguments exposed to the script as $ARGS (string keys/values).' },
      timeout_ms: { type: 'integer', description: 'Bridge timeout in milliseconds; defaults to the plugin timeoutMs.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          script: { type: 'string', required: true },
          elapsedMs: { type: 'number', required: true },
          result: { type: 'json', required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const script = await resolveWorkspacePath(args.script, exec, config, { mustExist: true, kind: 'script' })
      if (extname(script).toLowerCase() !== '.rb') throw new Error('script must end in .rb')
      const client = makeClient(config)
      const response = await client.run(script, args.args ?? {}, {
        timeoutMs: args.timeout_ms ?? config.timeoutMs,
      })
      return {
        script,
        elapsedMs: typeof response.elapsed_ms === 'number' ? response.elapsed_ms : 0,
        result: response.result ?? null,
      }
    },
  }))

  tools.push(defineTool({
    name: 'su_eval',
    description: 'Evaluate a Ruby snippet inside the live SketchUp session and return `$dsh_result` (JSON-safe). Use for inspection and small edits; prefer su_run for multi-step modelling tasks.',
    parameters: {
      code: { type: 'string', required: true, description: 'Ruby code executed at SketchUp top level. Assign $dsh_result to return data.' },
      timeout_ms: { type: 'integer', description: 'Bridge timeout in milliseconds; defaults to the plugin timeoutMs.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          elapsedMs: { type: 'number', required: true },
          result: { type: 'json', required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.code.trim() === '') throw new Error('code must not be empty')
      const client = makeClient(config)
      const response = await client.eval(args.code, { timeoutMs: args.timeout_ms ?? config.timeoutMs })
      return {
        elapsedMs: typeof response.elapsed_ms === 'number' ? response.elapsed_ms : 0,
        result: response.result ?? null,
      }
    },
  }))

  tools.push(defineTool({
    name: 'su_save',
    description: 'Save the active SketchUp document as a .skp file inside the dsh workspace. Refuses to overwrite an existing file unless allow_overwrite is true.',
    parameters: {
      output_path: { type: 'string', required: true, description: 'New .skp path (workspace-relative or absolute inside the workspace).' },
      allow_overwrite: { type: 'boolean', description: 'Allow replacing an existing .skp. Defaults to false.' },
      timeout_ms: { type: 'integer', description: 'Bridge timeout in milliseconds.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          saved: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const target = await resolveWorkspacePath(args.output_path, exec, config, { kind: 'output_path' })
      if (extname(target).toLowerCase() !== '.skp') throw new Error('output_path must end in .skp')
      await assertWritableTarget(target, args.allow_overwrite === true, 'output_path')
      const client = makeClient(config)
      const response = await client.save(target, { timeoutMs: args.timeout_ms ?? config.timeoutMs })
      const info = await stat(target).catch(() => null)
      return {
        path: target,
        bytes: info?.size ?? 0,
        saved: response.saved === true && info !== null,
      }
    },
  }))

  tools.push(defineTool({
    name: 'su_capture',
    description: 'Write a PNG screenshot of the active SketchUp viewport. Call read_image on imagePath afterwards to actually inspect the result.',
    parameters: {
      output_path: { type: 'string', required: true, description: 'New .png path inside the workspace.' },
      width: { type: 'integer', description: 'Image width in pixels; defaults to 1600.' },
      height: { type: 'integer', description: 'Image height in pixels; defaults to 1100.' },
      zoom: { type: 'boolean', description: 'Zoom-extents before capture. Defaults to true.' },
      allow_overwrite: { type: 'boolean', description: 'Allow replacing an existing image. Defaults to false.' },
      timeout_ms: { type: 'integer', description: 'Bridge timeout in milliseconds.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          imagePath: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const target = await resolveWorkspacePath(args.output_path, exec, config, { kind: 'output_path' })
      if (!['.png', '.jpg', '.jpeg'].includes(extname(target).toLowerCase())) {
        throw new Error('output_path must end in .png, .jpg or .jpeg')
      }
      await assertWritableTarget(target, args.allow_overwrite === true, 'output_path')
      const client = makeClient(config)
      const width = args.width ?? 1600
      const height = args.height ?? 1100
      await client.capture(target, { width, height, zoom: args.zoom !== false, timeoutMs: args.timeout_ms ?? config.timeoutMs })
      const info = await stat(target).catch(() => null)
      return { imagePath: target, bytes: info?.size ?? 0, width, height }
    },
  }))

  tools.push(defineTool({
    name: 'su_stop',
    description: 'Quit the SketchUp session that owns the bridge (prompts are suppressed by auto-saving to the bridge data folder).',
    parameters: {
      wait_ms: { type: 'integer', description: 'Milliseconds to wait for the port to close; defaults to 25000.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          closed: { type: 'boolean', required: true },
          alreadyStopped: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const client = makeClient(config)
      if (!(await client.alive(2000))) return { closed: true, alreadyStopped: true }
      const quit = await client.quit()
      const closed = await waitForBridgeClosed(client, { waitMs: args.wait_ms ?? 25000 })
      return { closed, alreadyStopped: false, quit }
    },
  }))

  return tools
}

export function apply(ctx, config) {
  assertConfig(config)
  registerSkills(ctx, config)
  for (const tool of createTools(config)) ctx.tools.register(tool)
}

export const internals = {
  createTools,
  ensureSession,
  extensionState,
  sessionWorkspace,
  resolveWorkspacePath,
  isWithin,
  PACKAGE_ROOT,
  PACKAGE_VERSION,
}
