import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import chokidar from 'chokidar'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  ensureCollections,
  indexFile,
  listProjectFiles,
  removeDeletedFiles,
  shouldIndexFile,
  resetConfigCache,
  deleteCollectionByName
} from './indexer-core.js'
import {initTreeSitter} from './tree-sitter.js'
import {
  getProjectCollectionName,
  addProjectToConfig,
  getLogFilePath,
  getDaemonPidFilePath,
  loadGlobalConfig,
  getProjectConfig,
  getGlobalConfigPath,
  DEFAULT_SETTINGS
} from './config-global.js'
import {
  buildTreeText,
  extractSymbols,
  filterReferences,
  runRipgrep
} from './mcp-tools.js'
import { createToolHandlers } from './mcp-handlers.js'
import {
  loadSnapshot,
  saveSnapshot,
  createSnapshot,
  compareSnapshots,
  getFilesToIndex,
  deleteSnapshot
} from './snapshot-manager.js'

// Ensure indexer directory exists
const INDEXER_DIR = path.dirname(getLogFilePath())
fs.mkdir(INDEXER_DIR, {recursive: true}).catch(console.error)

// Simple Logger
const LOG_FILE = getLogFilePath()
function log(msg) {
  const ts = new Date().toISOString()
  const line = `[${ts}] ${msg}\n`
  fs.appendFile(LOG_FILE, line).catch(console.error)
}

// Shutdown state flag to prevent duplicate calls
let isShuttingDown = false

// State
const watchers = new Map() // path -> chokidar instance
const projectDebouncers = new Map() // projectPath -> timeout
const projectStates = new Map() // projectPath -> { dirty: boolean, lastSyncTime: number }

// Inactivity timeout configuration
const INACTIVITY_TIMEOUT_MS = Number(process.env.INACTIVITY_TIMEOUT_MS) || 30 * 60 * 1000 // 30 minutes by default
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS) || 5 * 60 * 1000 // Check every 5 minutes
const CLIENT_TIMEOUT_MS = 2 * 60 * 1000 // 2 minutes - cleanup clients without heartbeat

// Project-level debounce configuration
const PROJECT_DEBOUNCE_MS = Number(process.env.PROJECT_DEBOUNCE_MS) || 2000 // 2 seconds default

// Always ignore these patterns for project-level watcher
const ALWAYS_IGNORED = [
  '**/.git/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.cache/**',
  '**/coverage/**',
  '**/.idea/**',
  '**/.vscode/**',
  '**/Library/**',
  '**/Temp/**',
  '**/obj/**',
  '**/Logs/**',
  '**/vs/**'
]

// Inactivity state
let lastActivityTime = Date.now()
let inactivityTimer = null
let heartbeatInterval = null
let mcpServer = null

// Mode flag
const MCP_MODE = process.argv.includes('--mcp')

// --- Inactivity Management ---

function updateActivity() {
  lastActivityTime = Date.now()
  log('Activity updated (actual work)')
}

function startInactivityTimer() {
  if (inactivityTimer) clearTimeout(inactivityTimer)

  inactivityTimer = setTimeout(() => {
    const inactiveTime = Date.now() - lastActivityTime
    if (inactiveTime >= INACTIVITY_TIMEOUT_MS) {
      log(`No activity for ${INACTIVITY_TIMEOUT_MS}ms, shutting down...`)
      console.log(`[indexer-service] Inactivity timeout: ${inactiveTime}ms >= ${INACTIVITY_TIMEOUT_MS}ms, shutting down...`)
      gracefulShutdown()
    }
  }, INACTIVITY_TIMEOUT_MS)
}

function startHeartbeat() {
  heartbeatInterval = setInterval(() => {
    const inactiveTime = Date.now() - lastActivityTime

    // In MCP mode, check if we have any activity
    if (MCP_MODE && inactiveTime >= INACTIVITY_TIMEOUT_MS) {
      log(`No activity for ${INACTIVITY_TIMEOUT_MS}ms in MCP mode, shutting down...`)
      console.log(`[indexer-service] Heartbeat check: No activity for ${INACTIVITY_TIMEOUT_MS}ms, shutting down...`)
      gracefulShutdown()
    }
  }, HEARTBEAT_INTERVAL_MS)
}

