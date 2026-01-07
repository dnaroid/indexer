import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { tmpdir } from 'os'
import {
  loadSnapshot,
  saveSnapshot,
  createSnapshot,
  compareSnapshots,
  getFilesToIndex,
  deleteSnapshot,
  snapshotExists,
  getSnapshotMetadata
} from './snapshot-manager.js'

let testProjectDir

test.beforeEach(async () => {
  // Create a temporary directory for testing
  testProjectDir = path.join(tmpdir(), `ai-indexer-test-${Date.now()}`)
  await fs.mkdir(testProjectDir, { recursive: true })
  await fs.mkdir(path.join(testProjectDir, '.indexer'), { recursive: true })
})

test.afterEach(async () => {
  // Clean up test directory
  try {
    await fs.rm(testProjectDir, { recursive: true, force: true })
  } catch (e) {
    // Ignore cleanup errors
  }
})

test('should save and load a snapshot', async () => {
  const snapshot = {
    version: 1,
    timestamp: Date.now(),
    files: {
      'src/test.js': {
        mtimeMs: 1234567890,
        size: 1024,
        hash: 'abc123'
      }
    }
  }

  await saveSnapshot(testProjectDir, snapshot)
  const loaded = await loadSnapshot(testProjectDir)

  assert.notStrictEqual(loaded, null)
  assert.strictEqual(loaded.version, 1)
  assert.strictEqual(Object.keys(loaded.files).length, 1)
  assert.strictEqual(loaded.files['src/test.js'].hash, 'abc123')
})

test('should return null for non-existent snapshot', async () => {
  const loaded = await loadSnapshot(testProjectDir)
  assert.strictEqual(loaded, null)
})

test('should return null for invalid snapshot structure', async () => {
  const snapshotPath = path.join(testProjectDir, '.indexer', 'snapshot.json')
  await fs.writeFile(snapshotPath, JSON.stringify({ invalid: 'structure' }))

  const loaded = await loadSnapshot(testProjectDir)
  assert.strictEqual(loaded, null)
})

test('should create a snapshot of project files', async () => {
  // Create test files
  const srcDir = path.join(testProjectDir, 'src')
  await fs.mkdir(srcDir, { recursive: true })
  await fs.writeFile(path.join(srcDir, 'test.js'), 'console.log("test")')
  await fs.writeFile(path.join(testProjectDir, 'README.md'), '# Test Project')

  // Create .indexer/to-index configuration
  await fs.writeFile(
    path.join(testProjectDir, '.indexer', 'to-index'),
    'src/**\nREADME.md\n'
  )

  const snapshot = await createSnapshot(testProjectDir)

  assert.strictEqual(snapshot.version, 1)
  assert(snapshot.timestamp > 0)
  assert(Object.keys(snapshot.files).length > 0)
  assert(snapshot.files['src/test.js'])
  assert(snapshot.files['README.md'])
})

test('should include file metadata in snapshot', async () => {
  const testFile = path.join(testProjectDir, 'test.js')
  await fs.writeFile(testFile, 'test content')

  // Create .indexer/to-index configuration
  await fs.writeFile(
    path.join(testProjectDir, '.indexer', 'to-index'),
    'test.js\n'
  )

  const snapshot = await createSnapshot(testProjectDir)
  const fileMeta = snapshot.files['test.js']

  assert(fileMeta)
  assert(fileMeta.mtimeMs > 0)
  assert(fileMeta.size > 0)
  assert(fileMeta.hash)
  assert.strictEqual(fileMeta.size, 12) // 'test content' length
})

