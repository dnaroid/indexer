import test, {mock} from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import {initTreeSitter} from './tree-sitter.js'

// --- Mocking child_process for runRipgrep ---
const spawnMock = mock.fn((cmd, args) => {
  const stdoutListeners = []
  const stderrListeners = []
  const closeListeners = []
  const errorListeners = []

  // Simulate output based on args
  const pattern = args[4] // 'MySymbol' in our test call
  
  setTimeout(() => {
    if (pattern === 'ExistingSymbol') {
      const output = `/abs/path/to/file.js:10:const ExistingSymbol = 1\n`
      stdoutListeners.forEach(cb => cb(output))
      closeListeners.forEach(cb => cb(0))
    } else if (pattern === 'ErrorSymbol') {
        stderrListeners.forEach(cb => cb('some error'))
        closeListeners.forEach(cb => cb(2))
    } else {
      // No match
      closeListeners.forEach(cb => cb(1))
    }
  }, 10)

  return {
    stdout: {
      on: (event, cb) => { if (event === 'data') stdoutListeners.push(cb) }
    },
    stderr: {
        on: (event, cb) => { if (event === 'data') stderrListeners.push(cb) }
    },
    on: (event, cb) => {
      if (event === 'close') closeListeners.push(cb)
      if (event === 'error') errorListeners.push(cb)
    }
  }
})

// Now import the module under test
import {
    detectLanguage,
    extractSymbols,
    buildTreeText,
    runRipgrep
} from './mcp-tools.js'


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
    
    // We expect something like:
    // 	├── README.md
    // 	└── src
    // 	    ├── main.js
    // 	    └── utils
    // 	        └── helper.js
    
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
    // We need to set WORKSPACE_DIR for relative path calculation in our mock/impl
    process.env.WORKSPACE_DIR = '/abs/path/to'
    const cwd = '/abs/path/to'
    
    const results = await runRipgrep('ExistingSymbol', cwd, spawnMock)
    
    assert.equal(spawnMock.mock.calls.length, 1)
    assert.equal(results.length, 1)
    assert.equal(results[0].path, 'file.js')
    assert.equal(results[0].line, 10)
    assert.equal(results[0].snippet, 'const ExistingSymbol = 1')
})

test('runRipgrep returns empty on no match', async () => {
    const cwd = '/abs/path/to'
    const results = await runRipgrep('NonExistent', cwd, spawnMock)
    assert.equal(results.length, 0)
})
