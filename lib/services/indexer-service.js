import {initTreeSitter} from '../utils/tree-sitter.js'
import {loadGlobalConfig} from '../utils/config-global.js'
import {log} from '../cli/cli-ui.js'
import {registerProject, startConfigWatcher} from './project-watcher.js'
import {startHeartbeat, startInactivityTimer, stopAllTimers} from './inactivity-manager.js'
import {gracefulShutdown, isAnotherInstanceRunning, setupSignalHandlers, writePidFile} from './service-lifecycle.js'
import {startMcpServer} from './mcp-service.js'

// Mode flag
const MCP_MODE = process.argv.includes('--mcp')

// Bootstrap
export async function startIndexerService(projectPathArg = null) {
  // DEBUG: Log function call
  console.log('[DEBUG] startIndexerService() called')
  console.log('[DEBUG] projectPathArg:', projectPathArg)
  console.log('[DEBUG] MCP_MODE:', MCP_MODE)
  console.log('[DEBUG] process.argv:', process.argv)

  // Check if another instance is already running
  if (await isAnotherInstanceRunning()) {
    console.log('[indexer-service] Another instance is already running, exiting')
    process.exit(0)
  }

  // Initialize TreeSitter
  await initTreeSitter()

  // Load config
  const config = await loadGlobalConfig()

  // Start inactivity timers
  startInactivityTimer(() => {
    log('Inactivity timeout reached, shutting down...')
    gracefulShutdown()
  })
  startHeartbeat(() => {
    log('Heartbeat timeout reached, shutting down...')
    gracefulShutdown()
  })

  // Write PID file
  await writePidFile()

  // Register projects
  const projectsToRegister = projectPathArg ? [projectPathArg] : Object.keys(config.projects)
  for (const p of projectsToRegister) {
    await registerProject(p).catch(e => log(`Failed to register project ${p}: ${e.message}`))
  }

  // Start config watcher to auto-detect project changes
  startConfigWatcher()

  // Start appropriate server based on mode
  if (MCP_MODE) {
    // MCP mode: start MCP server via stdio
    await startMcpServer()
  } else {
    // Daemon mode: just run with background indexing (no HTTP server)
    console.log('[indexer-service] Daemon mode: running with background indexing...')
    // Keep process alive for background indexing
    await new Promise(() => {}) // Never resolves, keeps process alive
  }
}

// Setup signal handlers
setupSignalHandlers(async () => {
  await stopAllTimers()
})

// Start service when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('[DEBUG] indexer-service.js is being run directly')
  console.log('[DEBUG] import.meta.url:', import.meta.url)
  console.log('[DEBUG] process.argv[1]:', process.argv[1])
  console.log(`[DEBUG] Condition met: import.meta.url === 'file://${process.argv[1]}'`)
  console.log('[DEBUG] MCP_MODE:', MCP_MODE)
  console.log('[DEBUG] process.argv:', process.argv)

  // Only start if explicitly running in MCP mode or daemon mode
  if (!MCP_MODE) {
    console.error('[ERROR] indexer-service.js must be run with --mcp flag')
    console.error('[ERROR] Usage: node lib/indexer-service.js --mcp')
    console.error('[ERROR] For CLI commands, use: indexer <command>')
    process.exit(1)
  }

  startIndexerService().catch(err => {
    console.error('[indexer-service] Failed to start:', err)
    process.exit(1)
  })
} else {
  console.log('[DEBUG] indexer-service.js is being imported as a module, not run directly')
  console.log('[DEBUG] import.meta.url:', import.meta.url)
  console.log('[DEBUG] process.argv[1]:', process.argv[1])
}
