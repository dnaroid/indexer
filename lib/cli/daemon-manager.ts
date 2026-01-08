import fs from 'fs'
import fsPromises from 'fs/promises'
import path from 'path'
import { spawn } from 'child_process'
import { getDaemonPidFilePath, DEFAULT_SETTINGS, getLogFilePath } from '../utils/config-global.js'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Get the port the daemon is listening on
 * @returns Port number
 */
export async function getDaemonPort(): Promise<number> {
  const pidFile = getDaemonPidFilePath()
  const portFile = path.join(path.dirname(pidFile), 'daemon.port')

  try {
    const portStr = await fsPromises.readFile(portFile, 'utf8')
    return parseInt(portStr.trim(), 10)
  } catch (e) {
    return DEFAULT_SETTINGS.SERVICE_PORT
  }
}

/**
 * Check if the indexer daemon is currently running
 * @returns True if daemon is running
 */
export async function isDaemonRunning(): Promise<boolean> {
  // Check global PID file first (used by indexer-service.js)
  const globalPidFile = getDaemonPidFilePath()

  try {
    await fsPromises.access(globalPidFile)
    const pid = parseInt(await fsPromises.readFile(globalPidFile, 'utf8'), 10)
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    // Global daemon not running
  }

  return false
}

/**
 * Ensure the indexer daemon is running, starting it if necessary
 */
export async function ensureDaemonRunning(): Promise<void> {
  if (await isDaemonRunning()) {
    return
  }

  console.error('[indexer] Starting global indexer daemon...')
  
  const daemonScript = path.resolve(__dirname, '../services/indexer-service.js')
  const port = await getDaemonPort()
  const logFile = getLogFilePath()

  // Ensure log directory exists
  const logDir = path.dirname(logFile)
  await fsPromises.mkdir(logDir, { recursive: true })

  const out = fs.openSync(logFile, 'a')
  const err = fs.openSync(logFile, 'a')

  const child = spawn('node', [daemonScript, '--mcp-http', '--port', String(port)], {
    detached: true,
    stdio: ['ignore', out, err],
    env: process.env
  })

  child.unref()

  // Wait for daemon to start
  const maxWait = 10000
  const startTime = Date.now()

  while (Date.now() - startTime < maxWait) {
    if (await isDaemonRunning()) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  throw new Error('Failed to start indexer daemon')
}

/**
 * Stop the indexer daemon gracefully
 */
export async function stopDaemon(): Promise<void> {
  const daemonRunning = await isDaemonRunning()
  if (!daemonRunning) {
    console.log(`[DEBUG] Daemon is not running, nothing to stop`)
    return
  }

  const pidFilePath = getDaemonPidFilePath()

  try {
    const pid = parseInt(await fsPromises.readFile(pidFilePath, 'utf8'), 10)
    console.log(`[DEBUG] Stopping daemon with PID ${pid}...`)

    // Send SIGTERM for graceful shutdown
    process.kill(pid, 'SIGTERM')

    // Wait for process to finish with timeout
    const timeout = 10000 // 10 seconds
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      try {
        process.kill(pid, 0) // Check if process is alive
        await new Promise(resolve => setTimeout(resolve, 100))
      } catch (e: any) {
        // Process finished
        console.log(`[DEBUG] Daemon stopped successfully`)
        return
      }
    }

    // If process didn't finish, try SIGKILL
    console.log(`[DEBUG] Daemon did not stop gracefully, sending SIGKILL...`)
    process.kill(pid, 'SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 500))

  } catch (e: any) {
    console.log(`[DEBUG] Error stopping daemon: ${e.message}`)
  }

  // Remove PID file
  try {
    await fsPromises.unlink(pidFilePath)
    console.log(`[DEBUG] Removed PID file: ${pidFilePath}`)
  } catch (e: any) {
    console.log(`[DEBUG] Failed to remove PID file: ${e.message}`)
  }
}
