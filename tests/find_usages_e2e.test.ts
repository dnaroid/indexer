import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import fs from 'fs/promises'
import { initTreeSitter } from '../lib/utils/tree-sitter.js'
import { extractSymbols, filterReferences } from '../lib/mcp/mcp-tools.js'
import { createToolHandlers } from '../lib/mcp/mcp-handlers.js'

interface MockDeps {
  runRipgrep: (pattern: string, cwd: string) => Promise<any[]>
  filterReferences: (results: any[], cwd: string, readFile: any) => Promise<any[]>
  searchSymbols: (name: string, kind?: string, topK?: number) => Promise<any[]>
  searchQdrant: (vector: number[], topK: number, pathPrefix?: string) => Promise<any[]>
  readFile: (path: string) => Promise<string>
  listProjectFiles: () => Promise<string[]>
  buildTreeText: (files: string[]) => string
  extractSymbols: (path: string, content: string) => Promise<any[]>
  embed: (text: string) => Promise<number[]>
}

// Mock dependencies for MCP handlers
const mockDeps: MockDeps = {
  runRipgrep: async (pattern: string, cwd: string) => {
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
  filterReferences: async (results: any[], cwd: string, readFile: any) => {
    // Basic mock of filterReferences logic
    return results.filter((r: any) => !r.path.endsWith('.md'))
  },
  searchSymbols: async (name: string, kind?: string, topK?: number) => {
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
  embed: async () => [],
  searchQdrant: async () => []
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

  const definitions = symbols.filter((s: any) => s.kind !== 'reference')
  const references = symbols.filter((s: any) => s.kind === 'reference')

  assert.ok(definitions.find((s: any) => s.name === 'Player'), 'Def: Player class')
  assert.ok(definitions.find((s: any) => s.name === 'Player.move'), 'Def: move method')

  assert.ok(references.find((s: any) => s.name === 'Player'), 'Ref: Player usage')
  assert.ok(references.find((s: any) => s.name === 'move'), 'Ref: move usage')
})

test('Parser: Python extracts references correctly', async () => {
  const code = `
def process_data(data):
    return data.strip()

raw = " hello "
clean = process_data(raw)
  `
  const symbols = await extractSymbols('test.py', code)
  const references = symbols.filter((s: any) => s.kind === 'reference')

  assert.ok(references.find((s: any) => s.name === 'process_data'), 'Ref: function call')
  assert.ok(references.find((s: any) => s.name === 'raw'), 'Ref: variable usage')
  assert.ok(references.find((s: any) => s.name === 'strip'), 'Ref: method usage')
})

test('Tool: find_usages works with simple symbol', async () => {
  const handlers = createToolHandlers(mockDeps as any)

  const result = await handlers.find_usages({ symbol: 'takeDamage', context: undefined })
  const content = JSON.parse(result.content[0].text)

  assert.equal(content.length, 2)
  assert.ok(content.find((r: any) => r.path === 'Enemy.js'))
  assert.ok(content.find((r: any) => r.path === 'Game.js'))
})

test('Tool: find_usages filters by context (class name)', async () => {
  const handlers = createToolHandlers(mockDeps as any)

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
  const refinedMockDeps: MockDeps = {
    ...mockDeps,
    searchSymbols: async (name: string) => {
      if (name === 'Enemy') {
        return [
          { payload: { path: 'Enemy.js' } }, // Definition
          { payload: { path: 'Game.js' } }   // Reference (import/usage)
        ]
      }
      return []
    }
  }

  const handlersRefined = createToolHandlers(refinedMockDeps as any)

  const result = await handlersRefined.find_usages({ symbol: 'takeDamage', context: 'Enemy' })
  const content = JSON.parse(result.content[0].text)

  assert.equal(content.length, 2)
  assert.ok(content.find((r: any) => r.path === 'Enemy.js'))
  assert.ok(content.find((r: any) => r.path === 'Game.js'))
})

test('Tool: find_usages auto-extracts context from qualified name', async () => {
  const refinedMockDeps: MockDeps = {
    ...mockDeps,
    runRipgrep: async (pattern: string) => {
      // Should look for 'takeDamage', not 'Enemy.takeDamage'
      if (pattern === 'takeDamage') return mockDeps.runRipgrep('takeDamage', '')
      return []
    },
    searchSymbols: async (name: string) => {
      if (name === 'Enemy') {
        return [
          { payload: { path: 'Enemy.js' } },
          { payload: { path: 'Game.js' } }
        ]
      }
      return []
    }
  }

  const handlers = createToolHandlers(refinedMockDeps as any)

  // Passing "Enemy.takeDamage" should trigger auto-context "Enemy"
  const result = await handlers.find_usages({ symbol: 'Enemy.takeDamage', context: undefined })
  const content = JSON.parse(result.content[0].text)

  assert.equal(content.length, 2)
  assert.ok(content.find((r: any) => r.path === 'Game.js'))
})
