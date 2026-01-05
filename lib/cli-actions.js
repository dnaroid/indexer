import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import {spawn} from 'child_process'
import { createRequire } from 'module'
import {createInterface} from 'readline/promises'
import {stdin as input, stdout as output} from 'node:process'

import {log, warn, fail, confirmAction, pickOption, restoreTerminal} from './cli-ui.js'
import {
  isInsideIndexer, findProjectRoot, getPaths, readEnvFile, pathExists, loadState, saveState, slugify, renderEnv,
  upsertRootMcpConfig, upsertKilocodeMcpConfig, upsertGeminiMcpConfig, upsertCodexArgsConfig, upsertReadmeCliSection, ensureGitignoreEntry,
  removeRootMcpIndexer, removeKilocodeMcpIndexer, removeGeminiMcpIndexer, removeCodexArgsIndexer, removeReadmeCliSection, removeGitignoreEntry
} from './cli-config.js'

import {detectProjectIndexConfig, renderToIndex} from './project-detector.js'
import {startMcpServer, CODEBASE_PROMPT} from './mcp-server.js'
import {deleteCollectionByName, dropCollections, listCollectionsExtended, runOneOffIndex} from './indexer-core.js'
import {checkSystemRequirements, setupOllamaModel} from './system-check.js'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')

// Helper for connection checks
async function ensureQdrantConnection() {
  try {
    const root = await findProjectRoot(process.cwd())
    const paths = getPaths(root)
    const env = await readEnvFile(paths.envPath)
    Object.assign(process.env, env)
  } catch (_) {
    // Not in a project? Use defaults
  }

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

async function countIndexed(env) {
  const url = env.QDRANT_URL || 'http://localhost:6333'
  const collection = env.QDRANT_COLLECTION
  if (!collection) {
    return null
  }
  try {
    const res = await fetch(`${url}/collections/${collection}/points/count`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({exact: true})
    })
    if (!res.ok) {
      return null
    }
    const json = await res.json()
    return json.result?.count ?? null
  } catch (e) {
    return null
  }
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

export async function handleUpdate() {
  log('Checking for updates...')
  try {
    const pkgName = '@dnaroid/mcp-code-indexer'
    await new Promise((resolve, reject) => {
      const spawnUpdate = spawn('npm', ['install', '-g', `${pkgName}@latest`], {
        stdio: 'inherit',
        shell: true
      })
      spawnUpdate.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error('npm install failed'))
      })
    })
    log('Successfully updated to the latest version.')
  } catch (e) {
    fail(`Update failed: ${e.message}`)
  }
}

export async function checkAndAutoUpdate(command) {
  // Skip update check for MCP server to avoid breaking JSON-RPC with logs
  if (command === 'mcp') return

  const currentVersion = pkg.version
  try {
    const latest = await checkLatestVersion()
    if (latest && latest !== currentVersion) {
      console.error(`\x1b[33m[!] New version available: ${latest} (current: ${currentVersion})\x1b[0m`)
      console.error(`\x1b[36m[!] Auto-updating...\x1b[0m`)
      
      try {
        const pkgName = '@dnaroid/mcp-code-indexer'
        await new Promise((resolve, reject) => {
          const p = spawn('npm', ['install', '-g', `${pkgName}@latest`], {
            stdio: 'inherit',
            shell: true
          })
          p.on('close', (code) => code === 0 ? resolve() : reject(new Error('Update failed')))
        })

        console.error(`\x1b[32m[!] Update complete. Restarting...\x1b[0m`)
        
        // Restart the process with same args
        const args = process.argv.slice(1)
        const child = spawn(process.argv[0], args, {
          stdio: 'inherit',
          env: process.env
        })
        
        child.on('close', (code) => {
          process.exit(code)
        })
        
        // Prevent further execution in this process while waiting for child
        await new Promise(() => {}) 
      } catch (e) {
        console.error(`\x1b[31m[!] Auto-update failed: ${e.message}\x1b[0m`)
        // Continue execution if update fails
      }
    }
  } catch (_) {
    // Ignore network errors etc during auto-check
  }
}

export async function ensureInitialized(startCwd) {
  const root = await findProjectRoot(startCwd)
  const paths = getPaths(root)
  const exists = await pathExists(paths.dotDir)
  if (!exists) {
    fail('CLI is not initialized. Run "indexer init" in the project root.')
  }
  const state = (await loadState(paths.statePath)) || {}
  return {root, paths, state}
}

