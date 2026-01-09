import test from 'node:test'
import assert from 'node:assert/strict'
import { searchCodebase } from '../lib/tools/search-codebase/handler.js'
import { searchSymbols } from '../lib/tools/search-symbols/handler.js'
import { getFileOutline } from '../lib/tools/get-file-outline/handler.js'
import { getProjectStructure } from '../lib/tools/get-project-structure/handler.js'
import { findUsages } from '../lib/tools/find-usages/handler.js'
import type { ToolHandlersDeps } from '../lib/tools/common/types.js'

// Mock dependencies
const mockDeps: ToolHandlersDeps = {
  searchQdrant: async () => [],
  searchSymbols: async () => [],
  embed: async () => [0.1, 0.2],
  listProjectFiles: async () => ['file1.js', 'dir/file2.js'],
  extractSymbols: async () => [{ name: 'MockClass', kind: 'class', start: 1 }],
  buildTreeText: (files: string[]) => `MockTree(${files.length})`,
  runRipgrep: async (name: string) => [{ path: 'file.js', line: 10, column: 5, snippet: `use ${name}` }],
  filterReferences: async (refs: any[]) => refs,
  readFile: async () => 'mock content'
}

test('get_project_structure returns tree text', async () => {
  const res = await getProjectStructure(mockDeps)
  assert.equal(res.content[0].text, 'MockTree(2)')
})

test('get_file_outline returns symbols', async () => {
  const res = await getFileOutline(mockDeps, { path: 'test.js' })
  const json = JSON.parse(res.content[0].text)

  assert.equal(json.length, 1)
  assert.equal(json[0].name, 'MockClass')
  assert.equal(json[0].kind, 'class')
  assert.equal(json[0].line, 1)
})

test('find_usages delegates to ripgrep', async () => {
  const res = await findUsages(mockDeps, { symbol: 'MySymbol', context: undefined })

  const json = JSON.parse(res.content[0].text)

  assert.equal(json.length, 1)

  assert.equal(json[0].snippet, 'use MySymbol')
})
