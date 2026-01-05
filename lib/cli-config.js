import fs from 'fs/promises'
import path from 'path'
import {fail, log, warn} from './cli-ui.js'

export function isInsideIndexer(dir) {
  return dir.split(path.sep).includes('.indexer')
}

export function stripIndexer(dir) {
  const parts = dir.split(path.sep)
  const idx = parts.lastIndexOf('.indexer')
  if (idx === -1) {
    return dir
  }
  const trimmed = parts.slice(0, idx).join(path.sep)
  return trimmed || path.parse(dir).root
}

export async function pathExists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

export async function findProjectRoot(startDir) {
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

export function slugify(name) {
  const clean = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  return clean || 'project'
}

export function getPaths(root) {
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

export function renderEnv({projectId, collectionName, workspaceDir}) {
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

export async function readEnvFile(envPath) {
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

export async function loadState(statePath) {
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

export async function saveState(paths, patch) {
  const existing = (await loadState(paths.statePath)) || {}
  const next = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString()
  }
  await fs.writeFile(paths.statePath, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

// --- Config manipulation helpers ---

export async function upsertRootMcpConfig(paths) {
  const indexerConfig = {
    command: 'indexer',
    args: ['mcp', `--cwd=${paths.root}`]
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

export async function upsertKilocodeMcpConfig(paths) {
  const targets = ['kilocode/mcp.json', '.kilocode/mcp.json']

  for (const rel of targets) {
    const targetPath = path.join(paths.root, rel)
    if (!(await pathExists(targetPath))) {
      continue
    }

    const indexerConfig = {
      command: 'indexer',
      args: ['mcp', `--cwd=${paths.root}`]
    }

    let data = {}
    try {
      const text = await fs.readFile(targetPath, 'utf8')
      data = JSON.parse(text)
    } catch (e) {
      warn(`Invalid ${rel}: ${e.message}`)
      continue
    }

    data.mcpServers = {
      ...(data.mcpServers || {}),
      indexer: indexerConfig
    }

    try {
      await fs.writeFile(targetPath, JSON.stringify(data, null, 2) + '\n', 'utf8')
      log(`Updated ${rel} with indexer config`)
    } catch (e) {
      warn(`Failed to update ${rel}: ${e.message}`)
    }
  }
}

export async function upsertGeminiMcpConfig(paths) {
  const geminiPath = path.join(paths.root, '.gemini', 'settings.json')

  if (!(await pathExists(geminiPath))) {
    return
  }

  const indexerConfig = {
    command: 'indexer',
    args: ['mcp', `--cwd=${paths.root}`]
  }

  let data = {}
  try {
    const text = await fs.readFile(geminiPath, 'utf8')
    data = JSON.parse(text)
  } catch (e) {
    warn(`Invalid .gemini/settings.json: ${e.message}`)
    return
  }

  data.mcpServers = {
    ...(data.mcpServers || {}),
    indexer: indexerConfig
  }

  try {
    await fs.writeFile(geminiPath, JSON.stringify(data, null, 2) + '\n', 'utf8')
    log('Updated .gemini/settings.json with indexer config')
  } catch (e) {
    warn(`Failed to update .gemini/settings.json: ${e.message}`)
  }
}

export async function upsertCodexArgsConfig(paths) {
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

export async function upsertReadmeCliSection(root) {
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

export async function ensureGitignoreEntry(root, entry) {
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

export async function removeRootMcpIndexer(rootMcpPath) {
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

export async function removeKilocodeMcpIndexer(root) {
  const targets = ['kilocode/mcp.json', '.kilocode/mcp.json']

  for (const rel of targets) {
    const targetPath = path.join(root, rel)
    if (!(await pathExists(targetPath))) {
      continue
    }

    try {
      const text = await fs.readFile(targetPath, 'utf8')
      const data = JSON.parse(text)
      if (!data.mcpServers || !data.mcpServers.indexer) {
        continue
      }

      const {['indexer']: _, ...rest} = data.mcpServers
      data.mcpServers = rest

      if (Object.keys(data.mcpServers).length === 0) {
        delete data.mcpServers
      }

      await fs.writeFile(targetPath, JSON.stringify(data, null, 2) + '\n', 'utf8')
      log(`Removed indexer config from ${rel}`)
    } catch (e) {
      warn(`Skipping ${rel} cleanup: ${e.message}`)
    }
  }
}

export async function removeGeminiMcpIndexer(root) {
  const geminiPath = path.join(root, '.gemini', 'settings.json')

  if (!(await pathExists(geminiPath))) {
    return
  }

  try {
    const text = await fs.readFile(geminiPath, 'utf8')
    const data = JSON.parse(text)
    if (!data.mcpServers || !data.mcpServers.indexer) {
      return
    }

    const {['indexer']: _, ...rest} = data.mcpServers
    data.mcpServers = rest

    if (Object.keys(data.mcpServers).length === 0) {
      delete data.mcpServers
    }

    await fs.writeFile(geminiPath, JSON.stringify(data, null, 2) + '\n', 'utf8')
    log('Removed indexer config from .gemini/settings.json')
  } catch (e) {
    warn(`Skipping .gemini/settings.json cleanup: ${e.message}`)
  }
}

export async function removeCodexArgsIndexer(codexArgsPath) {
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

export async function removeReadmeCliSection(root) {
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

export async function removeGitignoreEntry(root, entry) {
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
