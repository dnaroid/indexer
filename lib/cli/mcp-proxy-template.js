#!/usr/bin/env node
/**
 * MCP Proxy Script for Code Indexer
 *
 * This script establishes a persistent SSE connection with the indexer daemon
 * to support stateful MCP sessions (required for initialize/handshake).
 */

import {spawn} from 'child_process'
import path from 'path'
import http from 'http'
import readline from 'readline'
import fs from 'fs/promises'

// --- Configuration Placeholders ---
const COLLECTION_ID = '__COLLECTION_ID__'
const PROJECT_ROOT = '__PROJECT_ROOT__'
// --------------------------------

const DAEMON_PID_FILE = path.join(process.env.HOME || process.env.USERPROFILE, '.indexer', 'daemon.pid')
const DAEMON_PORT_FILE = path.join(process.env.HOME || process.env.USERPROFILE, '.indexer', 'daemon.port')
const LOG_FILE = path.join(process.env.HOME || process.env.USERPROFILE, '.indexer', 'daemon.log')
const DEBUG_LOG = path.join(process.env.HOME || process.env.USERPROFILE, '.indexer', 'proxy.log')
const DEFAULT_PORT = 34567

async function logDebug(msg) {
  try {
    const time = new Date().toISOString()
    await fs.appendFile(DEBUG_LOG, `[${time}] ${msg}\n`)
  } catch (e) {}
}

// --- Daemon Management ---

async function isCommandAvailable(cmd) {
  try {
    await new Promise((resolve, reject) => {
      const checkCmd = process.platform === 'win32' ? 'where' : 'which'
      const child = spawn(checkCmd, [cmd], {stdio: 'ignore'})
      child.on('close', code => code === 0 ? resolve() : reject())
      child.on('error', reject)
    })
    return true
  } catch (e) {
    return false
  }
}

async function isDaemonRunning() {
  try {
    const pid = parseInt(await fs.readFile(DAEMON_PID_FILE, 'utf8'))
    process.kill(pid, 0)
    return true
  } catch (e) {
    return false
  }
}

async function readDaemonPort() {
  try {
    const portStr = await fs.readFile(DAEMON_PORT_FILE, 'utf8')
    const parsed = parseInt(portStr.trim(), 10)
    return Number.isFinite(parsed) ? parsed : DEFAULT_PORT
  } catch (e) {
    return DEFAULT_PORT
  }
}

async function isDaemonReady(port) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'GET',
      timeout: 1000
    }, (res) => {
      res.resume()
      resolve(true)
    })

    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })

    req.end()
  })
}

async function waitForDaemonReady(port) {
  const maxWait = 20000
  const startTime = Date.now()
  while (Date.now() - startTime < maxWait) {
    if (await isDaemonReady(port)) {
      await logDebug('Daemon HTTP server is ready')
      return
    }
    await new Promise(r => setTimeout(r, 100))
  }
  const errorMsg = `Daemon did not become ready within timeout on port ${port}`
  await logDebug(errorMsg)
  throw new Error(errorMsg)
}

async function startDaemon() {
  await logDebug('Starting indexer daemon...')
  console.error('[MCP Proxy] Starting indexer daemon...')
  const port = await readDaemonPort()

  // Ensure log directory exists
  const logDir = path.dirname(LOG_FILE)
  try {
    await fs.mkdir(logDir, {recursive: true})
  } catch (e) {}

  const out = await fs.open(LOG_FILE, 'a')
  const err = await fs.open(LOG_FILE, 'a')

  // Check if indexer is available globally
  const hasGlobalIndexer = await isCommandAvailable('indexer')
  const cmd = hasGlobalIndexer ? 'indexer' : 'npx'
  const args = hasGlobalIndexer
    ? ['--mcp-http', '--port', String(port)]
    : ['@dnaroid/mcp-code-indexer', '--mcp-http', '--port', String(port)]

  await logDebug(`Using command: ${cmd} ${args.join(' ')}`)

  const child = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', out.fd, err.fd],
    env: process.env
  })
  child.unref()

  const maxWait = 20000
  const startTime = Date.now()
  while (Date.now() - startTime < maxWait) {
    if (await isDaemonRunning()) {
      await logDebug('Daemon started successfully')
      console.error('[MCP Proxy] Daemon started successfully')
      return
    }
    await new Promise(r => setTimeout(r, 100))
  }
  await logDebug('Failed to start daemon within timeout')
  const errorMsg = 'Failed to start indexer daemon. Check logs at: ' + LOG_FILE
  console.error(`[MCP Proxy] ${errorMsg}`)
  console.error('[MCP Proxy] Try running: indexer start-daemon')
  throw new Error(errorMsg)
}

