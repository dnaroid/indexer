import http from 'http'
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import chokidar from 'chokidar'
import {
  ensureCollections,
  indexFile,
  listProjectFiles,
  removeDeletedFiles,
  shouldIndexFile,
  resetConfigCache
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

// Ensure cursor is restored on exit/interrupt/error (daemon doesn't have a cursor, but good practice)
const exitHandler = () => {
  // In a daemon, we don't restore terminal, just log exit
  log('Daemon exiting due to signal or error.')
}

process.on('exit', exitHandler)
process.on('SIGINT', exitHandler)
process.on('SIGTERM', exitHandler)

process.on('uncaughtException', (err) => {
  log(`Uncaught Exception: ${err.message}`)
  console.error('[indexer] Uncaught Exception:', err)
  process.exit(1)
})

process.on('unhandledRejection', (err) => {
  log(`Unhandled Rejection: ${err.message}`)
  console.error('[indexer] Unhandled Rejection:', err)
  process.exit(1)
})

// State
const watchers = new Map() // path -> chokidar instance
const debouncers = new Map() // path+file -> timeout

// Inactivity timeout configuration
const INACTIVITY_TIMEOUT_MS = Number(process.env.INACTIVITY_TIMEOUT_MS) || 30 * 60 * 1000 // 30 минут по умолчанию
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS) || 5 * 60 * 1000 // Проверка каждые 5 минут

// Inactivity state
let lastActivityTime = Date.now()
let inactivityTimer = null
let heartbeatInterval = null
let httpServer = null

// --- Inactivity Management ---

function updateActivity() {
  lastActivityTime = Date.now()
  log('Activity updated')
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
    if (inactiveTime >= INACTIVITY_TIMEOUT_MS) {
      log(`No activity for ${INACTIVITY_TIMEOUT_MS}ms, shutting down...`)
      console.log(`[indexer-service] Heartbeat check: Inactivity timeout: ${inactiveTime}ms >= ${INACTIVITY_TIMEOUT_MS}ms, shutting down...`)
      gracefulShutdown()
    }
  }, HEARTBEAT_INTERVAL_MS)
}

function gracefulShutdown() {
  log('Graceful shutdown initiated...')
  console.log(`[indexer-service] Graceful shutdown initiated, PID: ${process.pid}`)

  // Остановить таймеры
  if (inactivityTimer) clearTimeout(inactivityTimer)
  if (heartbeatInterval) clearInterval(heartbeatInterval)
  if (configDebounceTimer) clearTimeout(configDebounceTimer)

  // Закрыть watchers
  for (const [path, watcher] of watchers) {
    watcher.close()
  }
  watchers.clear()

  // Удалить PID файл
  const pidFilePath = getDaemonPidFilePath()
  fs.unlink(pidFilePath).catch(() => {})
  console.log(`[indexer-service] Removing PID file: ${pidFilePath}`)

  // Закрыть HTTP сервер
  if (httpServer) {
    httpServer.close(() => {
      log('HTTP server closed')
      console.log(`[indexer-service] HTTP server closed, exiting...`)
      process.exit(0)
    })
  } else {
    console.log(`[indexer-service] No HTTP server, exiting...`)
    process.exit(0)
  }
}

// HTTP Server
let SERVER_PORT = 3000 // Will be loaded from config

async function handleRequest(req, res) {
  // Обновляем активность при любом запросе
  updateActivity()

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'application/json'})
    res.end(JSON.stringify({
      status: 'ok',
      pid: process.pid,
      uptime: process.uptime(),
      lastActivity: lastActivityTime
    }))
    return
  }

  if (req.method === 'POST' && req.url === '/heartbeat') {
    res.writeHead(200, {'Content-Type': 'application/json'})
    res.end(JSON.stringify({status: 'ok', lastActivity: lastActivityTime}))
    return
  }

  if (req.method !== 'POST') {
    res.writeHead(405)
    res.end('Method Not Allowed')
    return
  }

  const url = new URL(req.url, `http://${req.headers.host}`)
  let body = ''

  req.on('data', chunk => body += chunk)
  req.on('end', async () => {
    try {
      const data = JSON.parse(body || '{}')

      if (url.pathname === '/register') {
        await registerProject(data.path)
        res.writeHead(200, {'Content-Type': 'application/json'})
        res.end(JSON.stringify({status: 'ok', pid: process.pid}))
      } else if (url.pathname === '/query') {
        const result = await executeQuery(data)
        res.writeHead(200, {'Content-Type': 'application/json'})
        res.end(JSON.stringify(result))
      } else {
        res.writeHead(404)
        res.end('Not Found')
      }
    } catch (e) {
      log(`Error handling request ${url.pathname}: ${e.message}`)
      res.writeHead(500)
      res.end(JSON.stringify({error: e.message}))
    }
  })
}

async function startServer() {
  const server = http.createServer(handleRequest)
  httpServer = server

  return new Promise((resolve, reject) => {
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') {
        log(`Port ${SERVER_PORT} in use, trying next...`)
        reject(e)
      } else {
        reject(e)
      }
    })

    server.listen(SERVER_PORT, '127.0.0.1', () => {
      log(`Daemon listening on port ${SERVER_PORT}`)
      resolve(server)
    })
  })
}