function gracefulShutdown() {
  // Prevent duplicate calls
  if (isShuttingDown) {
    log('Shutdown already in progress, ignoring duplicate call')
    return
  }
  isShuttingDown = true

  log('Graceful shutdown initiated...')
  console.log(`[indexer-service] Graceful shutdown initiated, PID: ${process.pid}`)

  // Stop timers
  if (inactivityTimer) clearTimeout(inactivityTimer)
  if (heartbeatInterval) clearInterval(heartbeatInterval)
  if (configDebounceTimer) clearTimeout(configDebounceTimer)

  // Clear project debounce timers
  for (const timer of projectDebouncers.values()) {
    clearTimeout(timer)
  }
  projectDebouncers.clear()

  // Close watchers
  for (const [path, watcher] of watchers) {
    watcher.close()
  }
  watchers.clear()

  // Remove PID file
  const pidFilePath = getDaemonPidFilePath()
  fs.unlink(pidFilePath).catch((err) => {
    log(`Failed to remove PID file: ${err.message}`)
  })
  console.log(`[indexer-service] Removing PID file: ${pidFilePath}`)

  console.log(`[indexer-service] Exiting...`)
  process.exit(0)
}

// Project Management

/**
 * Mark a project as dirty and schedule sync
 */
function markProjectDirty(projectPath) {
  const state = projectStates.get(projectPath) || { dirty: false }
  state.dirty = true
  projectStates.set(projectPath, state)
  scheduleProjectSync(projectPath)
}

/**
 * Mark a project as clean
 */
function markProjectClean(projectPath) {
  const state = projectStates.get(projectPath) || {}
  state.dirty = false
  state.lastSyncTime = Date.now()
  projectStates.set(projectPath, state)
}

/**
 * Schedule project sync with debounce
 */
function scheduleProjectSync(projectPath) {
  const key = `project:${projectPath}`

  if (projectDebouncers.has(key)) {
    clearTimeout(projectDebouncers.get(key))
  }

  const timer = setTimeout(async () => {
    projectDebouncers.delete(key)
    await syncProjectWithDiff(projectPath)
  }, PROJECT_DEBOUNCE_MS)

  projectDebouncers.set(key, timer)
}

/**
 * Register a new project for watching
 */
async function registerProject(projectPath) {
  const absPath = path.resolve(projectPath)
  if (watchers.has(absPath)) {
    log(`Project already watched: ${absPath}`)
    return
  }

  log(`Registering project: ${absPath}`)
  await addProjectToConfig(absPath)
  const projectConf = await getProjectConfig(absPath)

  // Initial sync with snapshot
  await syncProjectWithDiff(absPath, true)

  // Start project-level watcher
  startProjectWatcher(absPath)
}

/**
 * Sync project using diff-based approach
 * @param {string} projectPath - Project root path
 * @param {boolean} forceFullSync - Force full sync regardless of dirty state
 */
