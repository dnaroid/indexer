import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'
import fetch from 'node-fetch'
import fs from 'fs/promises'
import path from 'path'
import {z} from 'zod'
import {spawn} from 'child_process'
import {fileURLToPath} from 'url'
import {listProjectFiles} from './indexer-core.js'
import {
  extractSymbols,
  buildTreeText,
  runRipgrep,
  detectLanguage
} from './mcp-tools.js'
import {initTreeSitter} from './tree-sitter.js'

export const CODEBASE_PROMPT = [
  'You are an expert developer working in this codebase.',
  '',
  'Available MCP Tools & When to Use Them:',
  '1. search_codebase: Use for semantic/conceptual searches (e.g., "how is authentication handled?").',
  '2. search_symbols: Use to find specific definitions of classes, methods, or Unity-specific fields.',
  '3. get_file_outline: Use to quickly see the structure of a file without reading all its code. Essential for large files.',
  '4. get_project_structure: Use to understand the project architecture and locate files.',
  '5. find_references: Use for impact analysis before refactoring or to see how a symbol is used.',
  '',
  'Workflow:',
  '- Start with get_project_structure to orient yourself.',
  '- Use search_codebase or search_symbols to find relevant logic.',
  '- Use get_file_outline to inspect a file before reading it with read_file.',
  '- Use find_references to ensure changes don\'t break other parts of the system.',
  '',
  'Unity Specifics:',
  '- Lifecycle methods (Awake, Start, Update) are called by the engine, not explicitly in code.',
  '- [SerializeField] and ScriptableObjects indicate data configured in the Unity Inspector.'
].join('\n')

// --- Service Management ---

function getQdrantUrl() { return process.env.QDRANT_URL || 'http://localhost:6333' }

function getQdrantCollection() { return process.env.QDRANT_COLLECTION || 'project_index' }

function getOllamaUrl() { return process.env.OLLAMA_URL || 'http://127.0.0.1:11434' }

function getEmbedModel() { return process.env.EMBED_MODEL || 'nomic-embed-text' }

function getTopKDefault() { return Number(process.env.TOP_K_DEFAULT || '5') }

function getScoreThreshold() { return Number(process.env.SCORE_THRESHOLD || '0') }

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

function startQdrantDetached() {
  console.error('[mcp] Starting Qdrant...')
  const child = spawn('qdrant', [], {
    stdio: 'ignore',
    detached: true
  })
  child.unref()
}

function startOllamaDetached() {
  console.error('[mcp] Starting Ollama...')
  const child = spawn('ollama', ['serve'], {
    stdio: 'ignore',
    detached: true
  })
  child.unref()
}

async function waitForService(checkFn, url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await checkFn(url)) {
      return true
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  return false
}

async function ensureServicesRunning() {
  const qdrantUrl = getQdrantUrl()
  const ollamaUrl = getOllamaUrl()

  if (!(await isQdrantUp(qdrantUrl))) {
    startQdrantDetached()
    await waitForService(isQdrantUp, qdrantUrl)
  }
  if (!(await isOllamaUp(ollamaUrl))) {
    startOllamaDetached()
    await waitForService(isOllamaUp, ollamaUrl)
  }
}

// --- Indexer Daemon Management ---

let daemonProcess = null
let daemonPidFile = null

async function startIndexerDaemon() {
  const workspaceDir = process.env.WORKSPACE_DIR || process.cwd()
  const pidFile = path.join(workspaceDir, '.indexer', 'indexer.pid')

  try {
    const pidText = await fs.readFile(pidFile, 'utf8')
    const pid = parseInt(pidText, 10)
    if (pid) {
      try {
        process.kill(pid, 0)
        console.error(`[mcp] Indexer daemon already running (PID: ${pid}).`)
        return
      } catch (_) {
        // stale
      }
    }
  } catch (_) {}

  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const daemonPath = path.join(__dirname, 'indexer-daemon.js')

  console.error(`[mcp] Starting indexer daemon: ${daemonPath}`)

  daemonProcess = spawn('node', [daemonPath], {
    env: process.env,
    cwd: workspaceDir,
    stdio: ['ignore', process.stderr, process.stderr]
  })

  try {
    await fs.writeFile(pidFile, String(daemonProcess.pid), 'utf8')
    daemonPidFile = pidFile
  } catch (e) {
    console.error(`[mcp] Failed to write PID file: ${e.message}`)
  }

  daemonProcess.on('exit', (code, signal) => {
    if (code || signal) {
      console.error(`[mcp] Daemon exited with code ${code} / signal ${signal}`)
    }
    if (daemonPidFile) {
      fs.unlink(daemonPidFile).catch(() => {})
      daemonPidFile = null
    }
  })
}

async function cleanup() {
  if (daemonProcess) {
    daemonProcess.kill()
    daemonProcess = null
  }
  if (daemonPidFile) {
    try {
      await fs.unlink(daemonPidFile)
    } catch (_) {}
    daemonPidFile = null
  }
}

// --- MCP Server Logic ---

