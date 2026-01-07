import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import {spawn} from 'child_process'
import {createInterface} from 'readline/promises'
import {stdin as input, stdout as output} from 'node:process'
import {createRequire} from 'module'

import {confirmAction, fail, log, warn} from './cli-ui.js'
import {
  ensureGitignoreEntry,
  findProjectRoot,
  getPaths,
  isInsideIndexer,
  pathExists,
  removeCodexArgsIndexer,
  removeGeminiMcpIndexer,
  removeGitignoreEntry,
  removeKilocodeMcpIndexer,
  removeReadmeCliSection,
  removeRootMcpIndexer,
  upsertCodexArgsConfig,
  upsertGeminiMcpConfig,
  upsertKilocodeMcpConfig,
  upsertReadmeCliSection,
  upsertRootMcpConfig
} from './cli-config.js'

import {detectProjectIndexConfig, renderToIndex} from './project-detector.js'
import {startMcpServer} from './mcp-server.js'
import {
  deleteCollectionByName,
  dropCollections,
  listCollectionsExtended,
  runOneOffIndex
} from './indexer-core.js'
import {checkSystemRequirements, setupOllamaModel} from './system-check.js'
import {
  addProjectToConfig,
  getLogFilePath,
  getDaemonPidFilePath,
  getProjectCollectionName,
  removeProjectFromConfig,
  loadGlobalConfig,
  getProjectConfig
} from './config-global.js'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')

// Helper for connection checks
async function ensureQdrantConnection() {
  const url = process.env.QDRANT_URL || 'http://localhost:6333'
  if (!(await isQdrantUp(url))) {
    fail(`Cannot connect to Qdrant at ${url}. Is it running?`)
  }
}

async function isQdrantUp(url) {
  try {
    const res = await fetch(`${url}`)
    return res.ok
  } catch (_) {
    return false
  }
}

async function isOllamaUp(url) {
  try {
    const res = await fetch(`${url}/api/tags`)
    return res.ok
  } catch (_) {
    return false
  }
}

export async function isDaemonRunning(projectRoot = null) {
  // Check global PID file first (used by indexer-service.js)
  const globalPidFile = getDaemonPidFilePath()

  try {
    await fs.access(globalPidFile)
    const pid = parseInt(await fs.readFile(globalPidFile, 'utf8'), 10)
    process.kill(pid, 0)
    console.log(`[DEBUG] Global daemon running: PID=${pid}, file=${globalPidFile}`)

    // Also check HTTP service to be sure
    const config = await loadGlobalConfig()
    const firstProjectPath = projectRoot || Object.keys(config.projects)[0]
    if (firstProjectPath) {
      const projectConf = await getProjectConfig(firstProjectPath)
      if (projectConf && projectConf.settings.SERVICE_PORT) {
        const servicePort = projectConf.settings.SERVICE_PORT
        try {
          const res = await fetch(`http://127.0.0.1:${servicePort}/health`)
          if (res.ok) {
            console.log(`[DEBUG] HTTP service responding on port ${servicePort}`)
            return true
          }
        } catch (e) {
          console.log(`[DEBUG] HTTP service not responding on port ${servicePort}: ${e.message}`)
        }
      }
    }

    return true
  } catch (e) {
    console.log(`[DEBUG] Global daemon not running: ${e.message}`)
    // Global daemon not running, check project-specific
  }

  // Check project-specific PID file (used by indexer-daemon.js in installed version)
  if (projectRoot) {
    const projectPidFile = path.join(projectRoot, '.indexer', 'indexer.pid')

    try {
      await fs.access(projectPidFile)
      const pid = parseInt(await fs.readFile(projectPidFile, 'utf8'), 10)
      process.kill(pid, 0)
      console.log(`[DEBUG] Project daemon running: PID=${pid}, file=${projectPidFile}`)
      return true
    } catch (e) {
      console.log(`[DEBUG] Project daemon not running: ${e.message}`)
      // Project daemon not running
    }
  }

  return false
}

async function checkLatestVersion() {
  try {
    const res = await fetch('https://registry.npmjs.org/@dnaroid/mcp-code-indexer/latest', {
      signal: AbortSignal.timeout ? AbortSignal.timeout(2000) : undefined
    })
    if (res.ok) {
      const json = await res.json()
      return json.version
    }
  } catch (_) {}
  return null
}

export async function checkAndAutoUpdate(command) {
  if (command === 'mcp' || command === 'logs') return

  const currentVersion = pkg.version
  try {
    const latest = await checkLatestVersion()
    if (latest && latest !== currentVersion) {
      console.error(`\x1b[33m[!] New version available: ${latest} (current: ${currentVersion})\x1b[0m`)
      console.error(`\x1b[33m[!] Auto-updating...\x1b[0m`)
      const pkgName = '@dnaroid/mcp-code-indexer'
      await new Promise((resolve, reject) => {
        const spawnUpdate = spawn('npm', ['install', '-g', `${pkgName}@latest`], {
          stdio: 'inherit',
          shell: true
        })
        spawnUpdate.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else {
            reject(new Error('npm install failed'))
          }
        })
      })
      console.error(`\x1b[32m[✓] Successfully updated to version ${latest}\x1b[0m`)
    }
  } catch (e) {
    console.error(`\x1b[31m[!] Auto-update failed: ${e.message}\x1b[0m`)
  }
}

