import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import fs from 'fs/promises'
import { initTreeSitter } from '../lib/tree-sitter.js'
import { extractSymbols, filterReferences } from '../lib/mcp-tools.js'
import { createToolHandlers } from '../lib/mcp-handlers.js'

// Mock dependencies for MCP handlers
const mockDeps = {
  runRipgrep: async (pattern, cwd) => {
    // Simulate finding usages in a mock file system
    if (pattern === 'takeDamage') {
      return [
        { path: 'Enemy.js', line: 2, column: 7, snippet: 'takeDamage(amount) {' },
        { path: 'Game.js', line: 5, column: 5, snippet: 'enemy.takeDamage(10);' },
        { path: 'Docs.md', line: 10, column: 1, snippet: 'Use takeDamage to reduce health' } // Should be filtered out by language check usually
      ]
    }
    return []
  },
  filterReferences: async (results, cwd, readFile) => {
    // Basic mock of filterReferences logic
    return results.filter(r => !r.path.endsWith('.md'))
  },
  searchSymbols: async (name, kind, topK) => {
    // Mock Qdrant response: "Enemy" is defined in Enemy.js
    if (name === 'Enemy') {
      return [
        { payload: { path: 'Enemy.js' } }
      ]
    }
    return []
  },
  readFile: async () => '', // Not used in this mock level
  listProjectFiles: async () => [],
  buildTreeText: () => '',
  extractSymbols: async () => [],
  embed: async () => []
}

test.before(async () => {
  await initTreeSitter()
})

test('Parser: JS extracts references correctly', async () => {
  const code = `
    class Player {
      move() {}
    }
    const p = new Player();
    p.move();
  `
  const symbols = await extractSymbols('test.js', code)
  
  const definitions = symbols.filter(s => s.kind !== 'reference')
  const references = symbols.filter(s => s.kind === 'reference')

  assert.ok(definitions.find(s => s.name === 'Player'), 'Def: Player class')
  assert.ok(definitions.find(s => s.name === 'Player.move'), 'Def: move method')
  
  assert.ok(references.find(s => s.name === 'Player'), 'Ref: Player usage')
  assert.ok(references.find(s => s.name === 'move'), 'Ref: move usage')
})

test('Parser: Python extracts references correctly', async () => {
  const code = `
def process_data(data):
    return data.strip()

raw = " hello "
clean = process_data(raw)
  `
  const symbols = await extractSymbols('test.py', code)
  const references = symbols.filter(s => s.kind === 'reference')

  assert.ok(references.find(s => s.name === 'process_data'), 'Ref: function call')
  assert.ok(references.find(s => s.name === 'raw'), 'Ref: variable usage')
  assert.ok(references.find(s => s.name === 'strip'), 'Ref: method usage')
})

test('Tool: find_usages works with simple symbol', async () => {
  const handlers = createToolHandlers(mockDeps)
  
  const result = await handlers.find_usages({ symbol: 'takeDamage' })
  const content = JSON.parse(result.content[0].text)
  
  assert.equal(content.length, 2)
  assert.ok(content.find(r => r.path === 'Enemy.js'))
  assert.ok(content.find(r => r.path === 'Game.js'))
})

test('Tool: find_usages filters by context (class name)', async () => {
  const handlers = createToolHandlers(mockDeps)
  
  // Case 1: Explicit context 'Enemy'
  // Mock logic: searchSymbols('Enemy') returns 'Enemy.js'
  // So results should be filtered to only include 'Enemy.js'
  // WAIT: My mock logic for filter in find_usages is:
  // "finalResults = filteredResults.filter(r => filesWithContext.has(r.path))"
  
  // If 'Enemy' is defined in 'Enemy.js', then context filtering will show usages IN 'Enemy.js'.
  // This mimics "Show usages OF Enemy.takeDamage", which implies looking for where Enemy is used?
  // Actually, the current implementation filters files where the CONTEXT symbol appears (either defined or referenced).
  // In a real scenario:
  // Game.js contains "enemy.takeDamage(10)". "enemy" is a variable. "Enemy" (class) might be imported.
  // If "Enemy" is in Qdrant for Game.js (as a reference), then Game.js passes the filter.
  
  // Let's refine the mock to reflect this.
  const refinedMockDeps = {
    ...mockDeps,
    searchSymbols: async (name) => {
      if (name === 'Enemy') {
        return [
          { payload: { path: 'Enemy.js' } }, // Definition
          { payload: { path: 'Game.js' } }   // Reference (import/usage)
        ]
      }
      return []
    }
  }
  
  const handlersRefined = createToolHandlers(refinedMockDeps)
  
  const result = await handlersRefined.find_usages({ symbol: 'takeDamage', context: 'Enemy' })
  const content = JSON.parse(result.content[0].text)
  
  assert.equal(content.length, 2)
  assert.ok(content.find(r => r.path === 'Enemy.js'))
  assert.ok(content.find(r => r.path === 'Game.js'))
})

test('Tool: find_usages auto-extracts context from qualified name', async () => {
  const refinedMockDeps = {
    ...mockDeps,
    runRipgrep: async (pattern) => {
      // Should look for 'takeDamage', not 'Enemy.takeDamage'
      if (pattern === 'takeDamage') return mockDeps.runRipgrep('takeDamage')
      return []
    },
    searchSymbols: async (name) => {
      if (name === 'Enemy') {
        return [
          { payload: { path: 'Enemy.js' } },
          { payload: { path: 'Game.js' } }
        ]
      }
      return []
    }
  }
  
  const handlers = createToolHandlers(refinedMockDeps)
  
  // Passing "Enemy.takeDamage" should trigger auto-context "Enemy"
  const result = await handlers.find_usages({ symbol: 'Enemy.takeDamage' })
  const content = JSON.parse(result.content[0].text)
  
  assert.equal(content.length, 2)
  assert.ok(content.find(r => r.path === 'Game.js'))
})
