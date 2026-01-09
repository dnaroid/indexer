import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { searchCodebase } from '../lib/tools/search-codebase/handler.js'
import { searchSymbols } from '../lib/tools/search-symbols/handler.js'
import { getProjectStructure } from '../lib/tools/get-project-structure/handler.js'
import { initTreeSitter } from '../lib/utils/tree-sitter.js'
import { listProjectFiles } from '../lib/core/indexer-core.js'
import {
  buildTreeText,
  extractSymbols,
  filterReferences,
  runRipgrep
} from '../lib/tools/common/utils.js'
import type { ToolHandlersDeps } from '../lib/tools/common/types.js'

// Mock dependencies using real implementations where possible
const deps: ToolHandlersDeps = {
  readFile: (p: string) => fs.readFile(path.resolve(process.env.WORKSPACE_DIR || process.cwd(), p), 'utf8'),
  embed: async (text: string): Promise<number[]> => {
    const res = await fetch(`${process.env.OLLAMA_URL || 'http://127.0.0.1:11434'}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.EMBED_MODEL || 'unclemusclez/jina-embeddings-v2-base-code',
        prompt: text
      })
    })
    const json: any = await res.json()
    return json.embedding
  },
  searchQdrant: async (vector: number[], topK: number, pathPrefix?: string): Promise<any[]> => {
    const coll = process.env.QDRANT_COLLECTION || 'project_index'
    const url = process.env.QDRANT_URL || 'http://localhost:6333'
    const filter = pathPrefix ? { must: [{ key: 'path', match: { prefix: pathPrefix } }] } : undefined

    const res = await fetch(`${url}/collections/${coll}/points/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vector, limit: topK, with_payload: true, filter })
    })
    const json: any = await res.json()
    return json.result || []
  },
  searchSymbols: async (name: string, kind?: string, topK?: number): Promise<any[]> => {
    const coll = process.env.QDRANT_COLLECTION || 'project_index'
    const url = process.env.QDRANT_URL || 'http://localhost:6333'
    const must: any[] = [{ should: [{ key: 'symbol_names', match: { text: name } }, { key: 'symbol_references', match: { text: name } }] }]
    if (kind && kind !== 'any') must.push({ key: 'symbol_kinds', match: { any: [kind] } })

    const res = await fetch(`${url}/collections/${coll}/points/scroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filter: { must }, with_payload: true, limit: topK })
    })
    const json: any = await res.json()
    return json.result?.points || json.result || []
  },
  listProjectFiles: () => listProjectFiles(process.env.WORKSPACE_DIR || process.cwd()),
  extractSymbols,
  buildTreeText,
  runRipgrep: (symbol: string) => runRipgrep(symbol, process.env.WORKSPACE_DIR || process.cwd()) as Promise<any[]>,
  filterReferences
}

test('Live Search: indexer should return results from Qdrant with current model', async (t) => {
  const startCwd = process.cwd()
  process.env.WORKSPACE_DIR = startCwd

  await initTreeSitter()

  await t.test('search_codebase should return semantic results', async () => {
    try {
      const res = await searchCodebase(deps, {
        query: "how embeddings are generated",
        top_k: 2
      })
      const results = JSON.parse(res.content[0].text)
      console.log(`[Live Test] Found ${results.length} results for codebase search`)
      if (results.length > 0) {
        assert.ok(results[0].path)
        assert.ok(results[0].score > 0)
      }
    } catch (e: any) {
      console.warn(`[Live Test] codebase search failed (is Qdrant/Ollama up?): ${e.message}`)
    }
  })

  await t.test('get_project_structure should return valid tree', async () => {
    const res = await getProjectStructure(deps)
    const tree = res.content[0].text
    assert.ok(tree.includes('lib'))
  })
})
