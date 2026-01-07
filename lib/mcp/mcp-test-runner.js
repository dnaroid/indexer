import fs from 'fs/promises'
import path from 'path'
import { ensureInitialized, fail, log } from '../cli/cli-actions.js'
import { getProjectCollectionName } from '../utils/config-global.js'
import { pathExists } from '../cli/cli-config.js'
import { listProjectFiles } from '../core/indexer-core.js'

/**
 * Execute an MCP tool by calling handlers directly
 * @param {string} startCwd - Starting directory
 * @param {string} toolName - Tool name to execute
 * @param {object} args - Tool arguments
 * @returns {Promise<object>} Tool result
 */
async function executeMcpTool(startCwd, toolName, args = {}) {
  const { root } = await ensureInitialized(startCwd)
  const collectionName = getProjectCollectionName(root)

  // Import indexer-service functions
  const { loadGlobalConfig } = await import('../utils/config-global.js')
  const { createToolHandlers } = await import('./mcp-handlers.js')
  const { listProjectFiles, buildTreeText, extractSymbols, runRipgrep, filterReferences } = await import('./mcp-tools.js')

  // Get project config
  const config = await loadGlobalConfig()
  const absRoot = path.resolve(root)
  const projectConf = config.projects[absRoot]

  if (!projectConf) {
    throw new Error('Project not found in global config')
  }

  // Create tool dependencies
  const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333'
  const ollamaUrl = process.env.OLLAMA_URL || 'http://127.0.0.1:11434'
  const embedModel = process.env.EMBED_MODEL || 'unclemusclez/jina-embeddings-v2-base-code'

  const deps = {
    readFile: async (p) => fs.readFile(path.resolve(root, p), 'utf8'),

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
            score_threshold: 0,
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

    listProjectFiles: () => {
      const { listProjectFiles } = require('../core/indexer-core.js')
      return listProjectFiles(root)
    },

    extractSymbols,
    buildTreeText,
    runRipgrep: (symbol) => runRipgrep(symbol, root),
    filterReferences
  }

  // Create tool handlers
  const handlers = createToolHandlers(deps)

  // Execute tool
  if (!handlers[toolName]) {
    throw new Error(`Unknown tool: ${toolName}`)
  }

  const result = await handlers[toolName](args)
  return result
}

/**
 * Test search_codebase tool
 * @param {string} startCwd - Starting directory
 * @returns {Promise<void>}
 */
export async function handleTestSearchCodebase(startCwd) {
  const { root, paths } = await ensureInitialized(startCwd)
  const mcpProxyPath = path.join(paths.dotDir, 'mcp-server.js')

  if (!(await pathExists(mcpProxyPath))) {
    fail('MCP proxy script not found. Please run "indexer init" first.')
  }

  log('Testing search_codebase...')
  log('Parameters: { query: "test", top_k: 5 }')

  try {
    const result = await executeMcpTool(startCwd, 'search_codebase', {
      query: 'test',
      top_k: 5
    })

    console.log('\n[RESULT] Success')
    if (result.content && result.content[0]) {
      const data = JSON.parse(result.content[0].text)
      console.log(`[DATA] Found ${data.length} results:\n`)
      console.log(JSON.stringify(data, null, 2))
    } else {
      console.log('[DATA] No results returned')
    }
  } catch (e) {
    console.error(`\n[ERROR] ${e.message}`)
  }
}

/**
 * Test search_symbols tool
 * @param {string} startCwd - Starting directory
 * @returns {Promise<void>}
 */
