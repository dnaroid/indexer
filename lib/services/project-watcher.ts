import chokidar from 'chokidar'
import { log } from '../cli/cli-ui.js'
import {
  ensureCollections,
  indexFile,
  listProjectFiles,
  removeDeletedFiles,
  resetConfigCache,
  deleteCollectionByName
} from '../core/indexer-core.js'
import { getProjectConfig } from '../utils/config-global.js'
import {
  loadSnapshot,
  saveSnapshot,
  createSnapshot,
  compareSnapshots,
  getFilesToIndex,
  deleteSnapshot
} from '../utils/snapshot-manager.js'
import { updateActivity } from './inactivity-manager.js'
import { deleteFileFromGraph } from '../utils/dependency-graph-db.js'
import type { IndexerSettings } from '../types/index.js'

// Always ignore these patterns for project-level watcher
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

// Project-level debounce configuration
const PROJECT_DEBOUNCE_MS = Number(process.env.PROJECT_DEBOUNCE_MS) || 2000 // 2 seconds default

// State
const watchers = new Map() // path -> chokidar instance
const projectDebouncers = new Map() // projectPath -> timeout
const projectStates = new Map() // projectPath -> { dirty: boolean, lastSyncTime: number }

/**
 * Mark a project as dirty and schedule sync
 * @param {string} projectPath - Project path
 */
export function markProjectDirty(projectPath: string): void {
  const state = projectStates.get(projectPath) || { dirty: false }
  state.dirty = true
  projectStates.set(projectPath, state)
  scheduleProjectSync(projectPath)
}

/**
 * Mark a project as clean
 * @param {string} projectPath - Project path
 */
export function markProjectClean(projectPath: string): void {
  const state = projectStates.get(projectPath) || {}
  state.dirty = false
  state.lastSyncTime = Date.now()
  projectStates.set(projectPath, state)
}

/**
 * Schedule project sync with debounce
 * @param {string} projectPath - Project path
 */
function scheduleProjectSync(projectPath: string): void {
  const key = `project:${projectPath}`

  if (projectDebouncers.has(key)) {
    clearTimeout(projectDebouncers.get(key))
  }

  const timer = setTimeout(async () => {
    projectDebouncers.delete(key)
    await syncProjectWithDiff(projectPath)
  }, PROJECT_DEBOUNCE_MS)

  projectDebouncers.set(key, timer)
}

/**
 * Register a new project for watching
 * @param {string} projectPath - Project root path
 * @returns {Promise<void>}
 */
export async function registerProject(projectPath: string): Promise<void> {
  const absPath = projectPath
  if (watchers.has(absPath)) {
    log(`Project already watched: ${absPath}`)
    return
  }

  log(`Registering project: ${absPath}`)
  const projectConf = await getProjectConfig(absPath)

  // Initial sync with snapshot
  await syncProjectWithDiff(absPath, true)

  // Start project-level watcher (skip in test mode to avoid keeping event loop open)
  if (process.env.NODE_ENV !== 'test') {
    startProjectWatcher(absPath)
  } else {
    log(`Skipping file watcher in test mode for ${absPath}`)
  }
}

/**
 * Unregister a project
 * @param {string} projectPath - Project root path
 * @returns {Promise<void>}
 */
export async function unregisterProject(projectPath) {
  const absPath = projectPath
  const watcher = watchers.get(absPath)

  // Get project config before deletion
  const projectConf = await getProjectConfig(absPath)

  if (watcher) {
    await watcher.close()
    watchers.delete(absPath)
    log(`Unregistered project: ${absPath}`)
  }

  // Delete snapshot
  try {
    await deleteSnapshot(absPath)
    log(`Deleted snapshot for ${absPath}`)
  } catch (e: any) {
    log(`Failed to delete snapshot: ${e.message}`)
  }

  // Delete collection from Qdrant
  if (projectConf) {
    try {
      await deleteCollectionByName(projectConf.collectionName)
      log(`Deleted collection: ${projectConf.collectionName}`)
    } catch (e: any) {
      log(`Failed to delete collection: ${e.message}`)
    }
  }

  // Clear project state
  projectStates.delete(absPath)

  // Clear project debounce timer
  const key = `project:${absPath}`
  if (projectDebouncers.has(key)) {
    clearTimeout(projectDebouncers.get(key))
    projectDebouncers.delete(key)
  }
}

/**
 * Sync project using diff-based approach
 * @param {string} projectPath - Project root path
 * @param {boolean} forceFullSync - Force full sync regardless of dirty state
 * @returns {Promise<void>}
 */