async function countIndexed(collectionName) {
  const url = process.env.QDRANT_URL || 'http://localhost:6333'
  if (!collectionName) return null
  try {
    const res = await fetch(`${url}/collections/${collectionName}/points/count`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({exact: true})
    })
    if (!res.ok) return null
    const json = await res.json()
    return json.result?.count ?? null
  } catch (e) {
    return null
  }
}

export async function ensureInitialized(startCwd) {
  const root = await findProjectRoot(startCwd)
  const paths = getPaths(root)
  // Check if .indexer/to-index exists, which implies initialized
  const exists = await pathExists(paths.toIndexPath)
  if (!exists) {
    fail('CLI is not initialized. Run "indexer init" in the project root.')
  }
  return {root, paths}
}

export async function handleInit(startCwd) {
  if (isInsideIndexer(startCwd)) {
    fail('Do not run init from inside .indexer/. Go to project root.')
  }

  const root = await findProjectRoot(startCwd)
  const paths = getPaths(root)

  // Check if .indexer directory already exists
  if (await pathExists(paths.dotDir)) {
    const RED = '\x1b[31m'
    const RESET = '\x1b[0m'
    console.error(`${RED}✗ Error: .indexer directory already exists in this project!${RESET}`)
    console.error(`${RED}  Run "indexer uninstall" first to remove the previous installation.${RESET}`)
    console.error(`${RED}  After that, you can run "indexer init" again.${RESET}\n`)
    throw new Error('INDEXER_ALREADY_EXISTS')
  }

  log('Checking system requirements...')
  const sys = await checkSystemRequirements()
  if (!sys.ok) {
    console.error('\n[!] Missing dependencies:')
    sys.missing.forEach(m => {
      console.error(` - ${m.name}: ${m.install}`)
    })
    process.exit(1)
  }

  log('Checking Ollama & Qdrant connectivity...')
  try {
    await setupOllamaModel('unclemusclez/jina-embeddings-v2-base-code')
  } catch (e) {
    console.log('You may need to run "ollama pull unclemusclez/jina-embeddings-v2-base-code" manually.')
  }

  await fs.mkdir(paths.dotDir, {recursive: true})

  const {type: projectType, dirs, exts} = await detectProjectIndexConfig(root)
  await fs.writeFile(paths.toIndexPath, renderToIndex({type: projectType, dirs, exts}), 'utf8')

  await upsertRootMcpConfig(paths)
  await upsertKilocodeMcpConfig(paths)
  await upsertGeminiMcpConfig(paths)
  const codexArgs = await upsertCodexArgsConfig(paths)

  await ensureGitignoreEntry(root, '.indexer/')

  // Register globally
  await addProjectToConfig(root)

  await upsertReadmeCliSection(paths.root)

  log('Automatically running initial index clean/rebuild...')
  await handleCleanIndex(startCwd)

  log(`Initialized: ${paths.dotDir}`)
  log(`Project registered in global config`)

  console.log('\n--- CODEX MCP ARGS ---')
  console.log(codexArgs)
  console.log('------------------------\n')
}

export async function handleStatus(startCwd) {
  const {root} = await ensureInitialized(startCwd)

  const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333'
  const ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434'

  const qdrantUp = await isQdrantUp(qdrantUrl)
  const ollamaUp = await isOllamaUp(ollamaUrl)
  const daemonRunning = await isDaemonRunning(root)

  const collectionName = getProjectCollectionName(root)
  const count = qdrantUp ? await countIndexed(collectionName) : null
  const currentVersion = pkg.version

  const globalConfig = await loadGlobalConfig()
  const absRoot = path.resolve(root)
  const isRegistered = !!globalConfig.projects[absRoot]

  const GREEN = '\x1b[32m'
  const RED = '\x1b[31m'
  const RESET = '\x1b[0m'
  const color = (val, okText = 'running', failText = 'stopped') =>
    val ? `${GREEN}${okText}${RESET}` : `${RED}${failText}${RESET}`

  log(`Project Root: ${root}`)
  log(`Collection: ${collectionName}`)
  log(`Daemon state: ${color(daemonRunning)}`)
  log(`Registered in Daemon: ${color(isRegistered, 'Yes', 'No')}`)
  log(`Qdrant: ${color(qdrantUp)}`)
  log(`Ollama: ${color(ollamaUp)}`)
  log(`CLI Version: ${currentVersion}`)

  if (count !== null) {
    log(`Indexed points: ${count}`)
  }
}

export async function handleCleanIndex(startCwd) {
  const {root} = await ensureInitialized(startCwd)
  const collectionName = getProjectCollectionName(root)

  const qdrantUp = await isQdrantUp(process.env.QDRANT_URL || 'http://localhost:6333')
  if (!qdrantUp) {
    fail('Qdrant is not running.')
  }

  log(`Reindexing ${root} -> ${collectionName}...`)

  try {
    await runOneOffIndex(root, collectionName, {reset: true})
    log('Index cleaned and rebuilt.')
  } catch (e) {
    fail(`Indexer failed: ${e.message}`)
  }
}

