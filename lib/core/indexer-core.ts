/**
 * Indexer Core Module
 * Main coordinator for indexing operations.
 * Coordinates between file filters, file indexer, and Qdrant client.
 */

import { initTreeSitter } from '../utils/tree-sitter.js'
import {
  ensureCollections,
  listAllIndexedPaths,
  listCollectionsExtended,
  dropCollection,
  dropCollection as deleteCollectionByName,
  dropCollection as dropCollections,
  setFetch as setQdrantFetch
} from './qdrant-client.js'
import {
  indexFile,
  setFetch as setFileIndexerFetch
} from './file-indexer.js'
import {
  listProjectFiles,
  shouldIndexFile,
  resetConfigCache
} from './file-filters.js'
import type { IndexerSettings } from '../types/index.js'

/**
 * Set custom fetch implementation for testing
 * Updates both file indexer and qdrant client
 */
export function setFetch(impl: any): void {
  setFileIndexerFetch(impl)
  setQdrantFetch(impl)
}

/**
 * Simple logger
 */
function log(msg: string): void {
  console.log(`[indexer] ${msg}`)
}

/**
 * Remove deleted files from Qdrant
 * @param {string} projectRoot - Project root path
 * @param {string} collectionName - Collection name
 * @param {Set<string>} currentFilesSet - Set of current file paths
 * @param {IndexerSettings} settings - Settings with QDRANT_URL
 * @returns {Promise<number>} Number of deleted files
 */
async function removeDeletedFiles(
  projectRoot: string,
  collectionName: string,
  currentFilesSet: Set<string>,
  settings: IndexerSettings = {}
): Promise<number> {
  const root = projectRoot || process.env.WORKSPACE_DIR || process.cwd()
  const coll = collectionName || process.env.QDRANT_COLLECTION || 'project_index'

  const indexedPaths = await listAllIndexedPaths(coll, settings)
  const toDelete: string[] = []
  for (const p of indexedPaths) {
    if (!currentFilesSet.has(p)) toDelete.push(p)
  }
  if (toDelete.length === 0) return 0
  for (const p of toDelete) {
    const { deletePointsByPath } = await import('./qdrant-client.js')
    await deletePointsByPath(coll, p, settings)
  }
  return toDelete.length
}

/**
 * Run a one-off indexing operation
 * @param {string} projectRoot - Project root path
 * @param {string} collectionName - Collection name
 * @param {object} opts - Options {reset, settings}
 */
async function runOneOffIndex(
  projectRoot: string,
  collectionName: string,
  opts: { reset?: boolean, settings?: IndexerSettings } = {}
): Promise<void> {
  const {reset, settings} = opts
  const root = projectRoot || process.env.WORKSPACE_DIR || process.cwd()
  const coll = collectionName || process.env.QDRANT_COLLECTION || 'project_index'

  await initTreeSitter()
  await ensureCollections(coll, {reset, settings})
  const files = await listProjectFiles(root)
  const set = new Set(files)
  await removeDeletedFiles(root, coll, set, settings)
  for (const f of files) {
    process.stdout.write(`Indexing ${f}... `)
    try {
      const res = await indexFile(root, f, coll, settings)
      process.stdout.write(res.indexed ? `OK (${res.chunks})\n` : `Skipped (${res.reason})\n`)
    } catch (e: any) {
      process.stdout.write(`Failed: ${e.message}\n`)
    }
  }
}

export {
  ensureCollections,
  dropCollections,
  deleteCollectionByName,
  listCollectionsExtended,
  listProjectFiles,
  shouldIndexFile,
  indexFile,
  removeDeletedFiles,
  runOneOffIndex,
  resetConfigCache
}
