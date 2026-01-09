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

    // Create table if not exists
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
    const stmt = database.prepare('SELECT file_path, mtime_ms, size, hash FROM snapshots WHERE collection_id = ?')
    const rows = stmt.all(collectionId) as SnapshotRow[]

    if (rows.length === 0) {
      resolve(null)
      return
    }

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
export async function saveSnapshot(collectionId: string, files: Record<string, FileMetadata>): Promise<void> {
  return new Promise((resolve) => {
    const database = getDb()

    // Use transaction for better performance
    const transaction = database.transaction(() => {
      // Clear existing entries for this collection
      const deleteStmt = database.prepare('DELETE FROM snapshots WHERE collection_id = ?')
      deleteStmt.run(collectionId)

      // Insert new entries
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
    const stmt = database.prepare('DELETE FROM snapshots WHERE collection_id = ?')
    stmt.run(collectionId)
    resolve()
  })
}

/**
 * Check if snapshot exists for a collection
 */
export async function snapshotExists(collectionId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const database = getDb()
    const stmt = database.prepare('SELECT COUNT(*) as count FROM snapshots WHERE collection_id = ?')
    const result = stmt.get(collectionId) as { count: number }
    resolve(result.count > 0)
  })
}

/**
 * Get snapshot metadata
 */
export async function getSnapshotMetadata(collectionId: string): Promise<{
  fileCount: number
} | null> {
  return new Promise((resolve) => {
    const database = getDb()
    const stmt = database.prepare('SELECT COUNT(*) as count FROM snapshots WHERE collection_id = ?')
    const result = stmt.get(collectionId) as { count: number }

    if (result.count === 0) {
      resolve(null)
      return
    }

    resolve({
      fileCount: result.count
    })
  })
}

/**
 * Get all collection IDs in the database
 */
export async function getAllCollectionIds(): Promise<string[]> {
  return new Promise((resolve) => {
    const database = getDb()
    const stmt = database.prepare('SELECT DISTINCT collection_id FROM snapshots')
    const rows = stmt.all() as { collection_id: string }[]
    resolve(rows.map(r => r.collection_id))
  })
}