// --- SSE & Message Handling ---

function injectCollectionId(data) {
  try {
    const parsed = JSON.parse(data)
    if (parsed.method === 'tools/call' && parsed.params && parsed.params.arguments) {
      // Always inject collectionId to ensure correct routing
      parsed.params.arguments.collectionId = COLLECTION_ID
      return JSON.stringify(parsed)
    }
    return data
  } catch (e) {
    return data
  }
}

function stripCollectionIdFromSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return
  }

  if (schema.properties && typeof schema.properties === 'object' && schema.properties.collectionId) {
    delete schema.properties.collectionId
  }

  if (Array.isArray(schema.required)) {
    schema.required = schema.required.filter((key) => key !== 'collectionId')
  }
}

function stripCollectionIdFromTool(tool) {
  if (!tool || typeof tool !== 'object') {
    return
  }

  if (tool.inputSchema) {
    stripCollectionIdFromSchema(tool.inputSchema)
  }

  if (tool.input_schema) {
    stripCollectionIdFromSchema(tool.input_schema)
  }
}

function sanitizeMcpResponse(message) {
  if (!message || typeof message !== 'object') {
    return message
  }

  const result = message.result
  if (result && typeof result === 'object') {
    if (Array.isArray(result.tools)) {
      for (const tool of result.tools) {
        stripCollectionIdFromTool(tool)
      }
    }

    if (result.tool && typeof result.tool === 'object') {
      stripCollectionIdFromTool(result.tool)
    }
  }

  return message
}

