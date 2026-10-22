// ============================================================================
// dsh-su / lib/sketchup-extension.js
// Install the bundled SketchUp extension and launch/wait for SketchUp.
// ============================================================================
import { existsSync, readdirSync } from 'node:fs'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

export const EXTENSION_DIR_NAME = 'dsh_su_bridge'
export const LOADER_NAME = 'dsh_su_bridge.rb'

/** %APPDATA%\SketchUp\SketchUp 2023\SketchUp\Plugins (unless overridden). */
export function defaultPluginsDirectory() {
  const appData = process.env.APPDATA
  if (!appData) return null
  return join(appData, 'SketchUp', 'SketchUp 2023', 'SketchUp', 'Plugins')
}

/** Candidate SketchUp executables, in priority order (env override first). */
export function candidateSketchUpExecutables() {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const localAppData = process.env.LOCALAPPDATA || ''
  const candidates = [
    process.env.SU_EXE,
    'D:\\su\\SketchUp.exe',
    join(programFiles, 'SketchUp', 'SketchUp 2023', 'SketchUp.exe'),
    join(programFilesX86, 'SketchUp', 'SketchUp 2023', 'SketchUp.exe'),
    localAppData ? join(localAppData, 'Programs', 'SketchUp', 'SketchUp 2023', 'SketchUp.exe') : null,
    join(programFiles, 'SketchUp', 'SketchUp 2024', 'SketchUp.exe'),
    join(programFiles, 'SketchUp', 'SketchUp 2025', 'SketchUp.exe'),
  ]
  return candidates.filter((value) => typeof value === 'string' && value.trim() !== '')
}

export function detectSketchUpExecutable() {
  return candidateSketchUpExecutables().find((candidate) => existsSync(candidate)) || null
}

function walkSkpFiles(root, depth, out) {
  if (depth < 0 || !existsSync(root)) return
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const fullPath = join(root, entry.name)
    if (entry.isDirectory()) walkSkpFiles(fullPath, depth - 1, out)
    else if (entry.isFile() && /\.skp$/iu.test(entry.name) && /templates?[\\/]/iu.test(fullPath)) out.push(fullPath)
  }
}

/** Candidate startup templates. SketchUp 2023 defers Ruby plugins on the
 *  welcome screen, so the bridge only loads when a document is opened. */
export function candidateTemplatePaths() {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const localAppData = process.env.LOCALAPPDATA || ''
  const candidates = [process.env.SU_TEMPLATE]
  const roots = [
    join(programFiles, 'SketchUp', 'SketchUp 2023', 'Resources'),
    join(programFilesX86, 'SketchUp', 'SketchUp 2023', 'Resources'),
    localAppData ? join(localAppData, 'Programs', 'SketchUp', 'SketchUp 2023', 'Resources') : null,
    'D:\\su\\resources',
  ].filter(Boolean)
  const localeDirs = ['zh-CN', 'zh-cn', 'en-US', 'en-us', 'en']
  const names = ['Temp01a - Simple.skp', 'Temp01b - Simple.skp', 'Temp02a - Arch.skp', 'Temp02b - Arch.skp']
  for (const root of roots) {
    for (const locale of localeDirs) {
      for (const name of names) candidates.push(join(root, locale, 'Templates', name))
    }
    for (const name of names) candidates.push(join(root, 'Templates', name))
  }
  const filtered = candidates.filter((value) => typeof value === 'string' && value.trim() !== '')
  const direct = filtered.find((candidate) => existsSync(candidate))
  if (direct) return [direct]

  // Fallback: look for any .skp under a *Templates* folder of the known roots.
  const discovered = []
  for (const root of roots) walkSkpFiles(root, 4, discovered)
  return [...new Set([...filtered, ...discovered])]
}

export function detectTemplatePath() {
  return candidateTemplatePaths().find((candidate) => existsSync(candidate)) || null
}

/** %LOCALAPPDATA%\dsh-su (logs, config.json, tmp). */
export function bridgeDataDirectory() {
  const base = process.env.LOCALAPPDATA || process.env.TEMP || process.cwd()
  return join(base, 'dsh-su')
}

/**
 * Copy sketchup/ from the plugin package into SketchUp's Plugins folder.
 * Returns installed/previous versions and all paths involved.
 */
