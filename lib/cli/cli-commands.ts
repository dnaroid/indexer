import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

import { fail, log, warn } from './cli-ui.js'
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

import { detectProjectIndexConfig, renderToIndex } from '../core/project-detector.js'
import { dropCollections, runOneOffIndex } from '../core/indexer-core.js'
import { checkSystemRequirements, setupOllamaModel } from '../utils/system-check.js'
import {
  addProjectToConfig,
  getProjectCollectionName,
  loadGlobalConfig
} from '../utils/config-global.js'
import {
  renderMcpProxyScript
} from './cli-config.js'
import { isDaemonRunning, stopDaemon, ensureDaemonRunning } from './daemon-manager.js'
import { isQdrantUp, isOllamaUp, countIndexed } from '../managers/collection-manager.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const pkgPath = path.resolve(__dirname, '../../../package.json')
const pkg = JSON.parse(fsSync.readFileSync(pkgPath, 'utf-8'))

export async function ensureInitialized(startCwd: string, failOnMissing = true) {
  const root = await findProjectRoot(startCwd)
  const paths = getPaths(root)
  const exists = await pathExists(paths.toIndexPath)
  if (!exists && failOnMissing) {
    fail('CLI is not initialized. Run "indexer init" in project root.')
  }
  return { root, paths, isInitialized: exists }
}

export async function checkAndAutoUpdate(command: string | null) {
  if (command === 'mcp' || command === 'logs') {
    return
  }

  const currentVersion = pkg.version
  try {
    const latest = await checkLatestVersion()
    if (latest && latest !== currentVersion) {
      console.error(`\x1b[33m[!] New version available: ${latest} (current: ${currentVersion})\x1b[0m`)
      console.error(`\x1b[33m[!] Auto-updating...\x1b[0m`)

      const daemonRunning = await isDaemonRunning()
      if (daemonRunning) {
        console.error(`\x1b[33m[!] Stopping daemon before update...\x1b[0m`)
        await stopDaemon()
      }

      const pkgName = '@dnaroid/mcp-code-indexer'
      await new Promise<void>((resolve, reject) => {
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

      if (daemonRunning) {
        console.error(`\x1b[33m[!] Daemon stopped. It will be restarted automatically on next MCP command.\x1b[0m`)
      }
    }
  } catch (e: any) {
    console.error(`\x1b[31m[!] Auto-update failed: ${e.message}\x1b[0m`)
  }
}

async function checkLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch('https://registry.npmjs.org/@dnaroid/mcp-code-indexer/latest', {
      signal: AbortSignal.timeout ? AbortSignal.timeout(2000) : undefined
    })
    if (res.ok) {
      const json = await res.json() as any
      return json.version
    }
  } catch (_) {}
  return null
}

export async function handleInit(startCwd: string) {
  if (isInsideIndexer(startCwd)) {
    fail('Do not run init from inside .indexer/. Go to project root.')
  }

  const root = await findProjectRoot(startCwd)
  const paths = getPaths(root)

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
  } catch (e: any) {
    console.log('You may need to run "ollama pull unclemusclez/jina-embeddings-v2-base-code" manually.')
  }

  await fs.mkdir(paths.dotDir, { recursive: true })

  const { type: projectType, dirs, exts } = await detectProjectIndexConfig(root)
  await fs.writeFile(paths.toIndexPath, renderToIndex({ type: projectType, dirs, exts }), 'utf8')

  const collectionName = getProjectCollectionName(root)
  const mcpProxyScript = await renderMcpProxyScript(paths, collectionName)
  const mcpProxyPath = path.join(paths.dotDir, 'mcp-server.js')
  await fs.writeFile(mcpProxyPath, mcpProxyScript, 'utf8')
  await fs.chmod(mcpProxyPath, 0o755)
  log(`Generated MCP proxy script: ${mcpProxyPath}`)

  await upsertRootMcpConfig(paths)
  await upsertKilocodeMcpConfig(paths)
  await upsertGeminiMcpConfig(paths)
  const codexArgs = await upsertCodexArgsConfig(paths)

  await ensureGitignoreEntry(root, '.indexer/')

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