async function embed(text) {
  const res = await fetch(`${getOllamaUrl()}/api/embeddings`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({model: getEmbedModel(), prompt: text})
  })
  const json = await res.json()
  return json.embedding
}

async function searchQdrant(vector, topK, pathPrefix) {
  const filter = pathPrefix
    ? {must: [{key: 'path', match: {prefix: pathPrefix}}]}
    : undefined

  const res = await fetch(
    `${getQdrantUrl()}/collections/${getQdrantCollection()}/points/search`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        vector,
        limit: topK,
        with_payload: true,
        score_threshold: getScoreThreshold(),
        filter
      })
    }
  )
  const json = await res.json()
  return json.result || []
}

async function searchSymbols(name, kind, topK) {
  const must = [{key: 'symbol_names', match: {text: name}}]
  if (kind && kind !== 'any') {
    must.push({key: 'symbol_kinds', match: {any: [kind]}})
  }

  const res = await fetch(
    `${getQdrantUrl()}/collections/${getQdrantCollection()}/points/scroll`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({filter: {must}, with_payload: true, limit: topK})
    }
  )
  const json = await res.json()
  return json.result?.points || json.result || []
}

// Dependencies map to allow injection
const defaultDeps = {
  searchQdrant,
  searchSymbols,
  embed,
  listProjectFiles,
  extractSymbols,
  buildTreeText,
  runRipgrep,
  readFile: fs.readFile
}

export function createToolHandlers(deps = defaultDeps) {
  return {
    search_codebase: async ({query, top_k = getTopKDefault(), path_prefix}) => {
      const queryVector = await deps.embed(query)
      const results = await deps.searchQdrant(queryVector, top_k, path_prefix)

      const formatted = results.map((r, i) => {
        const p = r.payload || {}
        return {
          rank: i + 1,
          path: p.path,
          start_line: p.start_line,
          end_line: p.end_line,
          snippet: p.text,
          score: r.score,
          symbol_names: p.symbol_names,
          symbol_kinds: p.symbol_kinds,
          unity_tags: p.unity_tags
        }
      })

      return {content: [{type: 'text', text: JSON.stringify(formatted, null, 2)}]}
    },

    search_symbols: async ({name, kind = 'any', top_k = 10}) => {
      const results = await deps.searchSymbols(name, kind, top_k)

      const formatted = results.map((r, i) => {
        const p = r.payload || {}
        return {
          rank: i + 1,
          path: p.path,
          start_line: p.start_line,
          end_line: p.end_line,
          symbol_names: p.symbol_names,
          symbol_kinds: p.symbol_kinds,
          unity_tags: p.unity_tags,
          snippet: p.text,
          score: r.score
        }
      })

      return {content: [{type: 'text', text: JSON.stringify(formatted, null, 2)}]}
    },

    get_file_outline: async ({path: filePath}) => {
      const abs = path.resolve(process.env.WORKSPACE_DIR || process.cwd(), filePath)
      const content = await deps.readFile(abs, 'utf8')
      const symbols = await deps.extractSymbols(filePath, content)

      const formatted = symbols.map(s => ({
        name: s.name,
        kind: s.kind,
        line: s.start
      }))

      return {content: [{type: 'text', text: JSON.stringify(formatted, null, 2)}]}
    },

    get_project_structure: async () => {
      const files = await deps.listProjectFiles()
      const treeText = deps.buildTreeText(files)
      return {content: [{type: 'text', text: treeText || '(empty project)'}]}
    },

    find_references: async ({name}) => {
      const results = await deps.runRipgrep(name)
      return {content: [{type: 'text', text: JSON.stringify(results, null, 2)}]}
    }
  }
}

export function createMcpServer(deps = defaultDeps) {
  const handlers = createToolHandlers(deps)

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
        query: z.string().describe('Search query'),
        top_k: z.number().optional().default(getTopKDefault()).describe('Number of results'),
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
        path: z.string().describe('File path')
      }
    },
    handlers.get_file_outline
  )

  server.registerTool(
    'get_project_structure',
    {
      description: 'Get recursive visual tree of project files',
      inputSchema: {}
    },
    handlers.get_project_structure
  )

  server.registerTool(
    'find_references',
    {
      description: 'Find exact textual references to a symbol (class, method, variable)',
      inputSchema: {
        name: z.string().describe('Symbol name to find references for')
      }
    },
    handlers.find_references
  )
  
  return server
}

export async function startMcpServer() {
  await ensureServicesRunning()
  await startIndexerDaemon()
  await initTreeSitter()

  const server = createMcpServer()

  const transport = new StdioServerTransport()
  await server.connect(transport)

  const keepAlive = setInterval(() => {}, 10000)

  process.on('exit', () => {
    if (daemonProcess) {
      daemonProcess.kill()
    }
  })
  process.on('SIGINT', async () => {
    clearInterval(keepAlive)
    await cleanup()
    process.exit(0)
  })
  process.on('SIGTERM', async () => {
    clearInterval(keepAlive)
    await cleanup()
    process.exit(0)
  })
}