export async function handleInit(startCwd) {
  if (isInsideIndexer(startCwd)) {
    fail('Do not run init from inside .indexer/. Go to project root.')
  }

  log('Checking system requirements...')
  const sys = await checkSystemRequirements()
  if (!sys.ok) {
    console.error('\n[!] Missing dependencies:')
    sys.missing.forEach(m => {
      console.error(` - ${m.name}: ${m.install}`)
    })
    console.error('\nPlease install missing tools and run "indexer init" again.\n')
    process.exit(1)
  }

  try {
    await setupOllamaModel('nomic-embed-text')
  } catch (e) {
    warn(`Failed to set up Ollama model automatically: ${e.message}`)
    console.log('You may need to run "ollama pull nomic-embed-text" manually.')
  }

  const root = await findProjectRoot(startCwd)
  const paths = getPaths(root)
  const {type: projectType, dirs, exts} = await detectProjectIndexConfig(root)

  if (await pathExists(paths.dotDir)) {
    fail('.indexer already exists. Remove it manually if you need to re-init.')
  }

  await fs.mkdir(paths.dotDir, {recursive: true})

  const base = slugify(path.basename(root))
  const shortId = crypto.randomUUID().split('-')[0]
  const projectId = `${base}-${shortId}`
  const collectionName = `${base}_${shortId}`

  const envBody = renderEnv({
    projectId,
    collectionName,
    workspaceDir: root
  })

  await fs.writeFile(paths.envPath, envBody, 'utf8')
  await upsertRootMcpConfig(paths)
  await upsertKilocodeMcpConfig(paths)
  await upsertGeminiMcpConfig(paths)
  const codexArgs = await upsertCodexArgsConfig(paths)

  await fs.writeFile(paths.toIndexPath, renderToIndex({type: projectType, dirs, exts}), 'utf8')

  await ensureGitignoreEntry(root, '.indexer/')

  await saveState(paths, {
    projectId,
    projectType,
    collectionName,
    workspace: root,
    envFile: paths.envPath,
    toIndex: paths.toIndexPath,
    createdAt: new Date().toISOString(),
    lastCommand: 'init'
  })

  await upsertReadmeCliSection(paths.root)

  log('Automatically running initial index clean/rebuild...')
  await handleCleanIndex(startCwd)

  log(`Initialized: ${paths.dotDir}`)
  log(`Project type: ${projectType}`)
  log('Added to .gitignore: .indexer/')
  log('Created .indexer/to-index for whitelist patterns')
  log('Updated .mcp.json with local MCP server config')
  log('Saved Codex args to .codex-cmd-args.')

  console.log('\n--- CODEX MCP ARGS ---')
  console.log(codexArgs)
  console.log('------------------------\n')

  console.log('\n----- MCP PROMPT ----')
  console.log(CODEBASE_PROMPT)
  console.log('-----------------------\n')
}

export async function handleStatus(startCwd) {
  const {paths, state} = await ensureInitialized(startCwd)
  const env = await readEnvFile(paths.envPath)

  const qdrantUrl = env.QDRANT_URL || 'http://localhost:6333'
  const ollamaUrl = env.OLLAMA_URL || 'http://127.0.0.1:11434'

  const qdrantUp = await isQdrantUp(qdrantUrl)
  const ollamaUp = await isOllamaUp(ollamaUrl)

  const count = qdrantUp ? await countIndexed(env) : null
  const currentVersion = pkg.version
  
  log(`Project: ${state.projectId || path.basename(paths.root)}`)
  log(`Root: ${paths.root}`)
  log(`Collection: ${state.collectionName || env.QDRANT_COLLECTION || 'n/a'}`)
  log(`Qdrant: ${qdrantUp ? 'running' : 'stopped'}`)
  log(`Ollama: ${ollamaUp ? 'running' : 'stopped'}`)
  log(`Indexer: Managed by MCP server (auto-starts on connect)`)
  log(`CLI Version: ${currentVersion}`)

  if (count !== null) {
    log(`Indexed points: ${count}`)
  }

  await saveState(paths, {lastCommand: 'status'})
}

export async function handleCleanIndex(startCwd) {
  const {paths} = await ensureInitialized(startCwd)
  const env = await readEnvFile(paths.envPath)

  const qdrantUp = await isQdrantUp(env.QDRANT_URL || 'http://localhost:6333')
  if (!qdrantUp) {
    fail('Qdrant is not running. Connect via MCP first to start services.')
  }

  log('Dropping collections and reindexing...')

  Object.assign(process.env, env)

  try {
    await runOneOffIndex({reset: true})
    await saveState(paths, {lastCommand: 'clean'})
    log('Index cleaned and rebuilt.')
  } catch (e) {
    fail(`Indexer failed: ${e.message}`)
  }
}

