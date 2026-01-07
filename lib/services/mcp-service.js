import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
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

/**
 * Create tool dependencies for a project
 * @param {string} projectPath - Project root path
 * @param {object} projectConf - Project configuration
 * @returns {object} Tool dependencies
 */
function createToolDeps(projectPath, projectConf) {
  const { collectionName, settings } = projectConf
  const qdrantUrl = process.env.QDRANT_URL || settings.QDRANT_URL
  const ollamaUrl = process.env.OLLAMA_URL || settings.OLLAMA_URL
  const embedModel = process.env.EMBED_MODEL || settings.EMBED_MODEL

  return {
    readFile: async (p) => {
      const fs = await import('fs/promises')
      const path = await import('path')
      return (await fs.readFile(path.resolve(projectPath, p), 'utf8'))
    },

    embed: async (text) => {
      const res = await fetch(`${ollamaUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

/**
 * Execute a query for a specific collection
 * @param {object} params - Query parameters
 * @returns {Promise<object>} Query result
 */
export async function executeQuery({ collectionId, tool, args }) {
  // Find project by collectionId
  const config = await loadGlobalConfig()
  let projectPath = null
  let projectConf = null

  for (const [path, data] of Object.entries(config.projects)) {
    if (data.collectionName === collectionId) {
      projectPath = path
      projectConf = await getProjectConfig(path)
      break
    }
  }

  if (!projectConf) {
    throw new Error(`Collection not found: ${collectionId}`)
  }

  const deps = createToolDeps(projectPath, projectConf)
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
    search_codebase: async (args) => {
      updateActivity()
      return executeQuery(args)
    },
    search_symbols: async (args) => {
      updateActivity()
      return executeQuery(args)
    },
    get_file_outline: async (args) => {
      updateActivity()
      return executeQuery(args)
    },
    get_project_structure: async (args) => {
      updateActivity()
      return executeQuery(args)
    },
    find_usages: async (args) => {
      updateActivity()
      return executeQuery(args)
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
        collectionId: z.string().describe('Collection ID for the project'),
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
        collectionId: z.string().describe('Collection ID for the project'),
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
        collectionId: z.string().describe('Collection ID for the project'),
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
        collectionId: z.string().describe('Collection ID for the project')
      }
    },
    handlers.get_project_structure
  )

  server.registerTool(
    'find_usages',
    {
      description: 'Find usages of a symbol, optionally filtered by context (e.g. class name)',
      inputSchema: {
        collectionId: z.string().describe('Collection ID for the project'),
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
export async function startMcpServer() {
  console.log('[mcp-service] Starting MCP server...')
  const server = createMcpServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.log('[mcp-service] MCP server connected via stdio')
}
