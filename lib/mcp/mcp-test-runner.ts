import fs from 'fs/promises'
import path from 'path'
import { ensureInitialized } from '../cli/cli-actions.js'
import { fail, log } from '../cli/cli-ui.js'
import { getProjectCollectionName } from '../utils/config-global.js'
import { pathExists } from '../cli/cli-config.js'
import { listProjectFiles } from '../core/indexer-core.js'
import { getDaemonPort, ensureDaemonRunning } from '../cli/daemon-manager.js'

/**
 * Execute an MCP tool via the running daemon (simulating an agent)
 * @param {string} startCwd - Starting directory
 * @param {string} toolName - Tool name to execute
 * @param {object} args - Tool arguments
 * @returns {Promise<any>} Tool result
 */
async function executeMcpTool(startCwd: string, toolName: string, args: any = {}): Promise<any> {
  const { root } = await ensureInitialized(startCwd)
  const collectionName = getProjectCollectionName(root)

  await ensureDaemonRunning()

  const port = await getDaemonPort()
  const url = `http://127.0.0.1:${port}/mcp`

  try {
    // Step 1: Initialize MCP session
    const initPayload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'indexer-test-client',
          version: '1.0.0'
        }
      }
    }

    const initResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify(initPayload)
    })

    if (!initResponse.ok) {
      throw new Error(`HTTP ${initResponse.status}: ${initResponse.statusText}`)
    }

    // Extract session ID from response headers
    const sessionId = initResponse.headers.get('mcp-session-id')
    if (!sessionId) {
      throw new Error('No session ID received from MCP server')
    }

    // Step 2: Call the tool with session ID
    const requestArgs = {
      ...args,
      collectionId: collectionName
    }

    const payload = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: requestArgs
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Mcp-Session-Id': sessionId
      },
      body: JSON.stringify(payload)
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const text = await response.text()

    // Parse JSON-RPC response
    let json: any
    try {
      json = JSON.parse(text)
    } catch (e) {
      // Try parsing SSE format if raw JSON fails
      const lines = text.trim().split('\n')
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            json = JSON.parse(line.substring(6))
            break
          } catch (_) {}
        }
      }
    }

    if (!json) {
      throw new Error(`Invalid response format from daemon: ${text.substring(0, 100)}...`)
    }

    if (json.error) {
      throw new Error(`MCP Error ${json.error.code}: ${json.error.message}`)
    }

    if (!json.result) {
      throw new Error('No result in MCP response')
    }

    return json.result

  } catch (err: any) {
    throw new Error(`Failed to call daemon: ${err.message}`)
  }
}

/**
 * Test search_codebase tool
 * @param {string} startCwd - Starting directory
 * @returns {Promise<void>}
 */
export async function handleTestSearchCodebase(startCwd: string): Promise<void> {
  const { root, paths } = await ensureInitialized(startCwd)
  const mcpProxyPath = path.join(paths.dotDir, 'mcp-server.js')

  if (!(await pathExists(mcpProxyPath))) {
    fail('MCP proxy script not found. Please run "indexer init" first.')
  }

  log('Testing search_codebase...')
  log('Parameters: { query: "test", top_k:5 }')

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
  } catch (e: any) {
    console.error(`\n[ERROR] ${e.message}`)
  }
}

/**
 * Test search_symbols tool
 * @param {string} startCwd - Starting directory
 * @returns {Promise<void>}
 */
export async function handleTestSearchSymbols(startCwd: string): Promise<void> {
  const { root, paths } = await ensureInitialized(startCwd)
  const mcpProxyPath = path.join(paths.dotDir, 'mcp-server.js')

  if (!(await pathExists(mcpProxyPath))) {
    fail('MCP proxy script not found. Please run "indexer init" first.')
  }

  log('Testing search_symbols...')
  log('Parameters: { name: "test", kind: "any", top_k:10 }')

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
  } catch (e: any) {
    console.error(`\n[ERROR] ${e.message}`)
  }
}

/**
 * Test get_file_outline tool
 * @param {string} startCwd - Starting directory
 * @returns {Promise<void>}
 */
