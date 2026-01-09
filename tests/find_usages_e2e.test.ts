import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import fs from 'fs/promises'
import { initTreeSitter } from '../lib/utils/tree-sitter.js'
import { extractSymbols, filterReferences } from '../lib/tools/common/utils.js'
import { findUsages } from '../lib/tools/find-usages/handler.js'
import type { ToolHandlersDeps } from '../lib/tools/common/types.js'

// Mock dependencies for MCP handlers
const mockDeps: ToolHandlersDeps = {
  runRipgrep: async (pattern: string) => {
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
  filterReferences: async (results: any[], cwd: string | null, readFile: any) => {
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
  const result = await findUsages(mockDeps, { symbol: 'takeDamage', context: undefined })
  const content = JSON.parse(result.content[0].text)

  assert.equal(content.length, 2)
  assert.ok(content.find((r: any) => r.path === 'Enemy.js'))
  assert.ok(content.find((r: any) => r.path === 'Game.js'))
})

test('Tool: find_usages filters by context (class name)', async () => {
  const refinedMockDeps: ToolHandlersDeps = {
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

  const result = await findUsages(refinedMockDeps, { symbol: 'takeDamage', context: 'Enemy' })
  const content = JSON.parse(result.content[0].text)

  assert.equal(content.length, 2)
  assert.ok(content.find((r: any) => r.path === 'Enemy.js'))
  assert.ok(content.find((r: any) => r.path === 'Game.js'))
})

test('Tool: find_usages auto-extracts context from qualified name', async () => {
  const refinedMockDeps: ToolHandlersDeps = {
    ...mockDeps,
    runRipgrep: async (pattern: string) => {
      // Should look for 'takeDamage', not 'Enemy.takeDamage'
      if (pattern === 'takeDamage') return mockDeps.runRipgrep('takeDamage')
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

  // Passing "Enemy.takeDamage" should trigger auto-context "Enemy"
  const result = await findUsages(refinedMockDeps, { symbol: 'Enemy.takeDamage', context: undefined })
  const content = JSON.parse(result.content[0].text)

  assert.equal(content.length, 2)
  assert.ok(content.find((r: any) => r.path === 'Game.js'))
})
