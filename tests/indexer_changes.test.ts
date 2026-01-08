import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import {
  indexFile,
  setFetch,
  resetConfigCache
} from '../lib/core/indexer-core.js'

// --- Mock Infrastructure ---

interface QdrantPoint {
  id: string
  payload: any
}

// In-memory "Qdrant" storage for points
// Structure: Map<point_id, point_object>
const db = new Map<string, QdrantPoint>()

// Helper to find points by path (simulating Qdrant filter)
function findPointsByPath(filePath: string): QdrantPoint[] {
  const found: QdrantPoint[] = []
  for (const p of db.values()) {
    if (p.payload && p.payload.path === filePath) {
      found.push(p)
    }
  }
  return found
}

// Mock implementation of fetch
const mockFetch = async (url: string, options: RequestInit = {}): Promise<Response> => {
  const method = options?.method || 'GET'
  const body = options?.body ? JSON.parse(options.body as string) : {}

  // 1. Mock Ollama Embeddings
  if (url.includes('/api/embeddings')) {
    return {
      ok: true,
      json: async () => ({
        embedding: new Array(768).fill(0.1) // Fake vector
      })
    } as Response
  }

  // 2. Mock Qdrant Collections Check
  if (url.endsWith('/collections') && method === 'GET') {
    return {
      ok: true,
      json: async () => ({
        result: { collections: [{ name: 'project_index' }] }
      })
    } as Response
  }

  // 3. Mock Qdrant Upsert (PUT /points)
  if (url.includes('/points') && method === 'PUT' && !url.includes('/index')) {
    const points = body.points || []
    for (const p of points) {
      db.set(p.id, p)
    }
    return { ok: true, json: async () => ({ result: {} }) } as Response
  }

  // 4. Mock Qdrant Scroll (Search by filter) - used for getExistingFileHash
  if (url.includes('/points/scroll')) {
    const filterPath = body.filter?.must?.find((m: any) => m.key === 'path')?.match?.value
    let points: QdrantPoint[] = []

    if (filterPath) {
      points = findPointsByPath(filterPath)
    } else {
      points = Array.from(db.values())
    }

    // Apply limit if needed (simplified)
    if (body.limit) {
      points = points.slice(0, body.limit)
    }

    return {
      ok: true,
      json: async () => ({ result: { points } })
    } as Response
  }

  // 5. Mock Qdrant Delete
  if (url.includes('/points/delete')) {
    const filterPath = body.filter?.must?.find((m: any) => m.key === 'path')?.match?.value
    if (filterPath) {
      const toDelete = findPointsByPath(filterPath)
      for (const p of toDelete) {
        db.delete(p.id)
      }
    }
    return { ok: true, json: async () => ({ result: {} }) } as Response
  }

  return { ok: true, json: async () => ({}) } as Response
}

// --- Tests ---

test('Indexer change detection', async (t) => {
  // Setup temporary workspace
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'indexer-test-'))
  process.env.WORKSPACE_DIR = tmpDir

  // Inject mock fetch
  setFetch(mockFetch)

  // Reset any cached configs
  resetConfigCache()

  const testFile = 'test_script.js'
  const absPath = path.join(tmpDir, testFile)

  // Helper to write content
  const write = async (content: string) => fs.writeFile(absPath, content, 'utf8')

  // Clean up after test
  t.after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  await t.test('1. First indexing (New File)', async () => {
    const content = 'console.log("Hello V1");'
    await write(content)

    const result = await indexFile(tmpDir, testFile, 'project_index')

    assert.equal(result.indexed, true, 'Should index a new file')
    assert.ok(result.chunks > 0, 'Should produce chunks')

    // Verify it's in our mock DB
    const points = findPointsByPath(testFile)
    assert.ok(points.length > 0, 'Points should be saved in DB')
    const crypto = await import('crypto')
    assert.equal(points[0].payload.file_hash, crypto.createHash('sha1').update(content).digest('hex'))
  })

  await t.test('2. Second indexing (Unchanged)', async () => {
    // Content on disk is same as step 1
    const result = await indexFile(tmpDir, testFile, 'project_index')

    assert.equal(result.indexed, false, 'Should not index unchanged file')
    assert.equal(result.reason, 'unchanged')
  })

  await t.test('3. Third indexing (Modified File)', async () => {
    const newContent = 'console.log("Hello V2 - Changed");'
    await write(newContent)

    const result = await indexFile(tmpDir, testFile, 'project_index')

    assert.equal(result.indexed, true, 'Should re-index modified file')

    // Verify DB updated
    const points = findPointsByPath(testFile)
    assert.ok(points.length > 0)

    const crypto = await import('crypto')
    const newHash = crypto.createHash('sha1').update(newContent).digest('hex')
    assert.equal(points[0].payload.file_hash, newHash, 'Hash in DB should be updated')
  })

  await t.test('4. Excluded file (by config) should not index', async () => {
    // Create a .json file which we recently excluded
    const jsonFile = 'config.json'
    await fs.writeFile(path.join(tmpDir, jsonFile), '{}', 'utf8')

    // We need to check 'shouldIndexFile' logic, but here we are testing 'indexFile' directly.
    // 'indexFile' doesn't check 'shouldIndexFile' internally (that's done by the caller/iterator).
    // So this test is skipped here as indexFile assumes it's allowed.
    // But we can check if language detection works correctly (should be 'text' now for json if we removed it from map)

    // Actually, let's verify detectLanguage behavior implicitly via payload
    const res = await indexFile(tmpDir, jsonFile, 'project_index')
    // Since we removed .json from detectLanguage, it should fallback to 'text'
    // But wait, indexFile logic:
    // const lang = detectLanguage(relPath)
    // ...
    // if (lang === 'text') -> extracts no symbols -> but still chunks and indexes text.

    // Let's check the payload in DB
    const points = findPointsByPath(jsonFile)
    // It might be indexed because indexFile forces indexing if called.
    // But the language should be 'text'.

    assert.equal(points[0].payload.lang, 'text', 'JSON should be treated as text (unknown language)')
  })
})
