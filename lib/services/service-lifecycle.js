import fs from 'fs/promises'
import { getDaemonPidFilePath } from '../utils/config-global.js'

// Shutdown state flag to prevent duplicate calls
let isShuttingDown = false

/**
 * Check if shutdown is in progress
 * @returns {boolean} True if shutting down
 */
export function isShuttingDownFlag() {
  return isShuttingDown
}

/**
 * Graceful shutdown of the service
 * @param {Function} [beforeShutdown] - Optional callback before shutdown
 * @returns {Promise<void>}
 */
export async function gracefulShutdown(beforeShutdown = null) {
  // Prevent duplicate calls
  if (isShuttingDown) {
    console.log('[service-lifecycle] Shutdown already in progress, ignoring duplicate call')
    return
  }
  isShuttingDown = true

  console.log('[service-lifecycle] Graceful shutdown initiated...')

  if (beforeShutdown) {
    await beforeShutdown()
  }

  // Remove PID file
  const pidFilePath = getDaemonPidFilePath()
  try {
    await fs.unlink(pidFilePath)
    console.log(`[service-lifecycle] Removed PID file: ${pidFilePath}`)
  } catch (e) {
    console.log(`[service-lifecycle] Failed to remove PID file: ${e.message}`)
  }

  console.log('[service-lifecycle] Exiting...')
  process.exit(0)
}

/**
 * Write PID file for the daemon
 * @returns {Promise<void>}
 */
export async function writePidFile() {
  const pidFilePath = getDaemonPidFilePath()
  await fs.writeFile(pidFilePath, String(process.pid))
  console.log(`[service-lifecycle] Service started with PID ${process.pid}, PID file: ${pidFilePath}`)
}

/**
 * Check if another instance is already running
 * @returns {Promise<boolean>} True if another instance is running
 */
export async function isAnotherInstanceRunning() {
  const pidFilePath = getDaemonPidFilePath()

  try {
    const existingPid = await fs.readFile(pidFilePath, 'utf8')

    // Verify if the process is still running
    try {
      process.kill(Number(existingPid), 0) // Signal 0 checks if process exists
      console.log(`[service-lifecycle] Another indexer service is already running with PID ${existingPid}`)
      return true
    } catch (e) {
      // Process is dead, clean up stale PID file
      console.log(`[service-lifecycle] Removing stale PID file for dead process ${existingPid}`)
      await fs.unlink(pidFilePath).catch(() => {})
      return false
    }
  } catch (e) {
    // PID file doesn't exist, proceed
    return false
  }
}

/**
 * Setup signal handlers for graceful shutdown
 * @param {Function} [beforeShutdown] - Optional callback before shutdown
 * @returns {void}
 */
export function setupSignalHandlers(beforeShutdown = null) {
  process.on('SIGTERM', () => {
    console.log('[service-lifecycle] Received SIGTERM')
    gracefulShutdown(beforeShutdown)
  })

  process.on('SIGINT', () => {
    console.log('[service-lifecycle] Received SIGINT')
    gracefulShutdown(beforeShutdown)
  })

  process.on('uncaughtException', (err) => {
    console.log('[service-lifecycle] Uncaught Exception:', err)
    gracefulShutdown(beforeShutdown)
  })

  process.on('unhandledRejection', (err) => {
    console.log('[service-lifecycle] Unhandled Rejection:', err)
    gracefulShutdown(beforeShutdown)
  })
}
