import test from 'node:test'
import assert from 'node:assert/strict'
import {createToolHandlers} from '../lib/mcp-server.js'

// Mock dependencies
const mockDeps = {
  searchQdrant: async () => [],
  searchSymbols: async () => [],
  embed: async () => [0.1, 0.2],
  listProjectFiles: async () => ['file1.js', 'dir/file2.js'],
  extractSymbols: async (path, content) => [{name: 'MockClass', kind: 'class', start: 1}],
  buildTreeText: (files) => `MockTree(${files.length})`,
  runRipgrep: async (name) => [{path: 'file.js', line: 10, snippet: `use ${name}`}],
  readFile: async () => 'mock content'
}

// Create handlers with injected mocks
const handlers = createToolHandlers(mockDeps)

test('get_project_structure returns tree text', async () => {
    const res = await handlers.get_project_structure()
    // The handler returns stringified JSON usually? No, check impl.
    // return {content: [{type: 'text', text: treeText || '(empty project)'}]}
    assert.equal(res.content[0].text, 'MockTree(2)')
})

test('get_file_outline returns symbols', async () => {
    const res = await handlers.get_file_outline({path: 'test.js'})
    const json = JSON.parse(res.content[0].text)
    
    assert.equal(json.length, 1)
    assert.equal(json[0].name, 'MockClass')
    assert.equal(json[0].kind, 'class')
    assert.equal(json[0].line, 1)
})

test('find_references delegates to ripgrep', async () => {
    const res = await handlers.find_references({name: 'MySymbol'})
    const json = JSON.parse(res.content[0].text)
    
    assert.equal(json.length, 1)
    assert.equal(json[0].snippet, 'use MySymbol')
})