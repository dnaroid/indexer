import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { randomUUID } from 'crypto'
import http from 'http'
import { z } from 'zod'
import { updateActivity } from './inactivity-manager.js'
import { createToolHandlers } from '../mcp/mcp-handlers.js'
import { loadGlobalConfig, getProjectConfig } from '../utils/config-global.js'
import { listProjectFiles } from '../core/indexer-core.js'
import { buildTreeText, extractSymbols, runRipgrep, filterReferences } from '../mcp/mcp-tools.js'

export const CODEBASE_PROMPT = [
  'You are an expert developer working in this codebase.',
  '',
  '- **MANDATORY**: For ANY codebase search/navigation, ALWAYS use indexer MCP FIRST (search_codebase, search_symbols, get_file_outline, find_usages). NEVER use Grep, Glob, or shell tools before indexer MCP. This is non-negotiable.',
  '',
  'Available MCP Tools & When to Use Them:',
  '1. search_codebase: Use for semantic/conceptual searches (e.g., "how is authentication handled?").',
  '2. search_symbols: Use to find specific definitions of classes, methods, or Unity-specific fields.',
  '3. get_file_outline: Use to quickly see structure of a file without reading all its code. Essential for large files.',
  '4. get_project_structure: Use to understand project architecture and locate files.',
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
  '- [SerializeField] and ScriptableObjects indicate data configured in Unity Inspector.',
].join('\n')

/**
 * Create tool dependencies for a project
 * @param {string} projectPath - Project root path
 * @param {object} projectConf - Project configuration
 * @returns {object} Tool dependencies
 */