export async function handleTestGetFileOutline(startCwd: string): Promise<void> {
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
  } catch (e: any) {
    console.error(`\n[ERROR] ${e.message}`)
  }
}

/**
 * Test get_project_structure tool
 * @param {string} startCwd - Starting directory
 * @returns {Promise<void>}
 */
export async function handleTestGetProjectStructure(startCwd: string): Promise<void> {
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
  } catch (e: any) {
    console.error(`\n[ERROR] ${e.message}`)
  }
}

/**
 * Test find_usages tool
 * @param {string} startCwd - Starting directory
 * @returns {Promise<void>}
 */
export async function handleTestFindUsages(startCwd: string): Promise<void> {
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
  } catch (e: any) {
    console.error(`\n[ERROR] ${e.message}`)
  }
}

/**
 * Test get_dependency_graph tool
 * @param {string} startCwd - Starting directory
 * @returns {Promise<void>}
 */
export async function handleTestDependencyGraph(startCwd: string): Promise<void> {
  const { root, paths } = await ensureInitialized(startCwd)
  const mcpProxyPath = path.join(paths.dotDir, 'mcp-server.js')

  if (!(await pathExists(mcpProxyPath))) {
    fail('MCP proxy script not found. Please run "indexer init" first.')
  }

  log('Testing get_dependency_graph...')
  log('Parameters: {}')

  try {
    const result = await executeMcpTool(startCwd, 'get_dependency_graph', {})

    console.log('\n[RESULT] Success')
    if (result.content && result.content[0]) {
      const data = JSON.parse(result.content[0].text)
      console.log(`[DATA] Found ${data.stats.totalNodes} nodes and ${data.stats.totalEdges} edges:\n`)
      console.log(JSON.stringify(data, null, 2))
    } else {
      console.log('[DATA] No results returned')
    }
  } catch (e: any) {
    console.error(`\n[ERROR] ${e.message}`)
  }
}

/**
 * Run all MCP tests
 * @param {string} startCwd - Starting directory
 * @returns {Promise<void>}
 */
export async function handleTestAll(startCwd: string): Promise<void> {
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
    { name: 'find_usages', fn: handleTestFindUsages },
    { name: 'get_dependency_graph', fn: handleTestDependencyGraph }
  ]

  const results: Array<{ name: string, status: string, error?: string }> = []

  for (const test of tests) {
    console.log(`\n[${test.name}]`)
    console.log('-'.repeat(60))
    try {
      await test.fn(startCwd)
      results.push({ name: test.name, status: 'PASS' })
      console.log(`\n[${GREEN}✓${RESET}] ${test.name} passed`)
    } catch (e: any) {
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
export async function handleTestCommand(startCwd: string, toolName?: string): Promise<void> {
  const { root, paths } = await ensureInitialized(startCwd)

  if (!(await pathExists(paths.dotDir))) {
    fail('Project not initialized. Please run "indexer init" first.')
  }

  const toolMap: Record<string, string> = {
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
    'get_dependency_graph': 'get_dependency_graph',
    'dependency_graph': 'get_dependency_graph',
    'dependency-graph': 'get_dependency_graph',
    'graph': 'get_dependency_graph',
    'all': 'all'
  }

  const normalizedTool = toolName?.toLowerCase()

  if (!normalizedTool || !toolMap[normalizedTool]) {
    console.log('\nAvailable MCP tools to test:')
    console.log('  search_codebase (or search)  - Semantic search over codebase')
    console.log('  search_symbols (or symbols)  - Search symbols by name')
    console.log('  get_file_outline (or outline)  - Get file structure')
    console.log('  get_project_structure (or structure)  - Get project tree')
    console.log('  find_usages (or usages)      - Find symbol usages')
    console.log('  get_dependency_graph (or dependency_graph, dependency-graph, graph)  - Get dependency graph')
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
    case 'get_dependency_graph':
      await handleTestDependencyGraph(startCwd)
      break
    case 'all':
      await handleTestAll(startCwd)
      break
  }
}
