import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { listProjectFiles, shouldIndexFile } from './indexer-core.js'

const SNAPSHOT_VERSION = 1
const SNAPSHOT_FILENAME = 'snapshot.json'

// Always ignore these patterns for snapshots
const ALWAYS_IGNORED = [
  '**/.git/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.cache/**',
  '**/coverage/**',
  '**/.idea/**',
  '**/.vscode/**',
  '**/Library/**',
  '**/Temp/**',
  '**/obj/**',
  '**/Logs/**',
  '**/vs/**'
]

/**
 * Get the snapshot file path for a project
 */
function getSnapshotPath(projectRoot) {
  return path.join(projectRoot, '.indexer', SNAPSHOT_FILENAME)
}

/**
 * Calculate SHA1 hash of file content
 */
async function calculateFileHash(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8')
    return crypto.createHash('sha1').update(content).digest('hex')
  } catch (e) {
    return null
  }
}

/**
 * Load snapshot from file
 * @param {string} projectRoot - Project root directory
 * @returns {Promise<Object|null>} Snapshot object or null if not found
 */
export async function loadSnapshot(projectRoot) {
  const snapshotPath = getSnapshotPath(projectRoot)

  try {
    const content = await fs.readFile(snapshotPath, 'utf8')
    const snapshot = JSON.parse(content)

    // Validate snapshot structure
    if (!snapshot.version || !snapshot.files || typeof snapshot.files !== 'object') {
      return null
    }

    return snapshot
  } catch (e) {
    if (e.code === 'ENOENT') {
      return null
    }
    throw new Error(`Failed to load snapshot: ${e.message}`)
  }
}

/**
 * Save snapshot to file
 * @param {string} projectRoot - Project root directory
 * @param {Object} snapshot - Snapshot object to save
 */
export async function saveSnapshot(projectRoot, snapshot) {
  const snapshotPath = getSnapshotPath(projectRoot)
  const snapshotDir = path.dirname(snapshotPath)

  // Ensure directory exists
  await fs.mkdir(snapshotDir, { recursive: true })

  // Save snapshot
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8')
}

/**
 * Create a new snapshot of the project
 * @param {string} projectRoot - Project root directory
 * @returns {Promise<Object>} Snapshot object
 */
export async function createSnapshot(projectRoot) {
  const files = await listProjectFiles(projectRoot)
  const fileMetadata = {}

  for (const relPath of files) {
    const absPath = path.join(projectRoot, relPath)

    try {
      const stats = await fs.stat(absPath)
      const hash = await calculateFileHash(absPath)

      if (hash) {
        fileMetadata[relPath] = {
          mtimeMs: stats.mtimeMs,
          size: stats.size,
          hash: hash
        }
      }
    } catch (e) {
      // Skip files that can't be read
      continue
    }
  }

  return {
    version: SNAPSHOT_VERSION,
    timestamp: Date.now(),
    files: fileMetadata
  }
}

/**
 * Compare two snapshots and return the diff
 * @param {Object} oldSnapshot - Previous snapshot
 * @param {Object} newSnapshot - Current snapshot
 * @returns {Promise<Object>} Diff object with added, modified, unchanged, removed arrays
 */
export async function compareSnapshots(oldSnapshot, newSnapshot) {
  const oldFiles = new Set(Object.keys(oldSnapshot.files))
  const newFiles = new Set(Object.keys(newSnapshot.files))

  // Find added files (in new but not in old)
  const added = [...newFiles].filter(f => !oldFiles.has(f))

  // Find removed files (in old but not in new)
  const removed = [...oldFiles].filter(f => !newFiles.has(f))

  // Find common files
  const common = [...newFiles].filter(f => oldFiles.has(f))

  // Find modified files (hash changed)
  const modified = common.filter(f => {
    const oldMeta = oldSnapshot.files[f]
    const newMeta = newSnapshot.files[f]
    return oldMeta.hash !== newMeta.hash
  })

  // Find unchanged files
  const unchanged = common.filter(f => !modified.includes(f))

  return {
    added,
    modified,
    unchanged,
    removed,
    total: {
      added: added.length,
      modified: modified.length,
      unchanged: unchanged.length,
      removed: removed.length
    }
  }
}

/**
 * Get files that need to be indexed based on snapshot diff
 * @param {string} projectRoot - Project root directory
 * @returns {Promise<Object>} Object with filesToIndex and filesToRemove arrays
 */
export async function getFilesToIndex(projectRoot) {
  const oldSnapshot = await loadSnapshot(projectRoot)
  const newSnapshot = await createSnapshot(projectRoot)

  if (!oldSnapshot) {
    // First time - all files need to be indexed
    const allFiles = Object.keys(newSnapshot.files)
    return {
      filesToIndex: allFiles,
      filesToRemove: [],
      isNew: true
    }
  }

  const diff = await compareSnapshots(oldSnapshot, newSnapshot)

  // Files to index: added + modified
  const filesToIndex = [...diff.added, ...diff.modified]

  // Files to remove from index: removed
  const filesToRemove = diff.removed

  return {
    filesToIndex,
    filesToRemove,
    isNew: false,
    diff
  }
}

/**
 * Delete snapshot file for a project
 * @param {string} projectRoot - Project root directory
 */
export async function deleteSnapshot(projectRoot) {
  const snapshotPath = getSnapshotPath(projectRoot)

  try {
    await fs.unlink(snapshotPath)
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw new Error(`Failed to delete snapshot: ${e.message}`)
    }
  }
}

/**
 * Check if snapshot exists for a project
 * @param {string} projectRoot - Project root directory
 * @returns {Promise<boolean>} True if snapshot exists
 */
export async function snapshotExists(projectRoot) {
  const snapshotPath = getSnapshotPath(projectRoot)

  try {
    await fs.access(snapshotPath)
    return true
  } catch {
    return false
  }
}

/**
 * Get snapshot metadata without loading full snapshot
 * @param {string} projectRoot - Project root directory
 * @returns {Promise<Object|null>} Metadata object or null
 */
export async function getSnapshotMetadata(projectRoot) {
  const snapshot = await loadSnapshot(projectRoot)

  if (!snapshot) {
    return null
  }

  return {
    version: snapshot.version,
    timestamp: snapshot.timestamp,
    fileCount: Object.keys(snapshot.files).length
  }
}