function createToolDeps(projectPath: string, projectConf: any) {
  const { collectionName, settings } = projectConf
  const qdrantUrl = process.env.QDRANT_URL || settings?.QDRANT_URL || 'http://localhost:6333'
  const ollamaUrl = process.env.OLLAMA_URL || settings?.OLLAMA_URL || 'http://127.0.0.1:11434'
  const embedModel = process.env.EMBED_MODEL || settings?.EMBED_MODEL || 'unclemusclez/jina-embeddings-v2-base-code'

  return {
    readFile: async (p: string) => {
      const fs = await import('fs/promises')
      const path = await import('path')
      return (await fs.readFile(path.resolve(projectPath, p), 'utf8'))
    },

    embed: async (text: string): Promise<number[]> => {
      const res = await fetch(`${ollamaUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: embedModel,
          prompt: text
        })
      })
      const json: any = await res.json()
      return json.embedding
    },

    searchQdrant: async (vector: number[], topK: number, pathPrefix?: string) => {
      const filter = pathPrefix
        ? { must: [{ key: 'path', match: { prefix: pathPrefix } }] }
        : undefined

      const res = await fetch(
        `${qdrantUrl}/collections/${collectionName}/points/search`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vector,
            limit: topK,
            with_payload: true,
            score_threshold: settings?.SCORE_THRESHOLD || 0,
            filter
          })
        }
      )
      const json: any = await res.json()
      return json.result || []
    },

    searchSymbols: async (name: string, kind: string, topK: number) => {
      const must: any[] = [
        {
          should: [
            { key: 'symbol_names', match: { text: name } },
            { key: 'symbol_references', match: { text: name } }
          ]
        }
      ]
      if (kind && kind !== 'any') {
        must.push({ key: 'symbol_kinds', match: { any: [kind] } })
      }

      const res = await fetch(
        `${qdrantUrl}/collections/${collectionName}/points/scroll`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filter: { must }, with_payload: true, limit: topK })
        }
      )
      const json: any = await res.json()
      return json.result?.points || json.result || []
    },

    listProjectFiles: () => listProjectFiles(projectPath),
    extractSymbols,
    buildTreeText,
    runRipgrep: (symbol: string) => runRipgrep(symbol, projectPath),
    filterReferences
  }
}

/**
 * Execute a query for a specific collection
 * @param {object} params - Query parameters
 * @returns {Promise<object>} Query result
 */
export async function executeQuery({ collectionId, tool, args }: { collectionId: string, tool: string, args: any }): Promise<any> {
  // Find project by collectionId
  const config = await loadGlobalConfig()
  let projectPath = null
  let projectConf = null

  for (const [path, data] of Object.entries(config.projects)) {
    if ((data as any).collectionName === collectionId) {
      projectPath = path
      projectConf = await getProjectConfig(path)
      break
    }
  }

  if (!projectConf) {
    throw new Error(`Collection not found: ${collectionId}`)
  }

  const deps = createToolDeps(projectPath, projectConf) as any
  const handlers = createToolHandlers(deps)

  if (!handlers[tool]) {
    throw new Error(`Unknown tool: ${tool}`)
  }

  const result = await handlers[tool](args)
  return result
}

/**
 * Create MCP handlers
 * @returns {object} MCP handlers
 */
function createMcpHandlers() {
  return {
    search_codebase: async (args: any) => {
      updateActivity()
      return executeQuery({ collectionId: args.collectionId, tool: 'search_codebase', args })
    },
    search_symbols: async (args: any) => {
      updateActivity()
      return executeQuery({ collectionId: args.collectionId, tool: 'search_symbols', args })
    },
    get_file_outline: async (args: any) => {
      updateActivity()
      return executeQuery({ collectionId: args.collectionId, tool: 'get_file_outline', args })
    },
    get_project_structure: async (args: any) => {
      updateActivity()
      return executeQuery({ collectionId: args.collectionId, tool: 'get_project_structure', args })
    },
    find_usages: async (args: any) => {
      updateActivity()
      return executeQuery({ collectionId: args.collectionId, tool: 'find_usages', args })
    }
  }
}

/**
 * Create MCP server instance
 * @returns {McpServer} MCP server instance
 */
export function createMcpServer() {
  const handlers = createMcpHandlers()

  const server = new McpServer({
    name: 'code-index',
    version: '0.1.0'
  })

  server.registerPrompt(
    'codebase_guidance',
    {
      title: 'Codebase Guidance',
      description: 'Guidance for working inside this codebase',
      argsSchema: z.object({}) as any
    },
    async () => {
      const messages = [
        {
          role: 'user',
          content: {
            type: 'text',
            text: CODEBASE_PROMPT
          }
        }
      ]
      return messages as any
    }
  )

  server.registerTool(
    'search_codebase',
    {
      description: 'Semantic search over indexed codebase',
      inputSchema: {
        collectionId: z.string().describe('Collection ID for project'),
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
        collectionId: z.string().describe('Collection ID for project'),
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
        collectionId: z.string().describe('Collection ID for project'),
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
        collectionId: z.string().describe('Collection ID for project')
      }
    },
    handlers.get_project_structure
  )

  server.registerTool(
    'find_usages',
    {
      description: 'Find usages of a symbol, optionally filtered by context (e.g. class name)',
      inputSchema: {
        collectionId: z.string().describe('Collection ID for project'),
        symbol: z.string().describe('Symbol name or qualified name (e.g. "takeDamage" or "Enemy.takeDamage")'),
        context: z.string().optional().describe('Context symbol to filter by (e.g. "Enemy")')
      }
    },
    handlers.find_usages
  )

  return server
}

/**
 * Start MCP server via stdio
 * @returns {Promise<void>}
 */
export async function startMcpServer(): Promise<void> {
  console.log('[mcp-service] Starting MCP server...')
  const server = createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.log('[mcp-service] MCP server connected via stdio')
}

/**
 * Start MCP server via HTTP for daemon mode (multi-client support)
 * @param {number} port - Port number to listen on
 * @returns {Promise<void>}
 */
export async function startMcpHttpServer(port: number): Promise<void> {
  console.log('[mcp-service] Starting HTTP MCP server...')
  const server = createMcpServer()

  // Use stateless mode - no session ID tracking
  // This allows multiple independent clients to connect without session conflicts
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // Stateless mode
    onsessioninitialized: (sessionId) => {
      console.log(`[mcp-service] Client connected`)
      updateActivity()
    },
    onsessionclosed: (sessionId) => {
      console.log(`[mcp-service] Client disconnected`)
    }
  })

  const httpServer = http.createServer((req, res) => {
    // Handle both GET (SSE) and POST (JSON) requests
    if (req.url === '/mcp' || req.url === '/sse') {
      if (req.method === 'POST') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', async () => {
          try {
            updateActivity()
            const parsed = JSON.parse(body)
            await transport.handleRequest(req, res, parsed)
          } catch (err: any) {
            console.error('[mcp-service] Error handling request:', err)
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: err.message }))
            }
          }
        })
      } else if (req.method === 'GET') {
        // Handle SSE GET requests
        try {
          updateActivity()
          transport.handleRequest(req, res).catch(err => {
            console.error('[mcp-service] Error handling GET request:', err)
          })
        } catch (err: any) {
          console.error('[mcp-service] Error handling GET request:', err)
          if (!res.headersSent) {
            res.writeHead(500)
            res.end()
          }
        }
      } else {
        res.writeHead(405)
        res.end()
      }
    } else {
      res.writeHead(404)
      res.end()
    }
  })

  await new Promise<void>((resolve) => {
    httpServer.listen(port, '127.0.0.1', () => {
      console.log(`[mcp-service] HTTP server listening on http://127.0.0.1:${port}`)
      resolve()
    })
  })

  await server.connect(transport)
  console.log('[mcp-service] MCP server connected via HTTP')
}
