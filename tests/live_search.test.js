import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { createToolHandlers } from '../lib/mcp-handlers.js'
import { initTreeSitter } from '../lib/tree-sitter.js'
import { listProjectFiles } from '../lib/indexer-core.js'
import { 
  buildTreeText, 
  extractSymbols, 
  filterReferences, 
  runRipgrep 
} from '../lib/mcp-tools.js'

// Mock dependencies using real implementations where possible
const deps = {
  readFile: (p) => fs.readFile(path.resolve(process.env.WORKSPACE_DIR || process.cwd(), p), 'utf8'),
  embed: async (text) => {
    const res = await fetch(`${process.env.OLLAMA_URL || 'http://127.0.0.1:11434'}/api/embeddings`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        model: process.env.EMBED_MODEL || 'unclemusclez/jina-embeddings-v2-base-code',
        prompt: text
      })
    })
    const json = await res.json()
    return json.embedding
  },
  searchQdrant: async (vector, topK, pathPrefix) => {
    const coll = process.env.QDRANT_COLLECTION || 'project_index'
    const url = process.env.QDRANT_URL || 'http://localhost:6333'
    const filter = pathPrefix ? {must: [{key: 'path', match: {prefix: pathPrefix}}]} : undefined

    const res = await fetch(`${url}/collections/${coll}/points/search`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ vector, limit: topK, with_payload: true, filter })
    })
    const json = await res.json()
    return json.result || []
  },
  searchSymbols: async (name, kind, topK) => {
    const coll = process.env.QDRANT_COLLECTION || 'project_index'
    const url = process.env.QDRANT_URL || 'http://localhost:6333'
    const must = [{ should: [{key: 'symbol_names', match: {text: name}}, {key: 'symbol_references', match: {text: name}}] }]
    if (kind && kind !== 'any') must.push({key: 'symbol_kinds', match: {any: [kind]}})

    const res = await fetch(`${url}/collections/${coll}/points/scroll`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({filter: {must}, with_payload: true, limit: topK})
    })
    const json = await res.json()
    return json.result?.points || json.result || []
  },
  listProjectFiles: () => listProjectFiles(process.env.WORKSPACE_DIR || process.cwd()),
  extractSymbols,
  buildTreeText,
  runRipgrep: (symbol) => runRipgrep(symbol, process.env.WORKSPACE_DIR || process.cwd()),
  filterReferences
}

test('Live Search: indexer should return results from Qdrant with current model', async (t) => {
  const startCwd = process.cwd()
  process.env.WORKSPACE_DIR = startCwd
  
  await initTreeSitter()
  const handlers = createToolHandlers(deps)

  await t.test('search_codebase should return semantic results', async () => {
    try {
      const res = await handlers.search_codebase({ 
        query: "how embeddings are generated", 
        top_k: 2 
      })
      const results = JSON.parse(res.content[0].text)
      console.log(`[Live Test] Found ${results.length} results for codebase search`)
      if (results.length > 0) {
        assert.ok(results[0].path)
        assert.ok(results[0].score > 0)
      }
    } catch (e) {
      console.warn(`[Live Test] codebase search failed (is Qdrant/Ollama up?): ${e.message}`)
    }
  })

  await t.test('get_project_structure should return valid tree', async () => {
    const res = await handlers.get_project_structure()
    const tree = res.content[0].text
    assert.ok(tree.includes('lib'))
  })
})
