import {initTreeSitter} from '../utils/tree-sitter.js'
import {loadGlobalConfig, writeDaemonPortFile, DEFAULT_SETTINGS} from '../utils/config-global.js'
import {log} from '../cli/cli-ui.js'
import {registerProject} from './project-watcher.js'
import {startHeartbeat, startInactivityTimer, stopAllTimers} from './inactivity-manager.js'
import {gracefulShutdown, isAnotherInstanceRunning, setupSignalHandlers, writePidFile} from './service-lifecycle.js'
import {startMcpServer, startMcpHttpServer} from './mcp-service.js'

// Mode flags
const MCP_MODE = process.argv.includes('--mcp')
const MCP_HTTP_MODE = process.argv.includes('--mcp-http')
const DEFAULT_MCP_PORT = DEFAULT_SETTINGS.SERVICE_PORT

// Helper to extract port from args
function getPortFromArgs(): number | null {
  const portIndex = process.argv.indexOf('--port')
  if (portIndex !== -1 && portIndex + 1 < process.argv.length) {
    const port = parseInt(process.argv[portIndex + 1])
    return isNaN(port) ? null : port
  }
  return null
}

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

  // Start appropriate server based on mode
  if (MCP_HTTP_MODE) {
    // HTTP mode: start HTTP MCP server for daemon (multi-client support)
    const port = getPortFromArgs() || DEFAULT_MCP_PORT
    await writeDaemonPortFile(port)
    await startMcpHttpServer(port)
  } else if (MCP_MODE) {
    // MCP stdio mode: start MCP server via stdio (single client)
    await startMcpServer()
  } else {
    // Daemon mode: just run with background indexing (no MCP server)
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

  // Only start if explicitly running in MCP mode
  if (!MCP_MODE && !MCP_HTTP_MODE) {
    console.error('[ERROR] indexer-service.js must be run with --mcp or --mcp-http flag')
    console.error('[ERROR] Usage: node lib/indexer-service.js --mcp (stdio mode)')
    console.error('[ERROR]    or: node lib/indexer-service.js --mcp-http --port <port> (daemon mode)')
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
