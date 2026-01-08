import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import {
  detectProjectIndexConfig,
  setFs
} from './project-detector.js'

interface MockFs {
  stat: (p: string) => Promise<any>
  readFile: (p: string, encoding: string) => Promise<string>
  [key: string]: any
}

// Helper to create a mock FS
function createMockFs(files: Record<string, string> = {}): MockFs {
  return {
    stat: async (p: string) => {
      const rel = path.relative('/', p) // simplistic handling
      // Check if file or dir exists in our map
      // We'll just check if any key starts with this path (dir) or is exact match
      const exists = Object.keys(files).some(k => k === p || k.startsWith(p + '/'))
      if (exists) return {} // mock stat object
      const err = new Error('ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    },
    readFile: async (p: string, encoding: string) => {
      if (files[p]) return files[p]
      const err = new Error('ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
  }
}

test('detectProjectIndexConfig identifies Unity project', async () => {
  const root = '/unity-project'
  const mockFs = createMockFs({
    [`${root}/Assets/Script.cs`]: '...',
    [`${root}/ProjectSettings/ProjectSettings.asset`]: '...'
  })
  setFs(mockFs)

  const config = await detectProjectIndexConfig(root)

  assert.equal(config.type, 'unity')
  assert.deepEqual(config.dirs, ['Assets'])
  assert.ok(config.exts.includes('.cs'))
  assert.ok(!config.exts.includes('.js'))
})

test('detectProjectIndexConfig identifies Next.js project by config', async () => {
  const root = '/next-app'
  const mockFs = createMockFs({
    [`${root}/next.config.js`]: 'module.exports = {}',
    [`${root}/src/app/page.tsx`]: '...'
  })
  setFs(mockFs)

  const config = await detectProjectIndexConfig(root)

  assert.equal(config.type, 'nextjs')
  assert.ok(config.dirs.includes('src'))
  assert.ok(config.exts.includes('.tsx'))
  // Ensure no garbage extensions
  assert.ok(!config.exts.includes('.css'))
  assert.ok(!config.exts.includes('.json'))
})

test('detectProjectIndexConfig identifies Node.js project by package.json', async () => {
  const root = '/node-app'
  const mockFs = createMockFs({
    [`${root}/package.json`]: '{"name": "my-app"}',
    [`${root}/src/index.js`]: '...'
  })
  setFs(mockFs)

  const config = await detectProjectIndexConfig(root)

  assert.equal(config.type, 'node')
  assert.ok(config.dirs.includes('src'))
  assert.ok(config.exts.includes('.js'))
})

test('detectProjectIndexConfig identifies Python project', async () => {
  const root = '/py-app'
  const mockFs = createMockFs({
    [`${root}/requirements.txt`]: 'flask',
    [`${root}/app/main.py`]: '...'
  })
  setFs(mockFs)

  const config = await detectProjectIndexConfig(root)

  assert.equal(config.type, 'python')
  assert.ok(config.dirs.includes('app'))
  assert.ok(config.exts.includes('.py'))
})

test('detectProjectIndexConfig falls back to generic', async () => {
  const root = '/generic-app'
  const mockFs = createMockFs({
    [`${root}/script.rb`]: '...'
  })
  setFs(mockFs)

  const config = await detectProjectIndexConfig(root)

  assert.equal(config.type, 'generic')
  assert.deepEqual(config.dirs, [])
  assert.ok(config.exts.includes('.js')) // generic includes common langs
  assert.ok(config.exts.includes('.py'))
})
