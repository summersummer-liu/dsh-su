// ============================================================================
// dsh-su / lib/su-bridge.js
// Pure-Node client for the in-SketchUp DSH Bridge (TCP, JSON lines).
// No SketchUp or DSH dependency here — this file is unit-testable on its own.
// ============================================================================
import net from 'node:net'
import { randomUUID } from 'node:crypto'

export class SuBridgeError extends Error {
  constructor(message, { response = null, cause = undefined } = {}) {
    super(message)
    this.name = 'SuBridgeError'
    this.response = response
    if (cause) this.cause = cause
  }
}

/** One request/response round-trip against the bridge. */
export class SuBridgeClient {
  constructor({ host = '127.0.0.1', port = 47311, timeoutMs = 180000 } = {}) {
    this.host = host
    this.port = port
    this.timeoutMs = timeoutMs
  }

  get endpoint() {
    return `${this.host}:${this.port}`
  }

  call(cmd, params = {}, { timeoutMs } = {}) {
    const request = { id: randomUUID().slice(0, 8), cmd, ...params }
    const payload = Buffer.from(JSON.stringify(request) + '\n', 'utf8')
    const timeout = Math.min(Math.max(1000, Number(timeoutMs) || this.timeoutMs), 2_147_000_000)

    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port })
      let settled = false
      let buffer = ''

      const finish = (error, value) => {
        if (settled) return
        settled = true
        socket.removeAllListeners()
        socket.destroy()
        if (error) reject(error)
        else resolve(value)
      }

      socket.setTimeout(timeout)
      socket.once('connect', () => {
        socket.write(payload)
      })
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline)
        let response
        try {
          response = JSON.parse(line)
        } catch (error) {
          finish(new SuBridgeError(`invalid JSON from bridge: ${line.slice(0, 200)}`, { cause: error }))
          return
        }
        if (response && response.ok) finish(null, response)
        else finish(new SuBridgeError(response?.error || 'bridge command failed', { response }))
      })
      socket.on('timeout', () => {
        finish(new SuBridgeError(`bridge timeout after ${timeout} ms (cmd=${cmd})`))
      })
      socket.on('error', (error) => {
        finish(new SuBridgeError(`cannot reach SketchUp bridge at ${this.endpoint}: ${error.message}`, { cause: error }))
      })
      socket.on('close', () => {
        if (!settled) finish(new SuBridgeError(`bridge closed before replying (cmd=${cmd})`))
      })
    })
  }

  /** Returns the ping payload, or null when the bridge is not reachable. */
  async ping(timeoutMs = 3000) {
    try {
      const response = await this.call('ping', {}, { timeoutMs })
      return response.result ?? {}
    } catch {
      return null
    }
  }

  async alive(timeoutMs = 3000) {
    return (await this.ping(timeoutMs)) !== null
  }

  async info(timeoutMs = 30000) {
    const response = await this.call('info', {}, { timeoutMs })
    return response.result ?? {}
  }

  async setup({ lengthUnit = 4 } = {}, timeoutMs = 30000) {
    const response = await this.call('setup', { length_unit: lengthUnit }, { timeoutMs })
    return response.result ?? {}
  }

  async run(script, args = {}, { timeoutMs } = {}) {
    const response = await this.call('run', { script, args }, { timeoutMs })
    return response.result ?? {}
  }

  async eval(code, { timeoutMs } = {}) {
    const response = await this.call('eval', { code }, { timeoutMs })
    return response.result ?? {}
  }

  async save(path, { timeoutMs } = {}) {
    const response = await this.call('save', { path }, { timeoutMs })
    return response.result ?? {}
  }

  async capture(path, { width = 1600, height = 1100, zoom = true, timeoutMs } = {}) {
    const response = await this.call('capture', { path, width, height, zoom }, { timeoutMs })
    return response.result ?? {}
  }

  async quit(timeoutMs = 10000) {
    try {
      const response = await this.call('quit', {}, { timeoutMs })
      return response.result ?? { quitting: true }
    } catch (error) {
      return { quitting: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
