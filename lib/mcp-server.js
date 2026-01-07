import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'
import path from 'path'
import {z} from 'zod'
import {spawn} from 'child_process'
import {fileURLToPath} from 'url'
import {initTreeSitter} from './tree-sitter.js'
import {log} from './cli-ui.js'

let SERVICE_PORT = 3000 // Will be loaded from config
let SERVICE_URL = `http://127.0.0.1:${SERVICE_PORT}`

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

// --- Service Discovery & Management ---

// Generate unique client ID for this MCP server instance
const CLIENT_ID = `mcp-${process.pid}-${Date.now()}`

async function isServiceUp() {
  try {
    const res = await fetch(`${SERVICE_URL}/health`, { signal: AbortSignal.timeout(2000) })
    if (res.ok) {
      const data = await res.json()
      console.log(`[mcp-server] Service is up at ${SERVICE_URL}, PID: ${data.pid}`)
      return true
    }
    return false
  } catch (e) {
    console.log(`[mcp-server] Service is NOT up at ${SERVICE_URL}: ${e.message}`)
    return false
  }
}

async function ensureServiceRunning() {
  if (await isServiceUp()) {
    console.log(`[mcp-server] Service already running, skipping start`)
    return
  }

  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const servicePath = path.join(__dirname, 'indexer-service.js')

  console.error(`[mcp-server] Starting indexer service: ${servicePath}`)

  const child = spawn('node', [servicePath], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'], // Capture stdout and stderr for error logging
    env: process.env
  })

  console.log(`[mcp-server] Spawned indexer service with PID: ${child.pid}`)

  // Capture stderr for error logging
  let errorOutput = ''
  child.stderr.on('data', (data) => {
    errorOutput += data.toString()
  })

  // Handle spawn errors
  child.on('error', (err) => {
    console.error(`[mcp-server] Failed to spawn indexer service: ${err.message}`)
    throw new Error(`Failed to spawn indexer service: ${err.message}`)
  })

  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`[mcp-server] Indexer service exited with code ${code}`)
      if (errorOutput) {
        console.error(`[mcp-server] Error output:\n${errorOutput}`)
      }
    }
  })

  child.unref()

  // Wait for it to come up
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (await isServiceUp()) {
      console.log(`[mcp-server] Service is now up and running`)
      return
    }
    await new Promise(r => setTimeout(r, 500))
  }

  // If we get here, the service didn't start in time
  console.error(`[mcp-server] Timed out waiting for indexer service`)
  if (errorOutput) {
    console.error(`[mcp-server] Error output from indexer service:\n${errorOutput}`)
  }
  throw new Error('Timed out waiting for indexer service')
}

async function registerProject(projectPath) {
  const res = await fetch(`${SERVICE_URL}/register`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({path: projectPath})
  })
  if (!res.ok) {
    throw new Error(`Failed to register project: ${res.statusText}`)
  }
}

async function queryService(projectPath, tool, args) {
  const res = await fetch(`${SERVICE_URL}/query`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({path: projectPath, tool, args})
  })
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`Service query failed: ${txt}`)
  }
  return res.json()
}

// --- Heartbeat ---

async function sendHeartbeat() {
  try {
    await fetch(`${SERVICE_URL}/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': CLIENT_ID
      }
    })
  } catch (e) {
    // Ignore errors, service may be closed
  }
}

// --- Proxy Handlers ---

function createProxyHandlers(projectPath) {
  return {
    search_codebase: async (args) => {
      await sendHeartbeat()
      return queryService(projectPath, 'search_codebase', args)
    },
    search_symbols: async (args) => {
      await sendHeartbeat()
      return queryService(projectPath, 'search_symbols', args)
    },
    get_file_outline: async (args) => {
      await sendHeartbeat()
      return queryService(projectPath, 'get_file_outline', args)
    },
    get_project_structure: async (args) => {
      await sendHeartbeat()
      return queryService(projectPath, 'get_project_structure', args)
    },
    find_usages: async (args) => {
      await sendHeartbeat()
      return queryService(projectPath, 'find_usages', args)
    }
  }
}

export function createMcpServer(projectPath) {
  const handlers = createProxyHandlers(projectPath)

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
    'find_usages',
    {
      description: 'Find usages of a symbol, optionally filtered by context (e.g. class name)',
      inputSchema: {
        symbol: z.string().describe('Symbol name or qualified name (e.g. "takeDamage" or "Enemy.takeDamage")'),
        context: z.string().optional().describe('Context symbol to filter by (e.g. "Enemy")')
      }
    },
    handlers.find_usages
  )

  return server
}

export async function startMcpServer(startCwd, args, projectPathArg = null) {
  log(`Starting MCP server from ${startCwd} for project ${projectPathArg || 'all registered'}...`)
  await initTreeSitter()

  // Load service port from config
  const {loadGlobalConfig, getProjectConfig, DEFAULT_SETTINGS} = await import('./config-global.js')
  const config = await loadGlobalConfig()

  // Check if there are any registered projects
  const projectPaths = Object.keys(config.projects)
  if (projectPaths.length === 0) {
    console.error(`[mcp-server] ERROR: No projects registered in global config`)
    console.error(`[mcp-server] Please run 'indexer init' in your project directory first`)
    console.error(`[mcp-server] Global config location: ${process.env.HOME}/.indexer/config.json`)
    throw new Error('No projects registered. Run "indexer init" first.')
  }

  console.log(`[mcp-server] Found ${projectPaths.length} registered project(s)`)

  const firstProjectPath = projectPathArg || projectPaths[0]
  if (firstProjectPath) {
    const projectConf = await getProjectConfig(firstProjectPath)
    if (projectConf && projectConf.settings.SERVICE_PORT) {
      SERVICE_PORT = projectConf.settings.SERVICE_PORT
      SERVICE_URL = `http://127.0.0.1:${SERVICE_PORT}`
      console.log(`[mcp-server] Using service port from project config: ${SERVICE_PORT}`)
    } else {
      // Use default from DEFAULT_SETTINGS
      SERVICE_PORT = DEFAULT_SETTINGS.SERVICE_PORT
      SERVICE_URL = `http://127.0.0.1:${SERVICE_PORT}`
      console.log(`[mcp-server] Using default service port: ${SERVICE_PORT}`)
    }
  } else {
    // No projects, use default
    SERVICE_PORT = DEFAULT_SETTINGS.SERVICE_PORT
    SERVICE_URL = `http://127.0.0.1:${SERVICE_PORT}`
    console.log(`[mcp-server] No projects, using default service port: ${SERVICE_PORT}`)
  }

  // Use ensureServiceRunning instead of startIndexerService
  await ensureServiceRunning()

  // Регистрируем проект, если указан
  if (projectPathArg) {
    await registerProject(projectPathArg)
  }

  // Создаем и запускаем MCP сервер через stdio
  const server = createMcpServer(projectPathArg || startCwd)
  const transport = new StdioServerTransport()
  await server.connect(transport)

  log(`MCP server started.`)
}