async function syncProjectWithDiff(projectPath, forceFullSync = false) {
  const projectConf = await getProjectConfig(projectPath)
  if (!projectConf) {
    log(`No config found for project: ${projectPath}`)
    return
  }

  const state = projectStates.get(projectPath) || { dirty: false }

  if (!forceFullSync && !state.dirty) {
    return
  }

  log(`Syncing ${projectPath} -> ${projectConf.collectionName}`)

  try {
    const startTime = Date.now()
    await ensureCollections(projectConf.collectionName)

    // Get files to index using snapshot diff
    const { filesToIndex, filesToRemove, isNew, diff } = await getFilesToIndex(projectPath)

    // Remove deleted files from Qdrant
    if (filesToRemove.length > 0) {
      for (const filePath of filesToRemove) {
        await deletePointsByPath(projectConf.collectionName, filePath, projectConf.settings)
      }
      log(`Removed ${filesToRemove.length} deleted files from index`)
    }

    // Index new and modified files
    let indexedCount = 0
    for (const filePath of filesToIndex) {
      const res = await indexFile(projectPath, filePath, projectConf.collectionName, projectConf.settings)
      if (res.indexed) indexedCount++
    }

    const duration = Date.now() - startTime

    if (isNew) {
      log(`Initial sync complete. Indexed ${indexedCount} files in ${duration}ms`)
    } else if (diff) {
      log(`Diff sync complete. +${diff.total.added} ~${diff.total.modified} -${diff.total.removed} files in ${duration}ms`)
    } else {
      log(`Sync complete. Indexed ${indexedCount} files in ${duration}ms`)
    }

    markProjectClean(projectPath)
  } catch (e) {
    log(`Sync failed for ${projectPath}: ${e.message}`)
    // Don't mark as clean, will retry on next event
  }
}

/**
 * Start project-level watcher (depth: 0)
 */
function startProjectWatcher(projectPath) {
  const watcher = chokidar.watch(projectPath, {
    depth: 0, // Only watch project root
    ignored: ALWAYS_IGNORED,
    ignoreInitial: true,
    persistent: true
  })

  watcher.on('all', () => {
    markProjectDirty(projectPath)
  })

  watchers.set(projectPath, watcher)
  log(`Project-level watcher started for ${projectPath}`)
}

/**
 * Handle config file changes (.gitignore, .indexer/to-index)
 */
async function handleConfigFileChange(projectPath, relPath) {
  if (relPath === '.gitignore' || relPath === '.indexer/to-index') {
    log(`Config file changed: ${relPath}`)
    resetConfigCache(projectPath)
    // Force full sync to rebuild snapshot with new rules
    await syncProjectWithDiff(projectPath, true)
  }
}

/**
 * Delete points by path from Qdrant collection
 */
