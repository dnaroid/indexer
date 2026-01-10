
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import fs from 'fs/promises'
import { resolveImportPath, clearCaches } from './path-resolver.js'

const TEST_DIR = path.resolve(process.cwd(), 'test_resolver_playground')

async function setup() {
  await fs.mkdir(TEST_DIR, { recursive: true })
  
  // Create dummy structure
  // root/
  //   src/
  //     index.ts
  //     utils.ts
  //     components/
  //       Button.tsx
  //   lib/
  //     helper.js
  
  await fs.mkdir(path.join(TEST_DIR, 'src', 'components'), { recursive: true })
  await fs.mkdir(path.join(TEST_DIR, 'lib'), { recursive: true })

  await fs.writeFile(path.join(TEST_DIR, 'package.json'), JSON.stringify({ name: 'test-proj' }))
  await fs.writeFile(path.join(TEST_DIR, 'src', 'index.ts'), '')
  await fs.writeFile(path.join(TEST_DIR, 'src', 'utils.ts'), '')
  await fs.writeFile(path.join(TEST_DIR, 'src', 'components', 'Button.tsx'), '')
  await fs.writeFile(path.join(TEST_DIR, 'lib', 'helper.js'), '') // Real JS file
}

async function teardown() {
  await fs.rm(TEST_DIR, { recursive: true, force: true })
  clearCaches()
}

test.before(setup)
test.after(teardown)

test('resolveImportPath: resolves .js import to .ts file', async () => {
  const sourceFile = 'src/index.ts'
  
  // The Bug Fix: import ending in .js should find .ts
  const result = await resolveImportPath(
    './utils.js', 
    sourceFile, 
    TEST_DIR, 
    'typescript'
  )

  assert.equal(result.resolved, true)
  assert.equal(result.targetPath, 'src/utils.ts')
})

test('resolveImportPath: resolves .jsx import to .tsx file', async () => {
  const sourceFile = 'src/index.ts'
  
  const result = await resolveImportPath(
    './components/Button.jsx', 
    sourceFile, 
    TEST_DIR, 
    'typescript'
  )

  assert.equal(result.resolved, true)
  assert.equal(result.targetPath, 'src/components/Button.tsx')
})

test('resolveImportPath: resolves extensionless import to .ts file', async () => {
  const sourceFile = 'src/index.ts'
  
  const result = await resolveImportPath(
    './utils', 
    sourceFile, 
    TEST_DIR, 
    'typescript'
  )

  assert.equal(result.resolved, true)
  assert.equal(result.targetPath, 'src/utils.ts')
})

test('resolveImportPath: resolves real .js file', async () => {
  const sourceFile = 'src/index.ts'
  
  const result = await resolveImportPath(
    '../lib/helper.js', 
    sourceFile, 
    TEST_DIR, 
    'typescript'
  )

  assert.equal(result.resolved, true)
  assert.equal(result.targetPath, 'lib/helper.js')
})

test('resolveImportPath: handles external packages', async () => {
  const sourceFile = 'src/index.ts'
  
  const result = await resolveImportPath(
    'react', 
    sourceFile, 
    TEST_DIR, 
    'typescript'
  )

  assert.equal(result.resolved, true)
  assert.equal(result.isExternal, true)
  assert.equal(result.packageName, 'react')
  assert.equal(result.targetPath, null)
})