export async function handleStatus(startCwd: string) {
  const { root, isInitialized } = await ensureInitialized(startCwd, false)

  if (!isInitialized) {
    log(`Project Root: ${root}`)
    log(`Status: \x1b[33mNot Initialized\x1b[0m`)
    log(`Run "indexer init" to setup.`)
    return
  }

  const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333'
  const ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434'

  const qdrantUp = await isQdrantUp(qdrantUrl)
  const ollamaUp = await isOllamaUp(ollamaUrl)
  const daemonRunning = await isDaemonRunning()

  const collectionName = getProjectCollectionName(root)
  const count = qdrantUp ? await countIndexed(collectionName) : null
  const currentVersion = pkg.version

  const globalConfig = await loadGlobalConfig()
  const absRoot = path.resolve(root)
  const isRegistered = !!globalConfig.projects[absRoot]

  const GREEN = '\x1b[32m'
  const RED = '\x1b[31m'
  const RESET = '\x1b[0m'
  const color = (val: boolean, okText = 'running', failText = 'stopped') =>
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

export async function handleCleanIndex(startCwd: string) {
  const { root, paths } = await ensureInitialized(startCwd)
  const collectionName = getProjectCollectionName(root)

  // Check if MCP proxy script is up to date
  await checkMcpProxyActual(root, paths)

  const qdrantUp = await isQdrantUp(process.env.QDRANT_URL || 'http://localhost:6333')
  if (!qdrantUp) {
    fail('Qdrant is not running.')
  }

  log(`Reindexing ${root} -> ${collectionName}...`)

  try {
    await runOneOffIndex(root, collectionName, { reset: true })
    log('Index cleaned and rebuilt.')
  } catch (e: any) {
    fail(`Indexer failed: ${e.message}`)
  }
}

export async function handleLogs() {
  const { getLogFilePath } = await import('../utils/config-global.js')
  const logFile = getLogFilePath()
  if (!fsSync.existsSync(logFile)) {
    fail('No log file found. Has the daemon run?')
  }

  console.log(`Tailing logs from ${logFile}... (Press any key to exit)`)
  const tail = spawn('tail', ['-f', logFile], { stdio: 'inherit' })

  await new Promise<void>((resolve) => {
    const handler = () => {
      tail.kill('SIGTERM')
      resolve()
    }
    process.once('SIGINT', handler)
    tail.on('exit', () => {
      process.off('SIGINT', handler)
      resolve()
    })

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

export async function handleUninstall(startCwd: string) {
  const root = await findProjectRoot(startCwd)
  const paths = getPaths(root)

  if (!(await pathExists(paths.dotDir))) {
    fail('No .indexer/ in this project to uninstall.')
  }

  const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333'
  const qdrantUp = await isQdrantUp(qdrantUrl)

  if (qdrantUp) {
    log('Dropping Qdrant collection...')
    try {
      // await dropCollections() // TODO: This needs to be fixed
    } catch (e: any) {
      warn(`Failed to drop collection: ${e.message}`)
    }
  } else {
    warn('Qdrant is not running. Collection will NOT be dropped (files only).')
  }

  await fs.rm(paths.dotDir, { recursive: true, force: true })
  await removeGitignoreEntry(root, '.indexer/')
  await removeRootMcpIndexer(paths.rootMcpPath)
  await removeKilocodeMcpIndexer(root)
  await removeGeminiMcpIndexer(root)
  await removeCodexArgsIndexer(paths.codexArgsPath)
  await removeReadmeCliSection(root)
  const { removeProjectFromConfig } = await import('../utils/config-global.js')
  await removeProjectFromConfig(root)

  log('Removed .indexer/ and cleaned up configs.')
}

async function checkMcpProxyActual(root: string, paths: any): Promise<boolean> {
  const currentCollectionId = getProjectCollectionName(root)
  const mcpProxyPath = path.join(paths.dotDir, 'mcp-server.js')

  try {
    const proxyContent = await fs.readFile(mcpProxyPath, 'utf8')
    const match = proxyContent.match(/const COLLECTION_ID = ['"]([^'"]+)['"]/)

    if (match && match[1] !== currentCollectionId) {
      warn('⚠️  MCP proxy script is outdated!')
      warn(`   Current collectionId: ${currentCollectionId}`)
      warn(`   Proxy collectionId:   ${match[1]}`)
      warn('   Run "indexer update-mcp" to fix this.')
      return false
    }
  } catch (e) {
    // Proxy script doesn't exist or can't be read
    return false
  }

  return true
}

export async function handleUpdateMcp(startCwd: string) {
  const root = await findProjectRoot(startCwd)
  if (!root) {
    fail('Not inside an indexed project')
    process.exit(1)
  }

  const paths = getPaths(root)

  // Verify .indexer exists
  if (!(await pathExists(paths.dotDir))) {
    fail('Project not initialized. Run "indexer init" first.')
    process.exit(1)
  }

  // Regenerate proxy script with current collectionId
  const collectionName = getProjectCollectionName(root)
  const mcpProxyScript = await renderMcpProxyScript(paths, collectionName)
  const mcpProxyPath = path.join(paths.dotDir, 'mcp-server.js')
  await fs.writeFile(mcpProxyPath, mcpProxyScript, 'utf8')
  await fs.chmod(mcpProxyPath, 0o755)

  // Update global config with current path
  await addProjectToConfig(root)

  log(`Updated MCP proxy script: ${mcpProxyPath}`)
  log(`Collection ID: ${collectionName}`)
  log(`Project path updated in global config`)
}

export async function handleMcp(_args: string[], _startCwd: string, _projectPathArg: string | null = null) {
  console.error('[ERROR] The "indexer mcp" command is deprecated.')
  console.error('[ERROR] MCP servers are now started automatically through the proxy script.')
  console.error('[ERROR] Please run "indexer init" to generate the proxy script.')
  console.error('[ERROR] Then use the proxy script directly from your MCP configuration.')
  process.exit(1)
}

export async function handleStartDaemon() {
  const running = await isDaemonRunning()
  if (running) {
    log('Daemon is already running.')
    return
  }

  log('Starting daemon...')
  try {
    await ensureDaemonRunning()
    log('Daemon started successfully.')
  } catch (e: any) {
    fail(`Failed to start daemon: ${e.message}`)
  }
}

export async function handleStopDaemon() {
  const running = await isDaemonRunning()
  if (!running) {
    log('Daemon is not running.')
    return
  }

  log('Stopping daemon...')
  try {
    await stopDaemon()
    log('Daemon stopped successfully.')
  } catch (e: any) {
    fail(`Failed to stop daemon: ${e.message}`)
  }
}
