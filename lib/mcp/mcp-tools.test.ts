import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import { initTreeSitter } from '../utils/tree-sitter.js'
import {
  detectLanguage,
  extractSymbols,
  buildTreeText,
  runRipgrep,
  filterReferences
} from '../tools/common/utils.js'
import type { RipgrepResult, SymbolInfo } from '../tools/common/types.js'

// --- Mocking child_process for runRipgrep ---
interface MockChildProcess {
  stdout: { on: (event: string, cb: (data: string) => void) => void }
  stderr: { on: (event: string, cb: (data: string) => void) => void }
  on: (event: string, cb: (code: number | Error) => void) => void
}

const spawnMock = mock.fn((cmd: string, args: string[]): MockChildProcess => {
  const stdoutListeners: ((data: string) => void)[] = []
  const stderrListeners: ((data: string) => void)[] = []
  const closeListeners: ((code: number) => void)[] = []
  const errorListeners: ((err: Error) => void)[] = []

  // Simulate output based on args
  // args with --column: [ '--color=never', '--no-heading', '--line-number', '--column', '-w', pattern, workspaceDir ]
  const pattern = args[5]

  setTimeout(() => {
    if (pattern === 'ExistingSymbol') {
      const output = `/abs/path/to/file.js:10:5:const ExistingSymbol = 1\n`
      stdoutListeners.forEach(cb => cb(output))
      closeListeners.forEach(cb => cb(0))
    } else if (pattern === 'ErrorSymbol') {
      stderrListeners.forEach(cb => cb('some error'))
      closeListeners.forEach(cb => cb(2))
    } else {
      // No match
      closeListeners.forEach(cb => cb(1))
    }
  }, 10) as any

  return {
    stdout: {
      on: (event: string, cb: (data: string) => void) => {
        if (event === 'data') stdoutListeners.push(cb)
      }
    },
    stderr: {
      on: (event: string, cb: (data: string) => void) => {
        if (event === 'data') stderrListeners.push(cb)
      }
    },
    on: (event: string, cb: (code: number | Error) => void) => {
      if (event === 'close') closeListeners.push(cb)
      if (event === 'error') errorListeners.push(cb)
    }
  }
})

test.before(async () => {
  await initTreeSitter()
})

test('detectLanguage maps extensions correctly', () => {
  assert.equal(detectLanguage('file.js'), 'javascript')
  assert.equal(detectLanguage('file.ts'), 'typescript')
  assert.equal(detectLanguage('file.py'), 'python')
  assert.equal(detectLanguage('file.cs'), 'csharp')
  assert.equal(detectLanguage('unknown.xyz'), 'text')
})

test('buildTreeText creates visual tree', () => {
  const files = [
    'src/main.js',
    'src/utils/helper.js',
    'README.md'
  ]
  const tree = buildTreeText(files)

  assert.ok(tree.includes('├── README.md'))
  assert.ok(tree.includes('└── src'))
  assert.ok(tree.includes('    ├── main.js'))
  assert.ok(tree.includes('    └── utils'))
  assert.ok(tree.includes('        └── helper.js'))
})

test('extractSymbols delegates to correct extractor', async () => {
  // JS
  const jsCode = `class MyClass { method() {} }`
  const jsSymbols = await extractSymbols('test.js', jsCode)
  assert.ok(jsSymbols.find(s => s.name === 'MyClass'))
  assert.ok(jsSymbols.find(s => s.name === 'MyClass.method'))

  // Python
  const pyCode = `def my_func(): pass`
  const pySymbols = await extractSymbols('test.py', pyCode)
  assert.ok(pySymbols.find(s => s.name === 'my_func'))
})

test('runRipgrep calls spawn and parses output', async () => {
  process.env.WORKSPACE_DIR = '/abs/path/to'
  const cwd = '/abs/path/to'

  const results = await runRipgrep('ExistingSymbol', cwd, spawnMock as any) as RipgrepResult[]

  assert.equal(spawnMock.mock.calls.length, 1)
  assert.equal(results.length, 1)
  assert.equal(results[0].path, 'file.js')
  assert.equal(results[0].line, 10)
  assert.equal(results[0].column, 5)
  assert.equal(results[0].snippet, 'const ExistingSymbol = 1')
})

test('runRipgrep returns empty on no match', async () => {
  const cwd = '/abs/path/to'
  const results = await runRipgrep('NonExistent', cwd, spawnMock as any) as RipgrepResult[]
  assert.equal(results.length, 0)
})

test('filterReferences removes comments and strings', async () => {
  const workspaceDir = '/test'
  const readFileMock = mock.fn((filePath: string) => {
    if (filePath.endsWith('test.js')) {
      return `
        // Comment with SymbolA
        const SymbolA = "SymbolA in string";
        console.log(SymbolA);
      `
    }
    if (filePath.endsWith('test.py')) {
      return `
# Comment SymbolB
val = "SymbolB"
print(SymbolB)
      `
    }
    return ''
  })

  const input = [
    { path: 'test.js', line: 2, column: 21, snippet: '// Comment with SymbolA' },
    { path: 'test.js', line: 3, column: 26, snippet: 'const SymbolA = "SymbolA in string";' },
    { path: 'test.js', line: 4, column: 21, snippet: 'console.log(SymbolA);' },
    { path: 'test.py', line: 2, column: 12, snippet: '# Comment SymbolB' },
    { path: 'test.py', line: 3, column: 8, snippet: 'val = "SymbolB"' },
    { path: 'test.py', line: 4, column: 7, snippet: 'print(SymbolB)' }
  ]

  const filtered = await filterReferences(input, workspaceDir, readFileMock as any)

  // Expected:
  // JS: only line 4 (console.log)
  // PY: only line 4 (print)
  assert.equal(filtered.length, 2)
  assert.equal(filtered[0].path, 'test.js')
  assert.equal(filtered[0].line, 4)
  assert.equal(filtered[1].path, 'test.py')
  assert.equal(filtered[1].line, 4)
})
