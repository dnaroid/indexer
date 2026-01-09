import Database from 'better-sqlite3'
import { getSnapshotDbPath } from './config-global.js'
import fs from 'fs'
import path from 'path'

interface FileMetadata {
  mtimeMs: number
  size: number
  hash: string
}

interface SnapshotRow {
  collection_id: string
  file_path: string
  mtime_ms: number
  size: number
  hash: string
}

let db: Database.Database | null = null

/**
 * Initialize and get database instance
 */
function getDb(): Database.Database {
  if (!db) {
    const dbPath = getSnapshotDbPath()
    const dbDir = path.dirname(dbPath)

    // Ensure directory exists
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true })
    }

    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')

    // Create table for snapshot metadata
    db.exec(`
      CREATE TABLE IF NOT EXISTS snapshot_metadata (
        collection_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `)

    // Create table for snapshot files
    db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        collection_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        size INTEGER NOT NULL,
        hash TEXT NOT NULL,
        PRIMARY KEY (collection_id, file_path)
      )
    `)

    // Create index for faster queries
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_collection_id
      ON snapshots(collection_id)
    `)
  }

  return db
}

/**
 * Close database connection
 */
export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

/**
 * Load snapshot for a collection
 */
export async function loadSnapshot(collectionId: string): Promise<Record<string, FileMetadata> | null> {
  return new Promise((resolve) => {
    const database = getDb()

    // Check if snapshot exists in metadata
    const metadataStmt = database.prepare('SELECT COUNT(*) as count FROM snapshot_metadata WHERE collection_id = ?')
    const metadataResult = metadataStmt.get(collectionId) as { count: number }

    if (metadataResult.count === 0) {
      resolve(null)
      return
    }

    // Load files
    const stmt = database.prepare('SELECT file_path, mtime_ms, size, hash FROM snapshots WHERE collection_id = ?')
    const rows = stmt.all(collectionId) as SnapshotRow[]

    const files: Record<string, FileMetadata> = {}
    for (const row of rows) {
      files[row.file_path] = {
        mtimeMs: row.mtime_ms,
        size: row.size,
        hash: row.hash
      }
    }

    resolve(files)
  })
}

/**
 * Save snapshot for a collection
 */
export async function saveSnapshot(collectionId: string, files: Record<string, FileMetadata>, version: number = 1, timestamp: number = Date.now()): Promise<void> {
  return new Promise((resolve) => {
    const database = getDb()

    // Use transaction for better performance
    const transaction = database.transaction(() => {
      // Save metadata
      const metadataStmt = database.prepare(`
        INSERT OR REPLACE INTO snapshot_metadata (collection_id, version, timestamp)
        VALUES (?, ?, ?)
      `)
      metadataStmt.run(collectionId, version, timestamp)

      // Clear existing file entries for this collection
      const deleteStmt = database.prepare('DELETE FROM snapshots WHERE collection_id = ?')
      deleteStmt.run(collectionId)

      // Insert new file entries
      const insertStmt = database.prepare(`
        INSERT INTO snapshots (collection_id, file_path, mtime_ms, size, hash)
        VALUES (?, ?, ?, ?, ?)
      `)

      for (const [filePath, metadata] of Object.entries(files)) {
        insertStmt.run(collectionId, filePath, metadata.mtimeMs, metadata.size, metadata.hash)
      }
    })

    transaction()
    resolve()
  })
}

/**
 * Delete snapshot for a collection
 */
export async function deleteSnapshot(collectionId: string): Promise<void> {
  return new Promise((resolve) => {
    const database = getDb()

    // Use transaction to delete from both tables
    const transaction = database.transaction(() => {
      const deleteMetadataStmt = database.prepare('DELETE FROM snapshot_metadata WHERE collection_id = ?')
      deleteMetadataStmt.run(collectionId)

      const deleteFilesStmt = database.prepare('DELETE FROM snapshots WHERE collection_id = ?')
      deleteFilesStmt.run(collectionId)
    })

    transaction()
    resolve()
  })
}

/**
 * Check if snapshot exists for a collection
 */
export async function snapshotExists(collectionId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const database = getDb()
    const stmt = database.prepare('SELECT COUNT(*) as count FROM snapshot_metadata WHERE collection_id = ?')
    const result = stmt.get(collectionId) as { count: number }
    resolve(result.count > 0)
  })
}

/**
 * Get snapshot metadata
 */
export async function getSnapshotMetadata(collectionId: string): Promise<{
  version: number
  timestamp: number
  fileCount: number
} | null> {
  return new Promise((resolve) => {
    const database = getDb()

    // Get metadata
    const metadataStmt = database.prepare('SELECT version, timestamp FROM snapshot_metadata WHERE collection_id = ?')
    const metadataResult = metadataStmt.get(collectionId) as { version: number, timestamp: number } | undefined

    if (!metadataResult) {
      resolve(null)
      return
    }

    // Get file count
    const fileCountStmt = database.prepare('SELECT COUNT(*) as count FROM snapshots WHERE collection_id = ?')
    const fileCountResult = fileCountStmt.get(collectionId) as { count: number }

    resolve({
      version: metadataResult.version,
      timestamp: metadataResult.timestamp,
      fileCount: fileCountResult.count
    })
  })
}

/**
 * Get all collection IDs in the database
 */
export async function getAllCollectionIds(): Promise<string[]> {
  return new Promise((resolve) => {
    const database = getDb()
    const stmt = database.prepare('SELECT collection_id FROM snapshot_metadata')
    const rows = stmt.all() as { collection_id: string }[]
    resolve(rows.map(r => r.collection_id))
  })
}