export async function handleLogs() {
  const logFile = getLogFilePath()
  if (!fsSync.existsSync(logFile)) {
    fail('No log file found. Has the daemon run?')
  }

  console.log(`Tailing logs from ${logFile}... (Press any key to exit)`)
  const tail = spawn('tail', ['-f', logFile], {stdio: 'inherit'})

  // Create a promise that resolves on any keypress
  await new Promise((resolve) => {
    const handler = () => {
      tail.kill('SIGTERM')
      resolve()
    }
    process.once('SIGINT', handler)
    tail.on('exit', () => {
      process.off('SIGINT', handler)
      resolve()
    })

    // Set up raw mode for any keypress
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.once('data', () => {
        tail.kill('SIGTERM')
        process.stdin.setRawMode(false)
        process.stdin.pause()
        resolve()
      })
    }
  })
}

export async function handleListCollections(silent = false) {
  await ensureQdrantConnection()
  if (!silent) {
    log('Fetching collections...')
  }
  try {
    const list = await listCollectionsExtended()
    if (list.length === 0) {
      if (!silent) console.log('No collections found.')
      return []
    }
    if (!silent) {
      console.log('\nFound collections:')
      list.forEach((c, i) => {
        console.log(`  \x1b[36m[${i + 1}]\x1b[0m ${c.name} \x1b[90m(${c.count} points)\x1b[0m`)
      })
      console.log('')
    }
    return list
  } catch (e) {
    if (silent) throw e
    fail(`Failed to list collections: ${e.message}`)
  }
}

export async function handleDeleteCollection(name) {
  await ensureQdrantConnection()

  if (!name) {
    const list = await handleListCollections(true)
    if (list.length === 0) {
      console.log('No collections to delete.')
      return
    }

    console.log('\nSelect collections to delete:')
    list.forEach((c, i) => {
      console.log(`  \x1b[36m[${i + 1}]\x1b[0m ${c.name} \x1b[90m(${c.count} points)\x1b[0m`)
    })
    console.log('')

    const rl = createInterface({input, output})
    const answer = await rl.question('Enter numbers to delete (e.g. "1 3" or "all"), or empty to cancel: ')
    rl.close()

    const trimmed = answer.trim().toLowerCase()
    if (!trimmed) return

    let toDelete = []
    if (trimmed === 'all') {
      toDelete = list
    } else {
            const parts = trimmed.split(/[\s,]+/)
      const indices = parts.map(p => parseInt(p, 10)).filter(n => !isNaN(n) && n >= 1 && n <= list.length)
      const unique = [...new Set(indices)]
      toDelete = unique.map(i => list[i - 1])
    }

    if (toDelete.length === 0) return

    if (await confirmAction('\nAre you sure?')) {
      for (const c of toDelete) {
        await deleteCollectionByName(c.name)
        console.log(`Deleted ${c.name}`)
      }
    }
    return
  }

  if (await confirmAction(`Delete collection "${name}"?`)) {
    try {
      await deleteCollectionByName(name)
      log(`Collection "${name}" deleted.`)
    } catch (e) {
      fail(`Failed to delete: ${e.message}`)
    }
  }
}

export async function handlePruneAll() {
  await ensureQdrantConnection()
  const list = await handleListCollections(true)
  if (list.length === 0) {
    log('No collections to prune.')
    return
  }
  if (await confirmAction('Delete ALL collections?')) {
    for (const c of list) {
      await deleteCollectionByName(c.name)
    }
    log('Pruned.')
  }
}

export async function handleMcp(args, startCwd, projectPathArg = null) {
  await startMcpServer(startCwd, args, projectPathArg)
  log(`MCP server started. Waiting for connections...`)
}

export async function handleUninstall(startCwd) {
  const root = await findProjectRoot(startCwd)
  const paths = getPaths(root)

  if (!(await pathExists(paths.dotDir))) {
    fail('No .indexer/ in this project to uninstall.')
  }

  // Use default Qdrant URL from global config
  const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333'
  const qdrantUp = await isQdrantUp(qdrantUrl)

  if (qdrantUp) {
    log('Dropping Qdrant collection...')
    try {
      await dropCollections()
    } catch (e) {
      warn(`Failed to drop collection: ${e.message}`)
    }
  } else {
    warn('Qdrant is not running. Collection will NOT be dropped (files only).')
  }

  await fs.rm(paths.dotDir, {recursive: true, force: true})
  await removeGitignoreEntry(root, '.indexer/')
  await removeRootMcpIndexer(paths.rootMcpPath)
  await removeKilocodeMcpIndexer(root)
  await removeGeminiMcpIndexer(root)
  await removeCodexArgsIndexer(paths.codexArgsPath)
  await removeReadmeCliSection(root)
  await removeProjectFromConfig(root)

  log('Removed .indexer/ and cleaned up configs.')
}
