#!/usr/bin/env node

import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import readline from 'readline'
import {spawn} from 'child_process'
import {createInterface} from 'readline/promises'
import {stdin as input, stdout as output} from 'node:process'
import {fileURLToPath} from 'url'
import {detectProjectIndexConfig, renderToIndex} from './lib/project-detector.js'
import {startMcpServer, CODEBASE_PROMPT} from './lib/mcp-server.js'
import {deleteCollectionByName, dropCollections, listCollectionsExtended, runOneOffIndex} from './lib/indexer-core.js'
import {checkSystemRequirements, setupOllamaModel} from './lib/system-check.js'

const args = process.argv.slice(2)
const command = args.length > 0 ? args[0] : null
const startCwd = process.cwd()
const __filename = fileURLToPath(import.meta.url)

function log(msg) {
  console.log(`[indexer] ${msg}`)
}

function warn(msg) {
  console.warn(`[indexer] ${msg}`)
}

function fail(msg, code = 1) {
  console.error(`[indexer] ${msg}`)
  process.exit(code)
}

function isInsideIndexer(dir) {
  return dir.split(path.sep).includes('.indexer')
}

// --- Helpers ---

async function confirmAction(question) {
  const rl = createInterface({input, output})
  const answer = await rl.question(question + ' (y/N): ')
  rl.close()
  return answer.trim().toLowerCase() === 'y'
}

async function ensureQdrantConnection() {
  // Try to load env from current dir if possible, otherwise rely on defaults
  try {
    const root = await findProjectRoot(process.cwd())
    const paths = getPaths(root)
    const env = await readEnvFile(paths.envPath)
    Object.assign(process.env, env)
  } catch (_) {
    // Not in a project? Use defaults in indexer-core (localhost:6333)
  }

  const url = process.env.QDRANT_URL || 'http://localhost:6333'
  if (!(await isQdrantUp(url))) {
    fail(`Cannot connect to Qdrant at ${url}. Is it running?`)
  }
}

async function handleListCollections() {
  await ensureQdrantConnection()
  log('Fetching collections...')
  try {
    const list = await listCollectionsExtended()
    if (list.length === 0) {
      console.log('No collections found.')
      return
    }
    console.log('\nFound collections:')
    console.table(list)
    console.log('')
  } catch (e) {
    fail(`Failed to list collections: ${e.message}`)
  }
}