export async function handleTestSearchSymbols(startCwd) {
  const { root, paths } = await ensureInitialized(startCwd)
  const mcpProxyPath = path.join(paths.dotDir, 'mcp-server.js')

  if (!(await pathExists(mcpProxyPath))) {
    fail('MCP proxy script not found. Please run "indexer init" first.')
  }

  log('Testing search_symbols...')
  log('Parameters: { name: "test", kind: "any", top_k: 10 }')

  try {
    const result = await executeMcpTool(startCwd, 'search_symbols', {
      name: 'test',
      kind: 'any',
      top_k: 10
    })

    console.log('\n[RESULT] Success')
    if (result.content && result.content[0]) {
      const data = JSON.parse(result.content[0].text)
      console.log(`[DATA] Found ${data.length} symbols:\n`)
      console.log(JSON.stringify(data, null, 2))
    } else {
      console.log('[DATA] No results returned')
    }
  } catch (e) {
    console.error(`\n[ERROR] ${e.message}`)
  }
}

/**
 * Test get_file_outline tool
 * @param {string} startCwd - Starting directory
 * @returns {Promise<void>}
 */
export async function handleTestGetFileOutline(startCwd) {
  const { root, paths } = await ensureInitialized(startCwd)
  const mcpProxyPath = path.join(paths.dotDir, 'mcp-server.js')

  if (!(await pathExists(mcpProxyPath))) {
    fail('MCP proxy script not found. Please run "indexer init" first.')
  }

  // Find first JS/TS file in project
  const files = await listProjectFiles(root)
  const testFile = files.find(f => f.endsWith('.js') || f.endsWith('.ts')) || 'indexer.js'

  log('Testing get_file_outline...')
  log(`Parameters: { path: "${testFile}" }`)

  try {
    const result = await executeMcpTool(startCwd, 'get_file_outline', {
      path: testFile
    })

    console.log('\n[RESULT] Success')
    if (result.content && result.content[0]) {
      const data = JSON.parse(result.content[0].text)
      console.log(`[DATA] Found ${data.length} symbols:\n`)
      console.log(JSON.stringify(data, null, 2))
    } else {
      console.log('[DATA] No results returned')
    }
  } catch (e) {
    console.error(`\n[ERROR] ${e.message}`)
  }
}

/**
 * Test get_project_structure tool
 * @param {string} startCwd - Starting directory
 * @returns {Promise<void>}
 */
export async function handleTestGetProjectStructure(startCwd) {
  const { root, paths } = await ensureInitialized(startCwd)
  const mcpProxyPath = path.join(paths.dotDir, 'mcp-server.js')

  if (!(await pathExists(mcpProxyPath))) {
    fail('MCP proxy script not found. Please run "indexer init" first.')
  }

  log('Testing get_project_structure...')
  log('Parameters: {}')

  try {
    const result = await executeMcpTool(startCwd, 'get_project_structure', {})

    console.log('\n[RESULT] Success')
    if (result.content && result.content[0]) {
      const data = result.content[0].text
      console.log('[DATA] Project structure:\n')
      console.log(data)
    } else {
      console.log('[DATA] No results returned')
    }
  } catch (e) {
    console.error(`\n[ERROR] ${e.message}`)
  }
}

/**
 * Test find_usages tool
 * @param {string} startCwd - Starting directory
 * @returns {Promise<void>}
 */
export async function handleTestFindUsages(startCwd) {
  const { root, paths } = await ensureInitialized(startCwd)
  const mcpProxyPath = path.join(paths.dotDir, 'mcp-server.js')

  if (!(await pathExists(mcpProxyPath))) {
    fail('MCP proxy script not found. Please run "indexer init" first.')
  }

  log('Testing find_usages...')
  log('Parameters: { symbol: "test", context: undefined }')

  try {
    const result = await executeMcpTool(startCwd, 'find_usages', {
      symbol: 'test'
    })

    console.log('\n[RESULT] Success')
    if (result.content && result.content[0]) {
      const data = JSON.parse(result.content[0].text)
      console.log(`[DATA] Found ${data.length} usages:\n`)
      console.log(JSON.stringify(data, null, 2))
    } else {
      console.log('[DATA] No results returned')
    }
  } catch (e) {
    console.error(`\n[ERROR] ${e.message}`)
  }
}