export async function handleListCollections(silent = false) {
  await ensureQdrantConnection()
  if (!silent) log('Fetching collections...')
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
    if (!trimmed) {
      return
    }

    let toDelete = []
    if (trimmed === 'all') {
      toDelete = list
    } else {
      const parts = trimmed.split(/[\s,]+/)
      const indices = parts.map(p => parseInt(p, 10)).filter(n => !isNaN(n) && n >= 1 && n <= list.length)
      const unique = [...new Set(indices)]
      toDelete = unique.map(i => list[i - 1])
    }

    if (toDelete.length === 0) {
      console.log('No valid selections.')
      return
    }

    console.log('\nYou are about to DELETE:')
    toDelete.forEach(c => console.log(` - ${c.name}`))

    if (await confirmAction('\nAre you sure?')) {
      for (const c of toDelete) {
        process.stdout.write(`Deleting ${c.name}... `)
        await deleteCollectionByName(c.name)
        process.stdout.write('Done\n')
      }
    } else {
      console.log('Cancelled.')
    }
    return
  }

  if (await confirmAction(`Are you sure you want to DELETE collection "${name}"?`)) {
    try {
      await deleteCollectionByName(name)
      log(`Collection "${name}" deleted.`)
    } catch (e) {
      fail(`Failed to delete: ${e.message}`)
    }
  } else {
    log('Cancelled.')
  }
}

export async function handlePruneAll() {
  await ensureQdrantConnection()
  const list = await handleListCollections(true)
  if (list.length === 0) {
    log('No collections to prune.')
    return
  }
  console.log('\nWARNING: This will delete ALL Qdrant collections:')
  list.forEach(c => console.log(` - ${c.name} (${c.count} points)`))

  if (await confirmAction('\nAre you ABSOLUTELY sure?')) {
    log('Deleting all collections...')
    for (const c of list) {
      process.stdout.write(`Deleting ${c.name}... `)
      await deleteCollectionByName(c.name)
      process.stdout.write('Done\n')
    }
    log('All collections pruned.')
  } else {
    log('Cancelled.')
  }
}

export async function handleMcp(args, startCwd) {
  let cwd = process.cwd()
  const cwdArg = args.find(a => a.startsWith('--cwd='))
  if (cwdArg) {
    cwd = cwdArg.split('=')[1]
  }

  const paths = getPaths(cwd)
  if (!(await pathExists(paths.envPath))) {
    try {
      const root = await findProjectRoot(cwd)
      const rootPaths = getPaths(root)
      if (await pathExists(rootPaths.envPath)) {
        cwd = root
      }
    } catch (_) {}
  }

  const finalPaths = getPaths(cwd)
  const env = await readEnvFile(finalPaths.envPath)
  Object.assign(process.env, env)

  if (!process.env.WORKSPACE_DIR) {
    process.env.WORKSPACE_DIR = cwd
  }

  try {
    await startMcpServer()
  } catch (e) {
    console.error(`[mcp-cli] Server crash: ${e.message}`)
    process.exit(1)
  }
}

export async function handleUninstall(startCwd) {
  const root = await findProjectRoot(startCwd)
  const paths = getPaths(root)
  if (!(await pathExists(paths.dotDir))) {
    fail('No .indexer/ in this project to uninstall.')
  }

  try {
    const env = await readEnvFile(paths.envPath)
    Object.assign(process.env, env)

    const qdrantUp = await isQdrantUp(env.QDRANT_URL || 'http://localhost:6333')
    if (qdrantUp) {
      log('Dropping Qdrant collection...')
      await dropCollections()
    } else {
      warn('Qdrant is not running. Collection will NOT be dropped (files only).')
    }
  } catch (e) {
    warn(`Failed to drop collection: ${e.message}`)
  }

  await fs.rm(paths.dotDir, {recursive: true, force: true})
  await removeGitignoreEntry(root, '.indexer/')
  await removeRootMcpIndexer(paths.rootMcpPath)
  await removeKilocodeMcpIndexer(root)
  await removeGeminiMcpIndexer(root)
  await removeCodexArgsIndexer(paths.codexArgsPath)
  await removeReadmeCliSection(root)

  log('Removed .indexer/ and cleaned up configs.')
}