async function main() {
  await logDebug('Proxy started')
  if (!(await isDaemonRunning())) {
    try {
      await startDaemon()
    } catch (err) {
      await logDebug(`Failed to start daemon: ${err.message}`)
      console.error('[MCP Proxy] Error: Daemon is not running and failed to start automatically')
      console.error('[MCP Proxy] Please start the daemon manually: indexer start-daemon')
      throw err
    }
  } else {
    await logDebug('Daemon already running')
  }

  const port = await readDaemonPort()
  await logDebug(`Daemon running on port ${port}`)
  await waitForDaemonReady(port)

  let sessionId = null  // Session ID received from first initialize response
  let pendingRequests = []  // Queue requests until session is initialized
  let isInitializing = false

  // Handle Stdin -> POST with SSE responses
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false
  })

  function sendRequest(line) {
    try {
      const modifiedBody = injectCollectionId(line)
      const parsed = JSON.parse(modifiedBody)
      const isInitialize = parsed.method === 'initialize'

      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(modifiedBody)
      }

      // Include session ID for all requests except first initialize
      if (sessionId && !isInitialize) {
        headers['mcp-session-id'] = sessionId
      }

      if (isInitialize) {
        isInitializing = true
      }

      const postReq = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers,
        timeout: 15000
      }, (res) => {
        // Extract session ID from initialize response
        if (isInitialize && res.headers['mcp-session-id']) {
          sessionId = res.headers['mcp-session-id']
          isInitializing = false
          logDebug(`Session initialized with ID: ${sessionId}`)

          // Send pending requests
          if (pendingRequests.length > 0) {
            logDebug(`Sending ${pendingRequests.length} pending requests`)
            const requests = pendingRequests.splice(0)
            for (const req of requests) {
              sendRequest(req)
            }
          }
        }

        if (res.statusCode >= 400) {
          logDebug(`POST failed: ${res.statusCode}`)
          let errorBody = ''
          res.on('data', chunk => { errorBody += chunk })
          res.on('end', () => {
            logDebug(`Error response: ${errorBody}`)
            console.error(`[MCP Proxy] POST failed: ${res.statusCode}`)
          })
          return
        }

        // Handle SSE stream response
        if (res.headers['content-type']?.includes('text/event-stream')) {
          let sseBuffer = ''

          res.on('data', (chunk) => {
            sseBuffer += chunk.toString()

            let idx
            while ((idx = sseBuffer.indexOf('\n\n')) !== -1) {
              const message = sseBuffer.substring(0, idx)
              sseBuffer = sseBuffer.substring(idx + 2)

              // Parse SSE message
              const lines = message.split('\n')
              let event = 'message'
              let data = ''

              for (const line of lines) {
                if (line.startsWith('event: ')) {
                  event = line.substring(7).trim()
                } else if (line.startsWith('data: ')) {
                  data += line.substring(6)
                }
              }

              // Forward 'message' events to stdout
              if (event === 'message' && data) {
                try {
                  const json = JSON.parse(data)
                  const sanitized = sanitizeMcpResponse(json)
                  process.stdout.write(JSON.stringify(sanitized) + '\n')
                } catch (e) {
                  logDebug(`Failed to parse SSE data: ${e.message}`)
                }
              }
            }
          })

          res.on('end', () => {
            logDebug('SSE stream ended')
          })
        } else {
          // Handle JSON response (fallback)
          let body = ''
          res.on('data', chunk => { body += chunk })
          res.on('end', () => {
            if (body) {
              try {
                const json = JSON.parse(body)
                const sanitized = sanitizeMcpResponse(json)
                process.stdout.write(JSON.stringify(sanitized) + '\n')
              } catch (e) {
                process.stdout.write(body + '\n')
              }
            }
          })
        }
      })

      postReq.on('error', (err) => {
        logDebug(`POST error: ${err.message}`)
        console.error(`[MCP Proxy] POST error: ${err.message}`)
        console.error(`[MCP Proxy] Make sure the daemon is running. Try: indexer start-daemon`)
      })

      postReq.on('timeout', () => {
        postReq.destroy()
        const errorMsg = 'Daemon connection timeout. The daemon may not be running or is unresponsive.'
        logDebug(errorMsg)
        console.error(`[MCP Proxy] ${errorMsg}`)
        console.error(`[MCP Proxy] Try restarting the daemon: indexer stop-daemon && indexer start-daemon`)
      })

      postReq.write(modifiedBody)
      postReq.end()

    } catch (e) {
      logDebug(`Error processing stdin: ${e.message}`)
      console.error(`[MCP Proxy] Error processing stdin: ${e.message}`)
    }
  }

  rl.on('line', (line) => {
    if (!line.trim()) {
      return
    }

    try {
      const parsed = JSON.parse(line)
      const isInitialize = parsed.method === 'initialize'

      // If not initialized yet and not the initialize request, queue it
      if (!sessionId && !isInitialize && !isInitializing) {
        logDebug(`Queueing request until session is initialized`)
        pendingRequests.push(line)
        return
      }

      // If initializing, queue non-initialize requests
      if (isInitializing && !isInitialize) {
        logDebug(`Queueing request during initialization`)
        pendingRequests.push(line)
        return
      }

      // Send immediately
      sendRequest(line)
    } catch (e) {
      logDebug(`Error parsing request: ${e.message}`)
    }
  })

  rl.on('close', () => {
    logDebug('Stdin closed, exiting')
    process.exit(0)
  })
}

main().catch((err) => {
  logDebug(`Fatal error: ${err.message}`)
  console.error('[MCP Proxy] Fatal error:', err.message)
  process.exit(1)
})