async function syncProjectWithDiff(projectPath, forceFullSync = false) {
  const projectConf = await getProjectConfig(projectPath)
  if (!projectConf) {
    log(`No config found for project: ${projectPath}`)
    return
  }

  const state = projectStates.get(projectPath) || { dirty: false }

  if (!forceFullSync && !state.dirty) {
    return
  }

  log(`Syncing ${projectPath} -> ${projectConf.collectionName}`)

  try {
    const startTime = Date.now()
    await ensureCollections(projectConf.collectionName)

    // Get files to index using snapshot diff
    const { filesToIndex, filesToRemove, isNew, diff } = await getFilesToIndex(projectPath)

    // Remove deleted files from Qdrant
    if (filesToRemove.length > 0) {
      for (const filePath of filesToRemove) {
        await deletePointsByPath(projectConf.collectionName, filePath, projectConf.settings)
        // Also remove from dependency graph
        try {
          await deleteFileFromGraph(projectConf.collectionName, filePath)
        } catch (error) {
          console.error(`Failed to remove ${filePath} from dependency graph:`, error)
        }
      }
      log(`Removed ${filesToRemove.length} deleted files from index`)
    }

    // Index new and modified files
    let indexedCount = 0
    for (const filePath of filesToIndex) {
      const res = await indexFile(projectPath, filePath, projectConf.collectionName, projectConf.settings)
      if (res.indexed) indexedCount++
    }

    const duration = Date.now() - startTime

    if (isNew) {
      log(`Initial sync complete. Indexed ${indexedCount} files in ${duration}ms`)
    } else if (diff) {
      log(`Diff sync complete. +${diff.total.added} ~${diff.total.modified} -${diff.total.removed} files in ${duration}ms`)
    } else {
      log(`Sync complete. Indexed ${indexedCount} files in ${duration}ms`)
    }

    markProjectClean(projectPath)
  } catch (e: any) {
    log(`Sync failed for ${projectPath}: ${e.message}`)
    // Don't mark as clean, will retry on next event
  }
}

/**
 * Start project-level watcher (depth: 0)
 * @param {string} projectPath - Project root path
 */
function startProjectWatcher(projectPath) {
  const watcher = chokidar.watch(projectPath, {
    depth: 0, // Only watch project root
    ignored: ALWAYS_IGNORED,
    ignoreInitial: true,
    persistent: true
  })

  watcher.on('all', () => {
    updateActivity()
    markProjectDirty(projectPath)
  })

  watchers.set(projectPath, watcher)
  log(`Project-level watcher started for ${projectPath}`)
}

/**
 * Handle config file changes (.gitignore, .indexer/to-index)
 * @param {string} projectPath - Project root path
 * @param {string} relPath - Relative path to changed file
 * @returns {Promise<void>}
 */
export async function handleConfigFileChange(projectPath, relPath) {
  if (relPath === '.gitignore' || relPath === '.indexer/to-index') {
    log(`Config file changed: ${relPath}`)
    resetConfigCache(projectPath)
    // Force full sync to rebuild snapshot with new rules
    await syncProjectWithDiff(projectPath, true)
  }
}

/**
 * Delete points by path from Qdrant collection
 * @param {string} collectionName - Collection name
 * @param {string} filePath - File path
 * @param {object} settings - Project settings
 * @returns {Promise<void>}
 */
async function deletePointsByPath(collectionName, filePath, settings: IndexerSettings = {}) {
  const qdrantUrl = settings?.QDRANT_URL || process.env.QDRANT_URL || 'http://localhost:6333'

  try {
    await fetch(`${qdrantUrl}/collections/${collectionName}/points/delete?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filter: {
          must: [{ key: 'path', match: { value: filePath } }]
        }
      })
    })
  } catch (e: any) {
    log(`Failed to delete points for ${filePath}: ${e.message}`)
  }
}

/**
 * Get project state
 * @param {string} projectPath - Project path
 * @returns {object} Project state
 */
export function getProjectState(projectPath) {
  return projectStates.get(projectPath) || { dirty: false }
}

/**
 * Get all watched projects
 * @returns {Array<string>} List of project paths
 */
export function getWatchedProjects() {
  return Array.from(watchers.keys()).filter(k => k !== 'config')
}

/**
 * Close all watchers
 * @returns {Promise<void>}
 */
export async function closeAllWatchers() {
  for (const [path, watcher] of watchers) {
    await watcher.close()
  }
  watchers.clear()
  log('All watchers closed')
}

/**
 * Clear all debounce timers
 * @returns {void}
 */
export function clearAllDebouncers() {
  for (const timer of projectDebouncers.values()) {
    clearTimeout(timer)
  }
  projectDebouncers.clear()
  log('All debounce timers cleared')
}

/**
 * Clear all project states
 * @returns {void}
 */
export function clearAllProjectStates() {
  projectStates.clear()
  log('All project states cleared')
}
