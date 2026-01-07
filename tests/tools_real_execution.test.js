import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import {createToolHandlers} from '../lib/mcp-handlers.js'
import {
  extractSymbols,
  buildTreeText,
  runRipgrep,
  detectLanguage,
  filterReferences
} from '../lib/mcp-tools.js'
import {initTreeSitter} from '../lib/tree-sitter.js'

// Setup a real playground directory
const PLAYGROUND_DIR = path.resolve(process.cwd(), 'tests_playground')

async function setupPlayground() {
  await fs.rm(PLAYGROUND_DIR, {recursive: true, force: true})
  await fs.mkdir(PLAYGROUND_DIR, {recursive: true})

  // Create sample files
  await fs.writeFile(path.join(PLAYGROUND_DIR, 'main.js'), `
    class UserManager {
      constructor() { this.users = [] }
      addUser(u) { this.users.push(u) }
    }
    
    function init() {
      const um = new UserManager()
      um.addUser('alice')
    }
  `)

  await fs.mkdir(path.join(PLAYGROUND_DIR, 'utils'))
  await fs.writeFile(path.join(PLAYGROUND_DIR, 'utils/helpers.py'), `
def format_user(u):
    return f"User: {u}"

class Formatter:
    def process(self):
        pass
  `)

  // C# file
  await fs.writeFile(path.join(PLAYGROUND_DIR, 'Player.cs'), `
using UnityEngine;
public class Player : MonoBehaviour {
    [SerializeField] private int health;
    void Start() {}
    public void Attack() {}
}
  `)
}

// Custom listProjectFiles that looks into our playground
async function listPlaygroundFiles() {
  // Simple recursive walk for test purposes
  async function walk(dir, fileList = []) {
    const files = await fs.readdir(dir)
    for (const file of files) {
      const stat = await fs.stat(path.join(dir, file))
      if (stat.isDirectory()) {
        await walk(path.join(dir, file), fileList)
      } else {
        fileList.push(path.relative(PLAYGROUND_DIR, path.join(dir, file)))
      }
    }
    return fileList
  }
  return walk(PLAYGROUND_DIR)
}

// Deps with REAL local tools, but mocked network/DB
import fg from 'fast-glob'

// ... (existing code)

const realDeps = {
  extractSymbols,
  buildTreeText,
  runRipgrep: (pattern) => runRipgrep(pattern, PLAYGROUND_DIR),
  filterReferences: (results) => filterReferences(results, PLAYGROUND_DIR, (p) => fs.readFile(path.resolve(PLAYGROUND_DIR, p), 'utf8')),
  listProjectFiles: async () => {
    return fg('**/*', { cwd: PLAYGROUND_DIR })
  },
  readFile: (p) => fs.readFile(path.resolve(PLAYGROUND_DIR, p), 'utf8'),
  embed: async () => new Array(768).fill(0), // mock
  searchQdrant: async () => [], // mock
  searchSymbols: async () => [] // mock
}

test.before(async () => {
  await setupPlayground()
  await initTreeSitter()
  // Mock WORKSPACE_DIR for get_file_outline to resolve paths correctly
  process.env.WORKSPACE_DIR = PLAYGROUND_DIR
})

test.after(async () => {
  await fs.rm(PLAYGROUND_DIR, {recursive: true, force: true})
  delete process.env.WORKSPACE_DIR
})

const handlers = createToolHandlers(realDeps)

test('Real Execution: get_project_structure', async () => {
  const res = await handlers.get_project_structure()
  const tree = res.content[0].text

  console.log('Project Structure:\n', tree)

  assert.ok(tree.includes('├── main.js'))
  assert.ok(tree.includes('└── utils'))
  assert.ok(tree.includes('    └── helpers.py'))
})

test('Real Execution: get_file_outline (JS)', async () => {
  const res = await handlers.get_file_outline({path: 'main.js'})
  const symbols = JSON.parse(res.content[0].text)

  // UserManager, UserManager.constructor, UserManager.addUser, init
  assert.ok(symbols.find(s => s.name === 'UserManager'))
  assert.ok(symbols.find(s => s.name === 'UserManager.addUser'))
  assert.ok(symbols.find(s => s.name === 'init'))
})

test('Real Execution: get_file_outline (Python)', async () => {
  const res = await handlers.get_file_outline({path: 'utils/helpers.py'})
  const symbols = JSON.parse(res.content[0].text)

  assert.ok(symbols.find(s => s.name === 'format_user'))
  assert.ok(symbols.find(s => s.name === 'Formatter'))
})

test('Real Execution: get_file_outline (C#)', async () => {
  const res = await handlers.get_file_outline({path: 'Player.cs'})
  const symbols = JSON.parse(res.content[0].text)

  assert.ok(symbols.find(s => s.name === 'Player'))
  assert.ok(symbols.find(s => s.name === 'Player.Start'))
  assert.ok(symbols.find(s => s.name === 'Player.Attack'))
  assert.ok(symbols.find(s => s.name === 'Player.health')) // serialized field
})

test('Real Execution: find_usages (ripgrep)', async () => {
  const res = await handlers.find_usages({symbol: 'UserManager'})
  const results = JSON.parse(res.content[0].text)

  assert.ok(results.length > 0)
  assert.ok(results[0].path.endsWith('main.js'))
})