// Project Management
async function registerProject(projectPath) {
  const absPath = path.resolve(projectPath)
  if (watchers.has(absPath)) {
    log(`Project already watched: ${absPath}`)
    return
  }

  log(`Registering project: ${absPath}`)
  await addProjectToConfig(absPath)
  const projectConf = await getProjectConfig(absPath)

  await syncProject(absPath, projectConf)
  startWatcher(absPath, projectConf)
}

async function syncProject(projectPath, projectConf) {
  const { collectionName, settings } = projectConf
  log(`Syncing ${projectPath} -> ${collectionName}`)

  try {
    await ensureCollections(collectionName)
    const diskFiles = await listProjectFiles(projectPath)
    const diskSet = new Set(diskFiles)
    await removeDeletedFiles(projectPath, collectionName, diskSet)

    let indexedCount = 0
    for (const f of diskFiles) {
      const res = await indexFile(projectPath, f, collectionName, settings)
      if (res.indexed) indexedCount++
    }
    log(`Sync complete. Indexed ${indexedCount} files.`)
  } catch (e) {
    log(`Sync failed for ${projectPath}: ${e.message}`)
  }
}

function startWatcher(projectPath, projectConf) {
  const watcher = chokidar.watch(projectPath, {
    ignored: [
      '**/.git/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**'
    ],
    persistent: true,
    ignoreInitial: true
  })

  watcher
    .on('add', p => scheduleIndex(projectPath, p))
    .on('change', p => scheduleIndex(projectPath, p))
    .on('unlink', p => handleUnlink(projectPath, p))

  watchers.set(projectPath, watcher)
  log(`Watcher started for ${projectPath}`)
}

const DEBOUNCE_MS = 500

function scheduleIndex(projectRoot, filePath) {
  const rel = path.relative(projectRoot, filePath)
  const key = `${projectRoot}:${rel}`

  if (debouncers.has(key)) {
    clearTimeout(debouncers.get(key))
  }

  const timer = setTimeout(async () => {
    debouncers.delete(key)
    try {
      const projectConf = await getProjectConfig(projectRoot)
      if (!projectConf) return

      if (rel === '.gitignore' || rel.endsWith('.indexer/to-index')) {
         resetConfigCache(projectRoot)
         return
      }

      if (await shouldIndexFile(projectRoot, rel)) {
        await indexFile(projectRoot, rel, projectConf.collectionName, projectConf.settings)
        log(`Indexed: ${rel}`)
      }
    } catch (e) {
      log(`Failed to index ${rel}: ${e.message}`)
    }
  }, DEBOUNCE_MS)

  debouncers.set(key, timer)
}

async function handleUnlink(projectRoot, filePath) {
  const rel = path.relative(projectRoot, filePath)
  log(`File deleted: ${rel} (will be cleaned up on next sync)`)
}

// --- Config Watcher ---

async function unregisterProject(projectPath) {
  const absPath = path.resolve(projectPath)
  const watcher = watchers.get(absPath)

  if (watcher) {
    await watcher.close()
    watchers.delete(absPath)
    log(`Unregistered project: ${absPath}`)
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

async function executeQuery({path: projectPath, tool, args}) {
  const projectConf = await getProjectConfig(projectPath)
  if (!projectConf) throw new Error(`Project not registered: ${projectPath}`)

  const deps = createToolDeps(projectPath, projectConf)
  const handlers = createToolHandlers(deps)

  if (!handlers[tool]) throw new Error(`Unknown tool: ${tool}`)

  const result = await handlers[tool](args)
  return result
}

// Bootstrap
export async function startIndexerService(projectPathArg = null) {
  const pidFilePath = getDaemonPidFilePath()
  await fs.writeFile(pidFilePath, String(process.pid))
  log(`Daemon started with PID ${process.pid}, PID file: ${pidFilePath}`)
  console.log(`[indexer-service] Daemon started with PID ${process.pid}, PID file: ${pidFilePath}`)

  await initTreeSitter()

  // Load config to get service port
  const config = await loadGlobalConfig()
  // Use port from first project's settings or default
  const firstProjectPath = projectPathArg || Object.keys(config.projects)[0]
  if (firstProjectPath) {
    const projectConf = await getProjectConfig(firstProjectPath)
    if (projectConf && projectConf.settings.SERVICE_PORT) {
      SERVER_PORT = projectConf.settings.SERVICE_PORT
      console.log(`[indexer-service] Using service port from project config: ${SERVER_PORT}`)
    } else {
      // Use default from DEFAULT_SETTINGS
      SERVER_PORT = DEFAULT_SETTINGS.SERVICE_PORT
      console.log(`[indexer-service] Using default service port: ${SERVER_PORT}`)
    }
  } else {
    // No projects, use default
    SERVER_PORT = DEFAULT_SETTINGS.SERVICE_PORT
    console.log(`[indexer-service] No projects, using default service port: ${SERVER_PORT}`)
  }

  // Запускаем таймеры неактивности
  startInactivityTimer()
  startHeartbeat()

  const projectsToRegister = projectPathArg ? [projectPathArg] : Object.keys(config.projects)

  for (const p of projectsToRegister) {
    registerProject(p).catch(e => log(`Failed to restore project ${p}: ${e.message}`))
  }

  // Start config watcher to auto-detect project changes
  startConfigWatcher()

  await startServer()
}

// Signal handlers for graceful shutdown
process.on('SIGTERM', gracefulShutdown)
process.on('SIGINT', gracefulShutdown)

// Start the service when run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startIndexerService().catch(err => {
    console.error('[indexer-service] Failed to start:', err)
    process.exit(1)
  })
}
