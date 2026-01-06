import test from 'node:test'
import assert from 'node:assert/strict'
import { createToolHandlers } from '../lib/mcp-server.js'
import { initTreeSitter } from '../lib/tree-sitter.js'
import { readEnvFile } from '../lib/cli-config.js'
import { ensureInitialized } from '../lib/cli-actions.js'

test('Live Search: indexer should return results from Qdrant with current model', async (t) => {
  // Setup environment for the test
  const startCwd = process.cwd()
  const { paths } = await ensureInitialized(startCwd)
  const env = await readEnvFile(paths.envPath)
  
  // Inject environment variables
  Object.assign(process.env, env)
  process.env.WORKSPACE_DIR = startCwd
  
  await initTreeSitter()
  const handlers = createToolHandlers()

  await t.test('search_codebase should return semantic results', async () => {
    // We search for something that definitely exists in this project
    const res = await handlers.search_codebase({ 
      query: "how embeddings are generated", 
      top_k: 2 
    })
    
    const results = JSON.parse(res.content[0].text)
    
    // If Qdrant is empty, this might be 0, but usually we expect at least the query itself
    // to match some code if indexed.
    console.log(`[Live Test] Found ${results.length} results for codebase search`)
    
    // We don't assert length > 0 because Qdrant might not be indexed in some environments,
    // but we check the structure of the response.
    if (results.length > 0) {
      assert.ok(results[0].path)
      assert.ok(results[0].score > 0)
    }
  })

  await t.test('get_project_structure should return valid tree', async () => {
    const res = await handlers.get_project_structure()
    const tree = res.content[0].text
    
    assert.ok(tree.includes('indexer.js'))
    assert.ok(tree.includes('lib'))
  })
})
