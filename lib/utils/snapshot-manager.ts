import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { listProjectFiles } from '../core/indexer-core.js'

const SNAPSHOT_VERSION = 1
const SNAPSHOT_FILENAME = 'snapshot.json'

interface FileMetadata {
  mtimeMs: number
  size: number
  hash: string
}

interface Snapshot {
  version: number
  timestamp: number
  files: Record<string, FileMetadata>
}

interface SnapshotDiff {
  added: string[]
  modified: string[]
  unchanged: string[]
  removed: string[]
  total: {
    added: number
    modified: number
    unchanged: number
    removed: number
  }
}

interface FilesToIndex {
  filesToIndex: string[]
  filesToRemove: string[]
  isNew: boolean
  diff?: SnapshotDiff
}

/**
 * Get the snapshot file path for a project
 */
function getSnapshotPath(projectRoot: string): string {
  return path.join(projectRoot, '.indexer', SNAPSHOT_FILENAME)
}

/**
 * Calculate SHA1 hash of file content
 */
async function calculateFileHash(filePath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8')
    return crypto.createHash('sha1').update(content).digest('hex')
  } catch (e) {
    return null
  }
}

/**
 * Load snapshot from file
 * @param projectRoot - Project root directory
 * @returns Snapshot object or null if not found
 */
export async function loadSnapshot(projectRoot: string): Promise<Snapshot | null> {
  const snapshotPath = getSnapshotPath(projectRoot)

  try {
    const content = await fs.readFile(snapshotPath, 'utf8')
    const snapshot = JSON.parse(content) as Snapshot

    // Validate snapshot structure
    if (!snapshot.version || !snapshot.files || typeof snapshot.files !== 'object') {
      return null
    }

    return snapshot
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      return null
    }
    throw new Error(`Failed to load snapshot: ${e.message}`)
  }
}

/**
 * Save snapshot to file
 * @param projectRoot - Project root directory
 * @param snapshot - Snapshot object to save
 */
export async function saveSnapshot(projectRoot: string, snapshot: Snapshot): Promise<void> {
  const snapshotPath = getSnapshotPath(projectRoot)
  const snapshotDir = path.dirname(snapshotPath)

  // Ensure directory exists
  await fs.mkdir(snapshotDir, { recursive: true })

  // Save snapshot
  await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8')
}

/**
 * Create a new snapshot of the project
 * @param projectRoot - Project root directory
 * @returns Snapshot object
 */
export async function createSnapshot(projectRoot: string): Promise<Snapshot> {
  const files = await listProjectFiles(projectRoot)
  const fileMetadata: Record<string, FileMetadata> = {}

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
 * @param oldSnapshot - Previous snapshot
 * @param newSnapshot - Current snapshot
 * @returns Diff object with added, modified, unchanged, removed arrays
 */
export async function compareSnapshots(oldSnapshot: Snapshot, newSnapshot: Snapshot): Promise<SnapshotDiff> {
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
 * @param projectRoot - Project root directory
 * @returns Object with filesToIndex and filesToRemove arrays
 */
export async function getFilesToIndex(projectRoot: string): Promise<FilesToIndex> {
  const oldSnapshot = await loadSnapshot(projectRoot)
  const newSnapshot = await createSnapshot(projectRoot)

  if (!oldSnapshot) {
    // First time - all files need to be indexed
    const allFiles = Object.keys(newSnapshot.files)
    // Save the snapshot for future comparisons
    await saveSnapshot(projectRoot, newSnapshot)
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

  // Save the new snapshot for future comparisons
  await saveSnapshot(projectRoot, newSnapshot)

  return {
    filesToIndex,
    filesToRemove,
    isNew: false,
    diff
  }
}

/**
 * Delete snapshot file for a project
 * @param projectRoot - Project root directory
 */
export async function deleteSnapshot(projectRoot: string): Promise<void> {
  const snapshotPath = getSnapshotPath(projectRoot)

  try {
    await fs.unlink(snapshotPath)
  } catch (e: any) {
    if (e.code !== 'ENOENT') {
      throw new Error(`Failed to delete snapshot: ${e.message}`)
    }
  }
}

/**
 * Check if snapshot exists for a project
 * @param projectRoot - Project root directory
 * @returns True if snapshot exists
 */
export async function snapshotExists(projectRoot: string): Promise<boolean> {
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
 * @param projectRoot - Project root directory
 * @returns Metadata object or null
 */
export async function getSnapshotMetadata(projectRoot: string): Promise<{
  version: number
  timestamp: number
  fileCount: number
} | null> {
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