export async function ensureExtension(packageRoot, { pluginsDirectory, force = false } = {}) {
  const targetRoot = resolve(pluginsDirectory || defaultPluginsDirectory() || '')
  if (!targetRoot) throw new Error('cannot detect the SketchUp Plugins folder; set pluginsDirectory')

  const sourceDir = join(packageRoot, 'sketchup', EXTENSION_DIR_NAME)
  const sourceLoader = join(packageRoot, 'sketchup', LOADER_NAME)
  if (!existsSync(sourceDir) || !existsSync(sourceLoader)) {
    throw new Error(`bundled SketchUp extension missing under ${join(packageRoot, 'sketchup')}`)
  }

  const bundledVersion = (await readFile(join(sourceDir, 'VERSION'), 'utf8')).trim()
  const targetDir = join(targetRoot, EXTENSION_DIR_NAME)
  const targetLoader = join(targetRoot, LOADER_NAME)
  const targetVersionFile = join(targetDir, 'VERSION')

  let previousVersion = null
  if (existsSync(targetVersionFile)) previousVersion = (await readFile(targetVersionFile, 'utf8')).trim()
  const needsInstall = force || previousVersion !== bundledVersion || !existsSync(targetLoader)

  if (needsInstall) {
    await mkdir(targetRoot, { recursive: true })
    await cp(sourceDir, targetDir, { recursive: true, force: true })
    await cp(sourceLoader, targetLoader, { force: true })
  }

  return {
    pluginsDirectory: targetRoot,
    extensionDirectory: targetDir,
    loaderPath: targetLoader,
    version: bundledVersion,
    previousVersion,
    installed: needsInstall,
  }
}

/** Write %LOCALAPPDATA%\dsh-su\config.json so the extension uses the same port. */
export async function writeBridgeConfig({ port, dataDirectory = bridgeDataDirectory() }) {
  await mkdir(dataDirectory, { recursive: true })
  const configPath = join(dataDirectory, 'config.json')
  await writeFile(configPath, JSON.stringify({ port }, null, 2), 'utf8')
  return configPath
}

/** True when at least one SketchUp.exe process is running (best effort). */
export function sketchupProcesses() {
  if (process.platform !== 'win32') return []
  const result = spawnSync('tasklist', ['/FI', 'IMAGENAME eq SketchUp.exe', '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  })
  if (result.status !== 0 || typeof result.stdout !== 'string') return []
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('"SketchUp.exe"'))
    .map((line) => line.split('","').map((cell) => cell.replace(/^"|"$/gu, '')))
    .map((cells) => ({ image: cells[0], pid: Number(cells[1]), session: cells[2] }))
    .filter((entry) => Number.isFinite(entry.pid))
}

/** Launch SketchUp directly into a model so plugins load (skips the welcome screen). */
export function launchSketchUp({ executable, templatePath, extraArgs = [] }) {
  if (!executable) throw new Error('sketchupExecutable is not configured')
  const args = []
  if (templatePath) {
    if (!existsSync(templatePath)) throw new Error(`SketchUp template not found: ${templatePath}`)
    args.push(templatePath)
  }
  args.push(...extraArgs)
  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref()
  return { pid: child.pid, executable, templatePath: templatePath || null }
}

/** Poll the bridge until it answers or the deadline passes. */
export async function waitForBridge(client, { launchTimeoutMs = 240000, intervalMs = 1500, signal } = {}) {
  const deadline = Date.now() + launchTimeoutMs
  const debug = process.env.SU_DEBUG === '1'
  let lastError = null
  let attempts = 0
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('cancelled')
    attempts += 1
    try {
      const ping = await client.ping(2500)
      if (ping) {
        if (debug) console.error(`[dsh-su] bridge answered after ${attempts} attempt(s): ${JSON.stringify(ping)}`)
        return ping
      }
      lastError = null
    } catch (error) {
      lastError = error
      if (debug) console.error(`[dsh-su] bridge poll ${attempts} failed: ${error.message}`)
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs))
  }
  throw new Error(
    `SketchUp bridge did not appear within ${Math.round(launchTimeoutMs / 1000)}s` +
      (lastError ? ` (${lastError instanceof Error ? lastError.message : String(lastError)})` : ''),
  )
}

/** Wait until the bridge port stops answering (used by stop). */
export async function waitForBridgeClosed(client, { waitMs = 25000, intervalMs = 750 } = {}) {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (!(await client.alive(1500))) return true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs))
  }
  return !(await client.alive(1500))
}