/**
 * Run all MCP tests
 * @param {string} startCwd - Starting directory
 * @returns {Promise<void>}
 */
export async function handleTestAll(startCwd) {
  const GREEN = '\x1b[32m'
  const RED = '\x1b[31m'
  const RESET = '\x1b[0m'

  console.log('\n' + '='.repeat(60))
  console.log('Running all MCP tests...')
  console.log('='.repeat(60) + '\n')

  const tests = [
    { name: 'search_codebase', fn: handleTestSearchCodebase },
    { name: 'search_symbols', fn: handleTestSearchSymbols },
    { name: 'get_file_outline', fn: handleTestGetFileOutline },
    { name: 'get_project_structure', fn: handleTestGetProjectStructure },
    { name: 'find_usages', fn: handleTestFindUsages }
  ]

  const results = []

  for (const test of tests) {
    console.log(`\n[${test.name}]`)
    console.log('-'.repeat(60))
    try {
      await test.fn(startCwd)
      results.push({ name: test.name, status: 'PASS' })
      console.log(`\n[${GREEN}✓${RESET}] ${test.name} passed`)
    } catch (e) {
      results.push({ name: test.name, status: 'FAIL', error: e.message })
      console.log(`\n[${RED}✗${RESET}] ${test.name} failed: ${e.message}`)
    }
    console.log('')
  }

  console.log('='.repeat(60))
  console.log('Test Summary')
  console.log('='.repeat(60))
  results.forEach(r => {
    const color = r.status === 'PASS' ? GREEN : RED
    console.log(`${color}${r.status}${RESET} - ${r.name}`)
  })

  const passed = results.filter(r => r.status === 'PASS').length
  const total = results.length
  console.log(`\nTotal: ${passed}/${total} tests passed`)
  console.log('='.repeat(60) + '\n')
}

/**
 * Main handler for test command
 * @param {string} startCwd - Starting directory
 * @param {string} toolName - Tool name to test
 * @returns {Promise<void>}
 */
export async function handleTestCommand(startCwd, toolName) {
  const { root, paths } = await ensureInitialized(startCwd)

  if (!(await pathExists(paths.dotDir))) {
    fail('Project not initialized. Please run "indexer init" first.')
  }

  const toolMap = {
    'search_codebase': 'search_codebase',
    'search': 'search_codebase',
    'search_symbols': 'search_symbols',
    'symbols': 'search_symbols',
    'get_file_outline': 'get_file_outline',
    'outline': 'get_file_outline',
    'get_project_structure': 'get_project_structure',
    'structure': 'get_project_structure',
    'find_usages': 'find_usages',
    'usages': 'find_usages',
    'all': 'all'
  }

  const normalizedTool = toolName?.toLowerCase()

  if (!normalizedTool || !toolMap[normalizedTool]) {
    console.log('\nAvailable MCP tools to test:')
    console.log('  search_codebase (or search)  - Semantic search over codebase')
    console.log('  search_symbols (or symbols)  - Search symbols by name')
    console.log('  get_file_outline (or outline) - Get file structure')
    console.log('  get_project_structure (or structure) - Get project tree')
    console.log('  find_usages (or usages)      - Find symbol usages')
    console.log('  all                           - Run all tests')
    console.log('')
    fail(`Unknown tool: ${toolName || 'none specified'}`)
  }

  const tool = toolMap[normalizedTool]

  switch (tool) {
    case 'search_codebase':
      await handleTestSearchCodebase(startCwd)
      break
    case 'search_symbols':
      await handleTestSearchSymbols(startCwd)
      break
    case 'get_file_outline':
      await handleTestGetFileOutline(startCwd)
      break
    case 'get_project_structure':
      await handleTestGetProjectStructure(startCwd)
      break
    case 'find_usages':
      await handleTestFindUsages(startCwd)
      break
    case 'all':
      await handleTestAll(startCwd)
      break
  }
}
