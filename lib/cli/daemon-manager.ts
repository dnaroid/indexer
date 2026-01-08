import fs from 'fs/promises'
import { getDaemonPidFilePath } from '../utils/config-global.js'

/**
 * Check if the indexer daemon is currently running
 * @returns True if daemon is running
 */
export async function isDaemonRunning(): Promise<boolean> {
  // Check global PID file first (used by indexer-service.js)
  const globalPidFile = getDaemonPidFilePath()

  try {
    await fs.access(globalPidFile)
    const pid = parseInt(await fs.readFile(globalPidFile, 'utf8'), 10)
    process.kill(pid, 0)
    console.log(`[DEBUG] Global daemon running: PID=${pid}, file=${globalPidFile}`)
    return true
  } catch (e: any) {
    // Global daemon not running
  }

  return false
}

/**
 * Stop the indexer daemon gracefully
 * @returns
 */
export async function stopDaemon(): Promise<void> {
  const daemonRunning = await isDaemonRunning()
  if (!daemonRunning) {
    console.log(`[DEBUG] Daemon is not running, nothing to stop`)
    return
  }

  const pidFilePath = getDaemonPidFilePath()

  try {
    const pid = parseInt(await fs.readFile(pidFilePath, 'utf8'), 10)
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
    await fs.unlink(pidFilePath)
    console.log(`[DEBUG] Removed PID file: ${pidFilePath}`)
  } catch (e: any) {
    console.log(`[DEBUG] Failed to remove PID file: ${e.message}`)
  }
}
