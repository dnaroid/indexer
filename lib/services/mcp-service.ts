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
  '- collectionId is injected by the MCP proxy; do NOT try to compute or request it. Call tools without collectionId unless you are a custom client.',
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
  if (!collectionId) {
    throw new Error('Missing collectionId. The MCP proxy injects it automatically; custom clients must provide it explicitly.')
  }
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
        collectionId: z.string().optional().describe('Collection ID for project (injected by proxy; omit unless you are a custom client)'),
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
        collectionId: z.string().optional().describe('Collection ID for project (injected by proxy; omit unless you are a custom client)'),
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
        collectionId: z.string().optional().describe('Collection ID for project (injected by proxy; omit unless you are a custom client)'),
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
        collectionId: z.string().optional().describe('Collection ID for project (injected by proxy; omit unless you are a custom client)')
      }
    },
    handlers.get_project_structure
  )

  server.registerTool(
    'find_usages',
    {
      description: 'Find usages of a symbol, optionally filtered by context (e.g. class name)',
      inputSchema: {
        collectionId: z.string().optional().describe('Collection ID for project (injected by proxy; omit unless you are a custom client)'),
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

  // Handle transport close - exit process when connection closes
  transport.onclose = async () => {
    console.log('[mcp-service] Stdio transport closed, exiting...')
    process.exit(0)
  }

  await server.connect(transport)
  console.log('[mcp-service] MCP server connected via stdio')
}

/**
 * Start MCP server via HTTP for daemon mode (multi-client support)
 * Each client gets its own transport and server instance
 * @param {number} port - Port number to listen on
 * @returns {Promise<void>}
 */
export async function startMcpHttpServer(port: number): Promise<void> {
  console.log('[mcp-service] Starting HTTP MCP server...')

  // Map to store transport/server pairs by session ID
  const sessions = new Map<string, { transport: any, server: any }>()

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
            const sessionId = req.headers['mcp-session-id'] as string | undefined
            const isInitialize = parsed.method === 'initialize'

            if (isInitialize && !sessionId) {
              // New client - create new transport and server
              console.log('[mcp-service] New client connecting...')

              const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sid) => {
                  console.log(`[mcp-service] Session ${sid} initialized`)
                  updateActivity()
                },
                onsessionclosed: (sid) => {
                  console.log(`[mcp-service] Session ${sid} closed`)
                  sessions.delete(sid)
                }
              })

              const server = createMcpServer()
              await server.connect(transport)

              // Handle the initialize request
              await transport.handleRequest(req, res, parsed)

              // Extract session ID from response headers to store the session
              // Session ID is set during handleRequest for initialize
              const generatedSessionId = (transport as any).sessionId
              if (generatedSessionId) {
                sessions.set(generatedSessionId, { transport, server })
                console.log(`[mcp-service] Client connected with session ${generatedSessionId} (${sessions.size} active sessions)`)
              }
            } else if (sessionId && sessions.has(sessionId)) {
              // Existing client - route to existing transport
              const session = sessions.get(sessionId)!
              await session.transport.handleRequest(req, res, parsed)
            } else {
              // Session not found
              res.writeHead(404, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                error: {
                  code: -32001,
                  message: sessionId ? 'Session not found' : 'Mcp-Session-Id header required'
                },
                id: null
              }))
            }
          } catch (err: any) {
            console.error('[mcp-service] Error handling request:', err)
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: err.message }))
            }
          }
        })
      } else if (req.method === 'GET') {
        // Handle SSE GET requests (not used in current proxy architecture)
        ;(async () => {
          try {
            updateActivity()
            const sessionId = req.headers['mcp-session-id'] as string | undefined

            if (sessionId && sessions.has(sessionId)) {
              const session = sessions.get(sessionId)!
              await session.transport.handleRequest(req, res)
            } else {
              res.writeHead(404, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                error: {
                  code: -32001,
                  message: 'Session not found'
                },
                id: null
              }))
            }
          } catch (err: any) {
            console.error('[mcp-service] Error handling GET request:', err)
            if (!res.headersSent) {
              res.writeHead(500)
              res.end()
            }
          }
        })()
      } else {
        res.writeHead(405)
        res.end()
      }
    } else {
      res.writeHead(404)
      res.end()
    }
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[mcp-service] Port ${port} is already in use`)
        reject(new Error(`Port ${port} is already in use. Another instance may be running.`))
      } else {
        reject(err)
      }
    })

    httpServer.listen(port, '127.0.0.1', () => {
      console.log(`[mcp-service] HTTP server listening on http://127.0.0.1:${port}`)
      resolve()
    })
  })

  console.log('[mcp-service] MCP server ready for connections')
}