test('should detect added files', async () => {
  const oldSnapshot = {
    version: 1,
    timestamp: Date.now(),
    files: {
      'old.js': { mtimeMs: 1, size: 10, hash: 'old' }
    }
  }

  const newSnapshot = {
    version: 1,
    timestamp: Date.now(),
    files: {
      'old.js': { mtimeMs: 1, size: 10, hash: 'old' },
      'new.js': { mtimeMs: 2, size: 20, hash: 'new' }
    }
  }

  const diff = await compareSnapshots(oldSnapshot, newSnapshot)

  assert.strictEqual(diff.added.length, 1)
  assert.strictEqual(diff.added[0], 'new.js')
  assert.strictEqual(diff.modified.length, 0)
  assert.strictEqual(diff.removed.length, 0)
})

test('should detect modified files', async () => {
  const oldSnapshot = {
    version: 1,
    timestamp: Date.now(),
    files: {
      'file.js': { mtimeMs: 1, size: 10, hash: 'old' }
    }
  }

  const newSnapshot = {
    version: 1,
    timestamp: Date.now(),
    files: {
      'file.js': { mtimeMs: 2, size: 20, hash: 'new' }
    }
  }

  const diff = await compareSnapshots(oldSnapshot, newSnapshot)

  assert.strictEqual(diff.modified.length, 1)
  assert.strictEqual(diff.modified[0], 'file.js')
  assert.strictEqual(diff.added.length, 0)
  assert.strictEqual(diff.removed.length, 0)
})

test('should detect removed files', async () => {
  const oldSnapshot = {
    version: 1,
    timestamp: Date.now(),
    files: {
      'file.js': { mtimeMs: 1, size: 10, hash: 'old' }
    }
  }

  const newSnapshot = {
    version: 1,
    timestamp: Date.now(),
    files: {}
  }

  const diff = await compareSnapshots(oldSnapshot, newSnapshot)

  assert.strictEqual(diff.removed.length, 1)
  assert.strictEqual(diff.removed[0], 'file.js')
  assert.strictEqual(diff.added.length, 0)
  assert.strictEqual(diff.modified.length, 0)
})

test('should detect unchanged files', async () => {
  const oldSnapshot = {
    version: 1,
    timestamp: Date.now(),
    files: {
      'file.js': { mtimeMs: 1, size: 10, hash: 'same' }
    }
  }

  const newSnapshot = {
    version: 1,
    timestamp: Date.now(),
    files: {
      'file.js': { mtimeMs: 2, size: 10, hash: 'same' }
    }
  }

  const diff = await compareSnapshots(oldSnapshot, newSnapshot)

  assert.strictEqual(diff.unchanged.length, 1)
  assert.strictEqual(diff.unchanged[0], 'file.js')
})

test('should provide total counts', async () => {
  const oldSnapshot = {
    version: 1,
    timestamp: Date.now(),
    files: {
      'file1.js': { mtimeMs: 1, size: 10, hash: 'old1' },
      'file2.js': { mtimeMs: 1, size: 10, hash: 'old2' },
      'file3.js': { mtimeMs: 1, size: 10, hash: 'old3' }
    }
  }

  const newSnapshot = {
    version: 1,
    timestamp: Date.now(),
    files: {
      'file2.js': { mtimeMs: 2, size: 20, hash: 'new2' }, // modified
      'file3.js': { mtimeMs: 1, size: 10, hash: 'old3' }, // unchanged
      'file4.js': { mtimeMs: 2, size: 20, hash: 'new4' }  // added
    }
  }

  const diff = await compareSnapshots(oldSnapshot, newSnapshot)

  assert.strictEqual(diff.total.added, 1)
  assert.strictEqual(diff.total.modified, 1)
  assert.strictEqual(diff.total.removed, 1)
  assert.strictEqual(diff.total.unchanged, 1)
})

test('should return all files for first-time indexing', async () => {
  // Create test files
  const srcDir = path.join(testProjectDir, 'src')
  await fs.mkdir(srcDir, { recursive: true })
  await fs.writeFile(path.join(srcDir, 'test.js'), 'console.log("test")')

  // Create .indexer/to-index configuration
  await fs.writeFile(
    path.join(testProjectDir, '.indexer', 'to-index'),
    'src/**\n'
  )

  const result = await getFilesToIndex(testProjectDir)

  assert.strictEqual(result.isNew, true)
  assert(result.filesToIndex.length > 0)
  assert.strictEqual(result.filesToRemove.length, 0)
})

