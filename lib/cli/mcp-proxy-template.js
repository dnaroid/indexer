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
      parsed.params.arguments.collectionId = COLLECTION_ID
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

  // Current session endpoint (default to /mcp, but SSE should update it)
  let postPath = '/mcp'
  let sseBuffer = ''

  // 1. Establish SSE Connection
  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path: '/sse',
    method: 'GET',
    headers: {
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  }, (res) => {
    if (res.statusCode !== 200) {
      logDebug(`SSE connection failed: ${res.statusCode}`)
      console.error(`[MCP Proxy] Failed to connect to SSE: ${res.statusCode}`)
      process.exit(1)
    }
    logDebug('SSE connected')

    res.on('data', (chunk) => {
      sseBuffer += chunk.toString()

      let idx
      while ((idx = sseBuffer.indexOf('\n\n')) !== -1) {
        const message = sseBuffer.substring(0, idx)
        sseBuffer = sseBuffer.substring(idx + 2)
        processSseMessage(message)
      }
    })

    res.on('end', () => {
      logDebug('SSE connection closed by server')
      console.error('[MCP Proxy] SSE connection closed by server')
      process.exit(0)
    })
  })

  req.on('error', (err) => {
    logDebug(`SSE connection error: ${err.message}`)
    console.error(`[MCP Proxy] SSE connection error: ${err.message}`)
    process.exit(1)
  })

  req.end()

  function processSseMessage(raw) {
    // logDebug(\`Received SSE message: \${raw.substring(0, 50)}...\`)
    const lines = raw.split('\n')
    let event = 'message'
    let data = ''

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        event = line.substring(7).trim()
      } else if (line.startsWith('data: ')) {
        data += line.substring(6)
      }
    }

    if (event === 'endpoint') {
      postPath = data.trim()
      logDebug(`Session initialized. POST endpoint: ${postPath}`)
    } else if (event === 'message') {
      try {
        const json = JSON.parse(data)
        process.stdout.write(JSON.stringify(json) + '\n')
      } catch (e) {
        logDebug(`Failed to parse SSE JSON: ${e.message}`)
      }
    }
  }

  // 2. Handle Stdin -> POST
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  })

  rl.on('line', (line) => {
    if (!line.trim()) {
      return
    }
    // logDebug(\`Stdin received: \${line.substring(0, 50)}...\`)

    try {
      const modifiedBody = injectCollectionId(line)

      const postReq = http.request({
        hostname: '127.0.0.1',
        port,
        path: postPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(modifiedBody)
        }
      }, (res) => {
        if (res.statusCode >= 400) {
          logDebug(`POST failed: ${res.statusCode}`)
          console.error(`[MCP Proxy] POST failed: ${res.statusCode}`)
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
  })
}

main().catch((err) => {
  logDebug(`Fatal error: ${err.message}`)
  console.error('[MCP Proxy] Fatal error:', err.message)
  process.exit(1)
})
