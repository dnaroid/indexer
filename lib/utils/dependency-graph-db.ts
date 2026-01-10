import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import os from 'os'

const HOME_DIR = os.homedir()
const INDEXER_DIR = path.join(HOME_DIR, '.indexer')
const DEPENDENCY_GRAPH_DB_PATH = path.join(INDEXER_DIR, 'dependency-graph.db')

export interface DependencyNode {
  collection_id: string
  file_path: string
  module_path: string
  lang: string
  is_external: boolean
  package_name: string | null
  hash: string
}

export interface DependencyEdge {
  collection_id: string
  source_file: string
  target_file: string | null
  target_module: string
  import_type: string
  imported_names: string | null
  line_number: number | null
  is_resolved: boolean
}

let db: Database.Database | null = null

/**
 * Initialize and get database instance
 */
function getDb(): Database.Database {
  if (!db) {
    const dbPath = DEPENDENCY_GRAPH_DB_PATH
    const dbDir = path.dirname(dbPath)

    // Ensure directory exists
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true })
    }

    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')

    // Create table for dependency nodes
    db.exec(`
      CREATE TABLE IF NOT EXISTS dependency_nodes (
        collection_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        module_path TEXT NOT NULL,
        lang TEXT NOT NULL,
        is_external INTEGER DEFAULT 0,
        package_name TEXT,
        hash TEXT NOT NULL,
        PRIMARY KEY (collection_id, file_path)
      )
    `)

    // Create table for dependency edges
    db.exec(`
      CREATE TABLE IF NOT EXISTS dependency_edges (
        collection_id TEXT NOT NULL,
        source_file TEXT NOT NULL,
        target_file TEXT,
        target_module TEXT NOT NULL,
        import_type TEXT NOT NULL,
        imported_names TEXT,
        line_number INTEGER,
        is_resolved INTEGER DEFAULT 0,
        PRIMARY KEY (collection_id, source_file, target_module, line_number)
      )
    `)

    // Create indices for faster queries
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_nodes_collection
      ON dependency_nodes(collection_id)
    `)

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_edges_collection
      ON dependency_edges(collection_id)
    `)

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_edges_source
      ON dependency_edges(collection_id, source_file)
    `)

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_edges_target
      ON dependency_edges(collection_id, target_file)
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
 * Save a dependency node
 */
export async function saveNode(
  collectionId: string,
  node: Omit<DependencyNode, 'collection_id'>
): Promise<void> {
  return new Promise((resolve) => {
    const database = getDb()
    const stmt = database.prepare(`
      INSERT OR REPLACE INTO dependency_nodes
      (collection_id, file_path, module_path, lang, is_external, package_name, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    stmt.run(
      collectionId,
      node.file_path,
      node.module_path,
      node.lang,
      node.is_external ? 1 : 0,
      node.package_name,
      node.hash
    )

    resolve()
  })
}

/**
 * Save a dependency edge
 */
export async function saveEdge(
  collectionId: string,
  edge: Omit<DependencyEdge, 'collection_id'>
): Promise<void> {
  return new Promise((resolve) => {
    const database = getDb()
    const stmt = database.prepare(`
      INSERT OR REPLACE INTO dependency_edges
      (collection_id, source_file, target_file, target_module, import_type, imported_names, line_number, is_resolved)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)

    stmt.run(
      collectionId,
      edge.source_file,
      edge.target_file,
      edge.target_module,
      edge.import_type,
      edge.imported_names,
      edge.line_number,
      edge.is_resolved ? 1 : 0
    )

    resolve()
  })
}

/**
 * Save multiple nodes in a transaction
 */
export async function saveNodes(
  collectionId: string,
  nodes: Omit<DependencyNode, 'collection_id'>[]
): Promise<void> {
  return new Promise((resolve) => {
    const database = getDb()

    const transaction = database.transaction(() => {
      const stmt = database.prepare(`
        INSERT OR REPLACE INTO dependency_nodes
        (collection_id, file_path, module_path, lang, is_external, package_name, hash)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)

      for (const node of nodes) {
        stmt.run(
          collectionId,
          node.file_path,
          node.module_path,
          node.lang,
          node.is_external ? 1 : 0,
          node.package_name,
          node.hash
        )
      }
    })

    transaction()
    resolve()
  })
}

/**
 * Save multiple edges in a transaction
 */
