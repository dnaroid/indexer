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
const LOG_FILE = path.join(process.env.HOME || process.env.USERPROFILE, '.indexer', 'log.txt')
const DEBUG_LOG = path.join(process.env.HOME || process.env.USERPROFILE, '.indexer', 'proxy.log')
const DAEMON_CMD = 'node'
const DAEMON_SCRIPT = path.join(PROJECT_ROOT, 'build', 'lib', 'services', 'indexer-service.js')
const DEFAULT_PORT = 34567

async function logDebug(msg) {
  try {
    const time = new Date().toISOString()
    await fs.appendFile(DEBUG_LOG, `[${time}] ${msg}\n`)
  } catch (e) {}
}

// --- Daemon Management ---

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
    return parseInt(portStr.trim())
  } catch (e) {
    return DEFAULT_PORT
  }
}

async function startDaemon() {
  await logDebug('Starting global indexer daemon...')
  console.error('[MCP Proxy] Starting global indexer daemon...')
  const port = await readDaemonPort()

  // Ensure log directory exists
  const logDir = path.dirname(LOG_FILE)
  try {
    await fs.mkdir(logDir, {recursive: true})
  } catch (e) {}

  const out = await fs.open(LOG_FILE, 'a')
  const err = await fs.open(LOG_FILE, 'a')

  const child = spawn(DAEMON_CMD, [DAEMON_SCRIPT, '--mcp-http', '--port', String(port)], {
    detached: true,
    stdio: ['ignore', out.fd, err.fd],
    env: process.env
  })
  child.unref()

  const maxWait = 10000
  const startTime = Date.now()
  while (Date.now() - startTime < maxWait) {
    if (await isDaemonRunning()) {
      return
    }
    await new Promise(r => setTimeout(r, 100))
  }
  await logDebug('Failed to start daemon')
  throw new Error('Failed to start daemon')
}

// --- SSE & Message Handling ---

function injectCollectionId(data) {
  try {
    const parsed = JSON.parse(data)
    if (parsed.method === 'tools/call' && parsed.params && parsed.params.arguments) {
      // Only inject collectionId if not already provided by client
      if (!parsed.params.arguments.collectionId) {
        parsed.params.arguments.collectionId = COLLECTION_ID
      }
      return JSON.stringify(parsed)
    }
    return data
  } catch (e) {
    return data
  }
}

async function main() {
  await logDebug('Proxy started')
  if (!(await isDaemonRunning())) {
    await startDaemon()
  }

  const port = await readDaemonPort()
  await logDebug(`Daemon running on port ${port}`)

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
        headers
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
                  process.stdout.write(JSON.stringify(json) + '\n')
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
              process.stdout.write(body + '\n')
            }
          })
        }
      })

      postReq.on('error', (err) => {
        logDebug(`POST error: ${err.message}`)
        console.error(`[MCP Proxy] POST error: ${err.message}`)
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