test('should return only changed files on subsequent runs', async () => {
  // Create initial files
  const srcDir = path.join(testProjectDir, 'src')
  await fs.mkdir(srcDir, { recursive: true })
  await fs.writeFile(path.join(srcDir, 'file1.js'), 'content1')
  await fs.writeFile(path.join(srcDir, 'file2.js'), 'content2')

  // Create .indexer/to-index configuration
  await fs.writeFile(
    path.join(testProjectDir, '.indexer', 'to-index'),
    'src/**\n'
  )

  // First run - should index all files
  const firstResult = await getFilesToIndex(testProjectDir)
  assert.strictEqual(firstResult.isNew, true)
  assert.strictEqual(firstResult.filesToIndex.length, 2)

  // Modify one file
  await fs.writeFile(path.join(srcDir, 'file1.js'), 'modified content')

  // Second run - should only index modified file
  const secondResult = await getFilesToIndex(testProjectDir)
  assert.strictEqual(secondResult.isNew, false)
  assert.strictEqual(secondResult.filesToIndex.length, 1)
  assert.strictEqual(secondResult.filesToIndex[0], 'src/file1.js')
})

test('should detect removed files', async () => {
  // Create initial files
  const srcDir = path.join(testProjectDir, 'src')
  await fs.mkdir(srcDir, { recursive: true })
  await fs.writeFile(path.join(srcDir, 'file1.js'), 'content1')
  await fs.writeFile(path.join(srcDir, 'file2.js'), 'content2')

  // Create .indexer/to-index configuration
  await fs.writeFile(
    path.join(testProjectDir, '.indexer', 'to-index'),
    'src/**\n'
  )

  // First run
  await getFilesToIndex(testProjectDir)

  // Delete one file
  await fs.unlink(path.join(srcDir, 'file2.js'))

  // Second run - should detect removed file
  const result = await getFilesToIndex(testProjectDir)
  assert.strictEqual(result.isNew, false)
  assert.strictEqual(result.filesToRemove.length, 1)
  assert.strictEqual(result.filesToRemove[0], 'src/file2.js')
})

test('should delete existing snapshot', async () => {
  const snapshot = {
    version: 1,
    timestamp: Date.now(),
    files: {}
  }

  await saveSnapshot(testProjectDir, snapshot)
  assert(await snapshotExists(testProjectDir))

  await deleteSnapshot(testProjectDir)
  assert(!(await snapshotExists(testProjectDir)))
})

test('should not throw when deleting non-existent snapshot', async () => {
  await deleteSnapshot(testProjectDir)
  // Should not throw
})

test('should return true for existing snapshot', async () => {
  const snapshot = {
    version: 1,
    timestamp: Date.now(),
    files: {}
  }

  await saveSnapshot(testProjectDir, snapshot)
  assert(await snapshotExists(testProjectDir))
})

test('should return false for non-existent snapshot', async () => {
  assert(!(await snapshotExists(testProjectDir)))
})

test('should return metadata for existing snapshot', async () => {
  const snapshot = {
    version: 1,
    timestamp: 1234567890,
    files: {
      'file1.js': { mtimeMs: 1, size: 10, hash: 'hash1' },
      'file2.js': { mtimeMs: 2, size: 20, hash: 'hash2' }
    }
  }

  await saveSnapshot(testProjectDir, snapshot)
  const metadata = await getSnapshotMetadata(testProjectDir)

  assert(metadata !== null)
  assert.strictEqual(metadata.version, 1)
  assert.strictEqual(metadata.timestamp, 1234567890)
  assert.strictEqual(metadata.fileCount, 2)
})

test('should return null for non-existent snapshot metadata', async () => {
  const metadata = await getSnapshotMetadata(testProjectDir)
  assert.strictEqual(metadata, null)
})