export async function saveEdges(
  collectionId: string,
  edges: Omit<DependencyEdge, 'collection_id'>[]
): Promise<void> {
  return new Promise((resolve) => {
    const database = getDb()

    const transaction = database.transaction(() => {
      const stmt = database.prepare(`
        INSERT OR REPLACE INTO dependency_edges
        (collection_id, source_file, target_file, target_module, import_type, imported_names, line_number, is_resolved)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)

      for (const edge of edges) {
        stmt.run(
          collectionId,
          edge.source_file,
          edge.target_file,
          edge.target_module,
          edge.import_type,
          edge.imported_names,
          edge.line_number,
          edge.is_resolved ? 1 : 0
        )
      }
    })

    transaction()
    resolve()
  })
}

/**
 * Get all nodes for a collection
 */
export async function getNodesByCollection(collectionId: string): Promise<DependencyNode[]> {
  return new Promise((resolve) => {
    const database = getDb()
    const stmt = database.prepare(`
      SELECT * FROM dependency_nodes WHERE collection_id = ?
    `)

    const rows = stmt.all(collectionId) as any[]

    const nodes: DependencyNode[] = rows.map((row) => ({
      collection_id: row.collection_id,
      file_path: row.file_path,
      module_path: row.module_path,
      lang: row.lang,
      is_external: Boolean(row.is_external),
      package_name: row.package_name,
      hash: row.hash
    }))

    resolve(nodes)
  })
}

/**
 * Get outgoing edges for a source file
 */
export async function getEdgesBySource(
  collectionId: string,
  sourceFile: string
): Promise<DependencyEdge[]> {
  return new Promise((resolve) => {
    const database = getDb()
    const stmt = database.prepare(`
      SELECT * FROM dependency_edges
      WHERE collection_id = ? AND source_file = ?
    `)

    const rows = stmt.all(collectionId, sourceFile) as any[]

    const edges: DependencyEdge[] = rows.map((row) => ({
      collection_id: row.collection_id,
      source_file: row.source_file,
      target_file: row.target_file,
      target_module: row.target_module,
      import_type: row.import_type,
      imported_names: row.imported_names,
      line_number: row.line_number,
      is_resolved: Boolean(row.is_resolved)
    }))

    resolve(edges)
  })
}

/**
 * Get incoming edges for a target file (reverse dependencies)
 */
export async function getEdgesByTarget(
  collectionId: string,
  targetFile: string
): Promise<DependencyEdge[]> {
  return new Promise((resolve) => {
    const database = getDb()
    const stmt = database.prepare(`
      SELECT * FROM dependency_edges
      WHERE collection_id = ? AND target_file = ?
    `)

    const rows = stmt.all(collectionId, targetFile) as any[]

    const edges: DependencyEdge[] = rows.map((row) => ({
      collection_id: row.collection_id,
      source_file: row.source_file,
      target_file: row.target_file,
      target_module: row.target_module,
      import_type: row.import_type,
      imported_names: row.imported_names,
      line_number: row.line_number,
      is_resolved: Boolean(row.is_resolved)
    }))

    resolve(edges)
  })
}

/**
 * Get edges by path prefix
 */
export async function getEdgesByPathPrefix(
  collectionId: string,
  pathPrefix: string
): Promise<DependencyEdge[]> {
  return new Promise((resolve) => {
    const database = getDb()
    const stmt = database.prepare(`
      SELECT * FROM dependency_edges
      WHERE collection_id = ? AND source_file LIKE ?
    `)

    const rows = stmt.all(collectionId, `${pathPrefix}%`) as any[]

    const edges: DependencyEdge[] = rows.map((row) => ({
      collection_id: row.collection_id,
      source_file: row.source_file,
      target_file: row.target_file,
      target_module: row.target_module,
      import_type: row.import_type,
      imported_names: row.imported_names,
      line_number: row.line_number,
      is_resolved: Boolean(row.is_resolved)
    }))

    resolve(edges)
  })
}

/**
 * Delete a file from the dependency graph
 */
export async function deleteFileFromGraph(
  collectionId: string,
  filePath: string
): Promise<void> {
  return new Promise((resolve) => {
    const database = getDb()

    const transaction = database.transaction(() => {
      // Delete node
      const deleteNodeStmt = database.prepare(`
        DELETE FROM dependency_nodes
        WHERE collection_id = ? AND file_path = ?
      `)
      deleteNodeStmt.run(collectionId, filePath)

      // Delete outgoing edges
      const deleteEdgesStmt = database.prepare(`
        DELETE FROM dependency_edges
        WHERE collection_id = ? AND source_file = ?
      `)
      deleteEdgesStmt.run(collectionId, filePath)

      // Note: We don't delete incoming edges (target_file) as other files may still reference this file
    })

    transaction()
    resolve()
  })
}

/**
 * Clear entire graph for a collection
 */
export async function clearGraph(collectionId: string): Promise<void> {
  return new Promise((resolve) => {
    const database = getDb()

    const transaction = database.transaction(() => {
      const deleteNodesStmt = database.prepare(`
        DELETE FROM dependency_nodes WHERE collection_id = ?
      `)
      deleteNodesStmt.run(collectionId)

      const deleteEdgesStmt = database.prepare(`
        DELETE FROM dependency_edges WHERE collection_id = ?
      `)
      deleteEdgesStmt.run(collectionId)
    })

    transaction()
    resolve()
  })
}

/**
 * Get all collection IDs in the database
 */
export async function getAllCollectionIds(): Promise<string[]> {
  return new Promise((resolve) => {
    const database = getDb()
    const stmt = database.prepare(`
      SELECT DISTINCT collection_id FROM dependency_nodes
    `)
    const rows = stmt.all() as { collection_id: string }[]
    resolve(rows.map((r) => r.collection_id))
  })
}