async function deletePointsByPath(collectionName, filePath, settings = {}) {
  const qdrantUrl = settings?.QDRANT_URL || process.env.QDRANT_URL || 'http://localhost:6333'

  try {
    await fetch(`${qdrantUrl}/collections/${collectionName}/points/delete?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filter: {
          must: [{ key: 'path', match: { value: filePath } }]
        }
      })
    })
  } catch (e) {
    log(`Failed to delete points for ${filePath}: ${e.message}`)
  }
}

// --- Config Watcher ---

async function unregisterProject(projectPath) {
  const absPath = path.resolve(projectPath)
  const watcher = watchers.get(absPath)

  // Get project config before deletion
  const projectConf = await getProjectConfig(absPath)

  if (watcher) {
    await watcher.close()
    watchers.delete(absPath)
    log(`Unregistered project: ${absPath}`)
  }

  // Delete snapshot
  try {
    await deleteSnapshot(absPath)
    log(`Deleted snapshot for ${absPath}`)
  } catch (e) {
    log(`Failed to delete snapshot: ${e.message}`)
  }

  // Delete collection from Qdrant
  if (projectConf) {
    try {
      await deleteCollectionByName(projectConf.collectionName)
      log(`Deleted collection: ${projectConf.collectionName}`)
    } catch (e) {
      log(`Failed to delete collection: ${e.message}`)
    }
  }

  // Clear project state
  projectStates.delete(absPath)

  // Clear project debounce timer
  const key = `project:${absPath}`
  if (projectDebouncers.has(key)) {
    clearTimeout(projectDebouncers.get(key))
    projectDebouncers.delete(key)
  }
}

async function syncProjectsFromConfig() {
  let config
  try {
    config = await loadGlobalConfig()
  } catch (e) {
    log(`Failed to load config: ${e.message}`)
    console.error('[indexer-service] Config load error:', e)
    return // Don't modify projects if config is unreadable
  }

  // Validate config structure
  if (!config || typeof config !== 'object') {
    log(`Invalid config structure: not an object`)
    console.error('[indexer-service] Invalid config structure')
    return
  }

  if (!config.projects || typeof config.projects !== 'object') {
    log(`Invalid config structure: projects missing or not an object`)
    console.error('[indexer-service] Invalid config structure: projects missing')
    return
  }

  const currentProjects = new Set(Object.keys(config.projects))
  const watchedProjects = new Set(
    Array.from(watchers.keys()).filter(k => k !== 'config')
  )

  // Find new projects
  const newProjects = [...currentProjects].filter(p => !watchedProjects.has(p))

  // Find removed projects
  const removedProjects = [...watchedProjects].filter(p => !currentProjects.has(p))

  // Register new projects
  for (const p of newProjects) {
    try {
      await registerProject(p)
      log(`Auto-registered new project: ${p}`)
    } catch (e) {
      log(`Failed to auto-register project ${p}: ${e.message}`)
    }
  }

  // Unregister removed projects
  for (const p of removedProjects) {
    try {
      await unregisterProject(p)
      log(`Auto-unregistered project: ${p}`)
    } catch (e) {
      log(`Failed to auto-unregister project ${p}: ${e.message}`)
    }
  }

  log(`Config sync complete: +${newProjects.length} projects, -${removedProjects.length} projects`)
}

const CONFIG_DEBOUNCE_MS = 500
let configDebounceTimer = null

function startConfigWatcher() {
  const configPath = getGlobalConfigPath()
  const watcher = chokidar.watch(configPath, {
    persistent: true,
    ignoreInitial: true
  })

  watcher.on('change', () => {
    updateActivity()

    if (configDebounceTimer) {
      clearTimeout(configDebounceTimer)
    }

    configDebounceTimer = setTimeout(async () => {
      configDebounceTimer = null
      log('Config file changed, syncing projects...')
      await syncProjectsFromConfig()
    }, CONFIG_DEBOUNCE_MS)
  })

  watchers.set('config', watcher)
  log(`Config watcher started for ${configPath}`)
}

// Query Execution

function createToolDeps(projectPath, projectConf) {
  const { collectionName, settings } = projectConf
  const qdrantUrl = process.env.QDRANT_URL || settings.QDRANT_URL
  const ollamaUrl = process.env.OLLAMA_URL || settings.OLLAMA_URL
  const embedModel = process.env.EMBED_MODEL || settings.EMBED_MODEL

  return {
    readFile: async (p) => fs.readFile(path.resolve(projectPath, p), 'utf8'),

    embed: async (text) => {
       const res = await fetch(`${ollamaUrl}/api/embeddings`, {
         method: 'POST',
         headers: {'Content-Type': 'application/json'},
         body: JSON.stringify({
           model: embedModel,
           prompt: text
         })
       })
       const json = await res.json()
       return json.embedding
    },

    searchQdrant: async (vector, topK, pathPrefix) => {
      const filter = pathPrefix
        ? {must: [{key: 'path', match: {prefix: pathPrefix}}]}
        : undefined

      const res = await fetch(
        `${qdrantUrl}/collections/${collectionName}/points/search`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            vector,
            limit: topK,
            with_payload: true,
            score_threshold: settings.SCORE_THRESHOLD || 0,
            filter
          })
        }
      )
      const json = await res.json()
      return json.result || []
    },

    searchSymbols: async (name, kind, topK) => {
      const must = [
        {
          should: [
            {key: 'symbol_names', match: {text: name}},
            {key: 'symbol_references', match: {text: name}}
          ]
        }
      ]
      if (kind && kind !== 'any') {
        must.push({key: 'symbol_kinds', match: {any: [kind]}})
      }

      const res = await fetch(
        `${qdrantUrl}/collections/${collectionName}/points/scroll`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({filter: {must}, with_payload: true, limit: topK})
        }
      )
      const json = await res.json()
      return json.result?.points || json.result || []
    },

    listProjectFiles: () => listProjectFiles(projectPath),
    extractSymbols,
    buildTreeText,
    runRipgrep: (symbol) => runRipgrep(symbol, projectPath),
    filterReferences
  }
}

async function executeQuery({collectionId, tool, args}) {
  // Find project by collectionId
  const config = await loadGlobalConfig()
  let projectPath = null
  let projectConf = null

  for (const [path, data] of Object.entries(config.projects)) {
    if (data.collectionName === collectionId) {
      projectPath = path
      projectConf = await getProjectConfig(path)
      break
    }
  }

  if (!projectConf) throw new Error(`Collection not found: ${collectionId}`)

  const deps = createToolDeps(projectPath, projectConf)
  const handlers = createToolHandlers(deps)

  if (!handlers[tool]) throw new Error(`Unknown tool: ${tool}`)

  const result = await handlers[tool](args)
  return result
}

// MCP Server Setup

export const CODEBASE_PROMPT = [
  'You are an expert developer working in this codebase.',
  '',
  '- **MANDATORY**: For ANY codebase search/navigation, ALWAYS use indexer MCP FIRST (search_codebase, search_symbols, get_file_outline, find_usages). NEVER use Grep, Glob, or shell tools before indexer MCP. This is non-negotiable.',
  '',
  'Available MCP Tools & When to Use Them:',
  '1. search_codebase: Use for semantic/conceptual searches (e.g., "how is authentication handled?").',
  '2. search_symbols: Use to find specific definitions of classes, methods, or Unity-specific fields.',
  '3. get_file_outline: Use to quickly see the structure of a file without reading all its code. Essential for large files.',
  '4. get_project_structure: Use to understand the project architecture and locate files.',
  '5. find_usages: Use to find exact usages of a symbol, optionally with context (e.g. "Enemy.takeDamage").',
  '',
  'Workflow:',
  '- Start with get_project_structure to orient yourself.',
  '- Use search_codebase or search_symbols to find relevant logic.',
  '- Use get_file_outline to inspect a file before reading it with read_file.',
  '- Use find_usages to ensure changes don\'t break other parts of the system.',
  '',
  'Unity Specifics:',
  '- Lifecycle methods (Awake, Start, Update) are called by the engine, not explicitly in code.',
  '- [SerializeField] and ScriptableObjects indicate data configured in the Unity Inspector.'
].join('\n')

function createMcpHandlers() {
  return {
    search_codebase: async (args) => {
      // collectionId is in args
      updateActivity()
      return executeQuery(args)
    },
    search_symbols: async (args) => {
      updateActivity()
      return executeQuery(args)
    },
    get_file_outline: async (args) => {
      updateActivity()
      return executeQuery(args)
    },
    get_project_structure: async (args) => {
      updateActivity()
      return executeQuery(args)
    },
    find_usages: async (args) => {
      updateActivity()
      return executeQuery(args)
    }
  }
}

export function createMcpServer() {
  const handlers = createMcpHandlers()

  const server = new McpServer({
    name: 'code-index',
    version: '0.1.0',
    instructions: CODEBASE_PROMPT
  })

  server.registerPrompt(
    'codebase_guidance',
    {
      title: 'Codebase Guidance',
      description: 'Guidance for working inside this codebase',
      argsSchema: z.object({})
    },
    async () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: CODEBASE_PROMPT
          }
        }
      ]
    })
  )

  server.registerTool(
    'search_codebase',
    {
      description: 'Semantic search over the indexed codebase',
      inputSchema: {
        collectionId: z.string().describe('Collection ID for the project'),
        query: z.string().describe('Search query'),
        top_k: z.number().optional().default(5).describe('Number of results'),
        path_prefix: z.string().optional().describe('Filter by path prefix')
      }
    },
    handlers.search_codebase
  )

  server.registerTool(
    'search_symbols',
    {
      description: 'Search symbols (functions, classes, files) by name',
      inputSchema: {
        collectionId: z.string().describe('Collection ID for the project'),
        name: z.string().describe('Symbol name to search'),
        kind: z.string().optional().default('any').describe('Symbol kind filter'),
        top_k: z.number().optional().default(10).describe('Number of results')
      }
    },
    handlers.search_symbols
  )

  server.registerTool(
    'get_file_outline',
    {
      description: 'Get list of symbols (classes, methods) in a file',
      inputSchema: {
        collectionId: z.string().describe('Collection ID for the project'),
        path: z.string().describe('File path')
      }
    },
    handlers.get_file_outline
  )

  server.registerTool(
    'get_project_structure',
    {
      description: 'Get recursive visual tree of project files',
      inputSchema: {
        collectionId: z.string().describe('Collection ID for the project')
      }
    },
    handlers.get_project_structure
  )

  server.registerTool(
    'find_usages',
    {
      description: 'Find usages of a symbol, optionally filtered by context (e.g. class name)',
      inputSchema: {
        collectionId: z.string().describe('Collection ID for the project'),
        symbol: z.string().describe('Symbol name or qualified name (e.g. "takeDamage" or "Enemy.takeDamage")'),
        context: z.string().optional().describe('Context symbol to filter by (e.g. "Enemy")')
      }
    },
    handlers.find_usages
  )

  return server
}

async function startMcpServer() {
  console.log(`[indexer-service] Starting MCP server...`)
  const server = createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.log(`[indexer-service] MCP server connected via stdio`)
}

// Bootstrap
export async function startIndexerService(projectPathArg = null) {
  const pidFilePath = getDaemonPidFilePath()

  // Check if PID file exists
  try {
    const existingPid = await fs.readFile(pidFilePath, 'utf8')

    // Verify if the process is still running
    try {
      process.kill(Number(existingPid), 0) // Signal 0 checks if process exists
      console.log(`[indexer-service] Another indexer service is already running with PID ${existingPid}`)
      log(`Service already running with PID ${existingPid}, exiting`)
      process.exit(0)
    } catch (e) {
      // Process is dead, clean up stale PID file
      console.log(`[indexer-service] Removing stale PID file for dead process ${existingPid}`)
      await fs.unlink(pidFilePath).catch(() => {})
    }
  } catch (e) {
    // PID file doesn't exist, proceed
  }

  // Write current PID
  await fs.writeFile(pidFilePath, String(process.pid))
  log(`Service started with PID ${process.pid}, PID file: ${pidFilePath}`)
  console.log(`[indexer-service] Service started with PID ${process.pid}, PID file: ${pidFilePath}`)
  console.log(`[indexer-service] Mode: ${MCP_MODE ? 'MCP (stdio)' : 'Daemon (background indexing)'}`)

  await initTreeSitter()

  // Load config
  const config = await loadGlobalConfig()

  // Start inactivity timers
  startInactivityTimer()
  startHeartbeat()

  const projectsToRegister = projectPathArg ? [projectPathArg] : Object.keys(config.projects)

  for (const p of projectsToRegister) {
    registerProject(p).catch(e => log(`Failed to restore project ${p}: ${e.message}`))
  }

  // Start config watcher to auto-detect project changes
  startConfigWatcher()

  // Start appropriate server based on mode
  if (MCP_MODE) {
    // MCP mode: start MCP server via stdio
    await startMcpServer()
  } else {
    // Daemon mode: just run with background indexing (no HTTP server)
    console.log(`[indexer-service] Daemon mode: running with background indexing...`)
    // Keep process alive for background indexing
    await new Promise(() => {}) // Never resolves, keeps process alive
  }
}

// Signal handlers for graceful shutdown
process.on('SIGTERM', gracefulShutdown)
process.on('SIGINT', gracefulShutdown)

// Error handlers for graceful shutdown
process.on('uncaughtException', (err) => {
  log(`Uncaught Exception: ${err.message}`)
  console.error('[indexer-service] Uncaught Exception:', err)
  gracefulShutdown()
})

process.on('unhandledRejection', (err) => {
  log(`Unhandled Rejection: ${err.message}`)
  console.error('[indexer-service] Unhandled Rejection:', err)
  gracefulShutdown()
})

// Start the service when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startIndexerService().catch(err => {
    console.error('[indexer-service] Failed to start:', err)
    process.exit(1)
  })
}