async function handleDeleteCollection(name) {
  if (!name) {
    fail('Usage: indexer delete <collection_name>')
  }
  await ensureQdrantConnection()

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

async function handlePruneAll() {
  await ensureQdrantConnection()

  const list = await listCollectionsExtended()
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

function stripIndexer(dir) {
  const parts = dir.split(path.sep)
  const idx = parts.lastIndexOf('.indexer')
  if (idx === -1) {
    return dir
  }
  const trimmed = parts.slice(0, idx).join(path.sep)
  return trimmed || path.parse(dir).root
}

async function pathExists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function findProjectRoot(startDir) {
  let dir = path.resolve(startDir)
  if (isInsideIndexer(dir)) {
    dir = stripIndexer(dir)
  }

  const start = dir
  let current = dir

  while (true) {
    const hasGit = await pathExists(path.join(current, '.git'))
    const hasPkg = await pathExists(path.join(current, 'package.json'))
    if (hasGit || hasPkg) {
      return current
    }

    const parent = path.dirname(current)
    if (parent === current) {
      return start
    }
    current = parent
  }
}

function slugify(name) {
  const clean = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  return clean || 'project'
}

function getPaths(root) {
  const dotDir = path.join(root, '.indexer')
  return {
    root,
    dotDir,
    envPath: path.join(dotDir, '.env'),
    rootMcpPath: path.join(root, '.mcp.json'),
    codexArgsPath: path.join(root, '.codex-cmd-args'),
    statePath: path.join(dotDir, 'state.json'),
    toIndexPath: path.join(dotDir, 'to-index')
  }
}

function renderEnv({projectId, collectionName, workspaceDir}) {
  return [
           `PROJECT_ID=${projectId}`,
           `WORKSPACE_DIR=${workspaceDir}`,
           `QDRANT_COLLECTION=${collectionName}`,
           `QDRANT_URL=http://localhost:6333`,
           `OLLAMA_URL=http://127.0.0.1:11434`,
           'EMBED_MODEL=nomic-embed-text',
           'VECTOR_SIZE=768',
           'MAX_CHUNK_LINES=220',
           'OVERLAP_LINES=30',
           'MAX_FILE_BYTES=2097152',
           'TOP_K_DEFAULT=5',
           'SCORE_THRESHOLD=0'
         ].join('\n') + '\n'
}

async function upsertRootMcpConfig(paths) {
  const scriptPath = __filename

  const indexerConfig = {
    command: 'node',
    args: [scriptPath, 'mcp', `--cwd=${paths.root}`]
  }

  let data = {}
  try {
    const text = await fs.readFile(paths.rootMcpPath, 'utf8')
    data = JSON.parse(text)
  } catch (e) {
    if (e.code !== 'ENOENT') {
      fail(`Invalid .mcp.json: ${e.message}`)
    }
  }

  data.mcpServers = {
    ...(data.mcpServers || {}),
    indexer: indexerConfig
  }

  await fs.writeFile(paths.rootMcpPath, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

async function upsertCodexArgsConfig(paths) {
  const args = JSON.stringify(['mcp', `--cwd=${paths.root}`])
  const line = `-c mcp_servers.indexer.command="indexer" -c mcp_servers.indexer.args='${args}'`

  try {
    let content = ''
    try {
      content = await fs.readFile(paths.codexArgsPath, 'utf8')
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw e
      }
    }

    if (!content.includes('mcp_servers.indexer')) {
      const prefix = content && !content.endsWith('\n') ? '\n' : ''
      await fs.appendFile(paths.codexArgsPath, prefix + line + '\n', 'utf8')
    }
  } catch (e) {
    warn(`Failed to update .codex-cmd-args: ${e.message}`)
  }
  return line
}

async function removeRootMcpIndexer(rootMcpPath) {
  try {
    const text = await fs.readFile(rootMcpPath, 'utf8')
    const data = JSON.parse(text)
    if (!data.mcpServers || !data.mcpServers.indexer) {
      return
    }

    const {['indexer']: _, ...rest} = data.mcpServers
    data.mcpServers = rest

    if (Object.keys(data.mcpServers).length === 0) {
      delete data.mcpServers
    }

    await fs.writeFile(rootMcpPath, JSON.stringify(data, null, 2) + '\n', 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') {
      return
    }
    warn(`Skipping .mcp.json cleanup: ${e.message}`)
  }
}

async function upsertReadmeCliSection(root) {
  const readmePath = path.join(root, 'README.md')
  let text
  try {
    text = await fs.readFile(readmePath, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') {
      return
    }
    throw e
  }

  const start = '<!-- indexer-cli-start -->'
  const end = '<!-- indexer-cli-end -->'
  const section = [
    start,
    '### Indexer CLI (Local Mode)',
    '',
    '- `indexer init` — creates `.indexer/`, sets up local config, and appends the `indexer` MCP server to `.mcp.json`.',
    '- `indexer status` — shows status.',
    '- `indexer clean` — drops the collection and reindexes.',
    '- `indexer uninstall` — removes `.indexer/` and the `indexer` entry in `.mcp.json`.',
    '',
    'MCP hookup for Claude is automatic: `.mcp.json` is updated during `indexer init`.',
    end
  ].join('\n')

  if (text.includes(start) && text.includes(end)) {
    const regex = new RegExp(`${start}[\s\S]*?${end}`, 'm')
    text = text.replace(regex, section)
  } else {
    const prefix = text.endsWith('\n') ? '' : '\n'
    text = text + `${prefix}\n${section}\n`
  }

  await fs.writeFile(readmePath, text, 'utf8')
}

async function removeReadmeCliSection(root) {
  const readmePath = path.join(root, 'README.md')
  let text
  try {
    text = await fs.readFile(readmePath, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') {
      return
    }
    throw e
  }

  const start = '<!-- indexer-cli-start -->'
  const end = '<!-- indexer-cli-end -->'
  if (!text.includes(start) || !text.includes(end)) {
    return
  }

  const regex = new RegExp(`\n?${start}[\s\S]*?${end}\n?`, 'm')
  text = text.replace(regex, '\n')
  await fs.writeFile(readmePath, text, 'utf8')
}

async function ensureGitignoreEntry(root, entry) {
  const gitignorePath = path.join(root, '.gitignore')
  let content = ''
  try {
    content = await fs.readFile(gitignorePath, 'utf8')
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e
    }
  }

  const lines = content.split(/\r?\n/)
  const normalized = lines.map((l) => l.trim())
  const cleanEntry = entry.endsWith('/') ? entry.slice(0, -1) : entry
  if (!normalized.includes(entry) && !normalized.includes(cleanEntry)) {
    const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : ''
    await fs.writeFile(gitignorePath, content + prefix + entry + '\n')
  }
}

async function removeGitignoreEntry(root, entry) {
  const gitignorePath = path.join(root, '.gitignore')
  try {
    const content = await fs.readFile(gitignorePath, 'utf8')
    const lines = content.split(/\r?\n/)
    const filtered = lines.filter((l) => l.trim() !== entry && l.trim() !== entry.replace(/\/$/, ''))
    if (filtered.length !== lines.length) {
      await fs.writeFile(gitignorePath, filtered.join('\n'), 'utf8')
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      return
    }
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

async function isQdrantUp(url) {
  try {
    const res = await fetch(`${url}`)
    return res.ok
  } catch (_) {
    return false
  }
}

async function loadState(statePath) {
  try {
    const text = await fs.readFile(statePath, 'utf8')
    return JSON.parse(text)
  } catch (e) {
    if (e.code === 'ENOENT') {
      return null
    }
    throw e
  }
}

async function saveState(paths, patch) {
  const existing = (await loadState(paths.statePath)) || {}
  const next = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString()
  }
  await fs.writeFile(paths.statePath, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

async function ensureInitialized() {
  const root = await findProjectRoot(startCwd)
  const paths = getPaths(root)
  const exists = await pathExists(paths.dotDir)
  if (!exists) {
    fail('CLI is not initialized. Run "indexer init" in the project root.')
  }
  const state = (await loadState(paths.statePath)) || {}
  return {root, paths, state}
}

async function readEnvFile(envPath) {
  const env = {}
  try {
    const text = await fs.readFile(envPath, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) {
        continue
      }
      const idx = line.indexOf('=')
      if (idx === -1) {
        continue
      }
      const key = line.slice(0, idx)
      const val = line.slice(idx + 1)
      env[key] = val
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e
    }
  }
  return env
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

async function handleInit() {
  if (isInsideIndexer(startCwd)) {
    fail('Do not run init from inside .indexer/. Go to project root.')
  }

  // --- System Check ---
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

  // --- Auto-setup Ollama Model ---
  // We try to pull the model if Ollama is present (which it should be if sys.ok is true)
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
  await handleCleanIndex()

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

async function checkLatestVersion() {
  try {
    // Check npm registry with short timeout
    const res = await fetch('https://registry.npmjs.org/@dnaroid/mcp-code-indexer/latest', {
        signal: AbortSignal.timeout ? AbortSignal.timeout(2000) : undefined // AbortSignal.timeout requires Node 17.3+
    })
    if (res.ok) {
      const json = await res.json()
      return json.version
    }
  } catch (_) {}
  return null
}

async function handleStatus() {
  const {paths, state} = await ensureInitialized()
  const env = await readEnvFile(paths.envPath)

  const qdrantUrl = env.QDRANT_URL || 'http://localhost:6333'
  const ollamaUrl = env.OLLAMA_URL || 'http://127.0.0.1:11434'

  const qdrantUp = await isQdrantUp(qdrantUrl)
  const ollamaUp = await isOllamaUp(ollamaUrl)

  const count = qdrantUp ? await countIndexed(env) : null
  
  // Check version
  const currentVersion = '1.0.0'
  const latestVersion = await checkLatestVersion()

  log(`Project: ${state.projectId || path.basename(paths.root)}`)
  log(`Root: ${paths.root}`)
  log(`Collection: ${state.collectionName || env.QDRANT_COLLECTION || 'n/a'}`)
  log(`Qdrant: ${qdrantUp ? 'running' : 'stopped'}`)
  log(`Ollama: ${ollamaUp ? 'running' : 'stopped'}`)
  log(`Indexer: Managed by MCP server (auto-starts on connect)`)
  log(`CLI Version: ${currentVersion}`)

  if (latestVersion && latestVersion !== currentVersion) {
    console.log(`\n************************************************`)
    console.log(`*  New version available: ${latestVersion}          *`)
    console.log(`*  Run "indexer update" to upgrade.            *`)
    console.log(`************************************************\n`)
  }

  if (count !== null) {
    log(`Indexed points: ${count}`)
  }

  await saveState(paths, {lastCommand: 'status'})
}

async function handleCleanIndex() {
  const {paths} = await ensureInitialized()
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

async function handleMcp() {
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

async function removeCodexArgsIndexer(codexArgsPath) {
  try {
    const text = await fs.readFile(codexArgsPath, 'utf8')
    const lines = text.split('\n').filter(line => !line.includes('mcp_servers.indexer'))
    if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
      await fs.unlink(codexArgsPath)
    } else {
      await fs.writeFile(codexArgsPath, lines.join('\n'), 'utf8')
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      warn(`Skipping .codex-cmd-args cleanup: ${e.message}`)
    }
  }
}

async function handleUninstall() {
  const root = await findProjectRoot(startCwd)
  const paths = getPaths(root)
  if (!(await pathExists(paths.dotDir))) {
    fail('No .indexer/ in this project to uninstall.')
  }

  // Try to drop collection from Qdrant first
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
  await removeCodexArgsIndexer(paths.codexArgsPath)
  await removeReadmeCliSection(root)

  log('Removed .indexer/ and cleaned up configs.')
}

async function handleUpdate() {
  log('Checking for updates...')
  try {
    const pkgName = '@dnaroid/mcp-code-indexer' // Hardcoded for now or read from package.json
    const spawnUpdate = spawn('npm', ['install', '-g', `${pkgName}@latest`], {
      stdio: 'inherit',
      shell: true
    })
    
    spawnUpdate.on('close', (code) => {
      if (code === 0) {
        log('Successfully updated to the latest version.')
      } else {
        fail('Update failed. Please run "npm install -g @dnaroid/mcp-code-indexer" manually.')
      }
    })
  } catch (e) {
    fail(`Update failed: ${e.message}`)
  }
}

async function pickOption(options, initial = 0) {
  if (!process.stdin.isTTY) {
    console.log('Select action:')
    options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}`))
    const rl = createInterface({input, output})
    const answer = (await rl.question(`Choice [1-${options.length}/q]: `)).trim().toLowerCase()
    rl.close()
    if (answer === 'q' || answer === 'quit' || answer === 'exit') {
      return 'exit'
    }
    const n = Number(answer)
    if (Number.isInteger(n) && n >= 1 && n <= options.length) {
      return options[n - 1].value
    }
    return 'exit'
  }

  return await new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin)
    const wasRaw = process.stdin.isRaw
    const wasPaused = typeof process.stdin.isPaused === 'function' ? process.stdin.isPaused() : undefined
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
    }
    if (wasPaused) {
      process.stdin.resume()
    }
    let idx = initial
    let firstRender = true
    const linesCount = options.length + 1

    const render = () => {
      if (!firstRender) {
        process.stdout.write(`\u001b[${linesCount}A\u001b[0J`)
      }
      process.stdout.write('Select action (↑/↓, Enter, q to quit):\n')
      options.forEach((opt, i) => {
        const prefix = i === idx ? '>' : ' '
        process.stdout.write(`${prefix} ${opt.label}\n`)
      })
      firstRender = false
    }

    const cleanup = () => {
      process.stdin.removeListener('keypress', onKey)
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(wasRaw || false)
      }
      if (wasPaused) {
        process.stdin.pause()
      }
      process.stdout.write(`\u001b[${linesCount}A\u001b[0J`)
      process.stdout.write('\n')
    }

    const onKey = (str, key) => {
      if (key.name === 'down') {
        idx = (idx + 1) % options.length
        render()
      } else if (key.name === 'up') {
        idx = (idx - 1 + options.length) % options.length
        render()
      } else if (key.name === 'return') {
        cleanup()
        resolve(options[idx].value)
      } else if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
        cleanup()
        resolve('exit')
      } else if (/^[1-9]$/.test(str)) {
        const n = Number(str) - 1
        if (n >= 0 && n < options.length) {
          idx = n
          render()
        }
      }
    }

    render()
    process.stdin.on('keypress', onKey)
  })
}

function printHelp() {
  console.log(`indexer CLI (Local Mode)\n\n` +
              `Usage:\n` +
              `  indexer init         # create .indexer/ configs
` +
              `  indexer clean        # drop & reindex current project (alias: clear)
` +
              `  indexer status       # show status
` +
              `  indexer collections  # list all Qdrant collections
` +
              `  indexer delete <id>  # delete specific collection
` +
              `  indexer prune        # delete ALL collections
` +
              `  indexer update       # update CLI to latest version
` +
              `  indexer uninstall    # remove .indexer/
` +
              `  indexer mcp          # run MCP server (internal usage)\n`)
}

async function interactiveMenu() {
  const options = [
    {label: 'init        - create .indexer/ config', value: 'init'},
    {label: 'clean       - drop & rebuild index (alias: clear)', value: 'clean'},
    {label: 'status      - show status', value: 'status'},
    {label: 'collections - list global Qdrant collections', value: 'collections'},
    {label: 'prune       - delete ALL collections', value: 'prune'},
    {label: 'update      - update CLI to latest version', value: 'update'},
    {label: 'uninstall   - remove .indexer/', value: 'uninstall'},
    {label: 'quit', value: 'exit'}
  ]

  while (true) {
    const choice = await pickOption(options)
    if (!choice || choice === 'exit') {
      return
    }

    console.log(`> indexer ${choice}`)

    switch(choice) {
    case 'init':
      await handleInit()
      break
    case 'status':
      await handleStatus()
      break
    case 'clean':
    case 'clear':
      await handleCleanIndex()
      break
    case 'collections':
      await handleListCollections()
      break
    case 'prune':
      await handlePruneAll()
      break
    case 'update':
      await handleUpdate()
      break
    case 'uninstall':
      await handleUninstall()
      break
    default:
      break
    }

    console.log('---')
  }
}

async function main() {
  if (!command) {
    await interactiveMenu()
    process.exit(0)
  }

  switch(command) {
  case 'init':
    await handleInit()
    break
  case 'clean':
  case 'clear':
    await handleCleanIndex()
    break
  case 'uninstall':
    await handleUninstall()
    break
  case 'update':
    await handleUpdate()
    break
  case 'status':
    await handleStatus()
    break
  case 'collections':
  case 'list':
  case 'ls':
    await handleListCollections()
    break
  case 'delete':
  case 'rm':
    await handleDeleteCollection(args[1])
    break
  case 'prune':
    await handlePruneAll()
    break
  case 'mcp':
    await handleMcp()
    break
  case 'help':
  case '--help':
  case '-h':
    printHelp()
    break
  case 'version':
  case '--version':
    console.log('1.0.0')
    break
  default:
    fail(`Unknown command: ${command}`)
  }

  if (command !== 'mcp') {
    // Background check for updates (only if not running mcp server)
    checkUpdateInBackground()
    process.exit(0)
  }
}

async function checkUpdateInBackground() {
  // We can't really do background check easily before exit in Node unless we detach a child process.
  // Instead, let's do a quick check with timeout if running interactive menu or specific commands.
  // Actually, for a CLI, 'update-notifier' is best but we want zero dependencies.
  // Let's just rely on manual 'indexer update' for now to keep it simple and fast.
  // The 'indexer update' command is already implemented.
}

main().catch((e) => {
  fail(e.message)
})
