import chokidar from 'chokidar'
import path from 'path'
import {
  ensureCollections,
  indexFile,
  listProjectFiles,
  removeDeletedFiles,
  shouldIndexFile,
  resetConfigCache
} from './indexer-core.js'
import {initTreeSitter} from './tree-sitter.js'

const getWorkspaceDir = () => process.env.WORKSPACE_DIR || process.cwd()

/*
  Simple debounce queue per file
*/
const pending = new Map()
const DEBOUNCE_MS = 500

function schedule(filePath, action) {
  if (pending.has(filePath)) {
    clearTimeout(pending.get(filePath).t)
  }

  pending.set(
    filePath,
    {
      action,
      t: setTimeout(async () => {
        pending.delete(filePath)
        try {
          if (action === 'index') {
            await indexFile(filePath)
            console.log(`[daemon] Indexed: ${filePath}`)
          }
        } catch (e) {
          console.error(`[daemon] Failed ${filePath}: ${e.message}`)
        }
      }, DEBOUNCE_MS)
    }
  )
}

function normalizeRel(p) {
  return p.split(path.sep).join('/')
}

const TO_INDEX_FILES = new Set([
  normalizeRel(path.join('.indexer', 'to-index'))
])

let isReindexing = false
let reindexQueued = false

async function runFullIndex(reason = 'initial') {
  console.log(`[daemon] Reindexing (${reason})...`)
  await ensureCollections()

  const files = await listProjectFiles()
  const set = new Set(files)

  await removeDeletedFiles(set)

  for (const f of files) {
    await indexFile(f)
  }

  console.log(`[daemon] Reindexing done (${files.length} files, reason: ${reason})`)
}

async function triggerReindex(reason) {
  if (isReindexing) {
    reindexQueued = true
    console.log(`[daemon] Reindex already running, queued (${reason})`)
    return
  }

  isReindexing = true
  try {
    await runFullIndex(reason)
  } catch (e) {
    console.error(`[daemon] Reindex failed: ${e.message}`)
  } finally {
    isReindexing = false
    if (reindexQueued) {
      reindexQueued = false
      await triggerReindex('queued change')
    }
  }
}

function isToIndex(relPath) {
  const normalized = normalizeRel(relPath)
  return TO_INDEX_FILES.has(normalized)
}

async function startDaemon() {
  console.log(`[daemon] Starting in: ${getWorkspaceDir()}`)
  await initTreeSitter()
  await runFullIndex('initial startup')

  const watcher = chokidar.watch(getWorkspaceDir(), {
    ignored: [
      '**/.git/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**'
    ],
    persistent: true,
    ignoreInitial: true
  })

  watcher
    .on('add', async (p) => {
      const rel = path.relative(getWorkspaceDir(), p)
      if (rel === '.gitignore') {
        resetConfigCache()
        await triggerReindex('gitignore added')
        return
      }
      if (isToIndex(rel)) {
        resetConfigCache()
        await triggerReindex('to-index added')
        return
      }
      if (!(await shouldIndexFile(rel))) {
        return
      }
      schedule(rel, 'index')
    })
    .on('change', async (p) => {
      const rel = path.relative(getWorkspaceDir(), p)
      if (rel === '.gitignore') {
        resetConfigCache()
        await triggerReindex('gitignore updated')
        return
      }
      if (isToIndex(rel)) {
        resetConfigCache()
        await triggerReindex('to-index updated')
        return
      }
      if (!(await shouldIndexFile(rel))) {
        return
      }
      schedule(rel, 'index')
    })
    .on('unlink', async (p) => {
      const rel = path.relative(getWorkspaceDir(), p)
      if (rel === '.gitignore') {
        resetConfigCache()
        await triggerReindex('gitignore removed')
        return
      }
      if (isToIndex(rel)) {
        resetConfigCache()
        await triggerReindex('to-index removed')
        return
      }
      console.log(`[daemon] File removed: ${rel}`)
      // Cleanup handled lazily via removeDeletedFiles
      await removeDeletedFiles(new Set(await listProjectFiles()))
    })

  console.log('[daemon] Watching for changes...')

  // Watchdog: Exit if parent process dies
  const ppid = process.ppid
  setInterval(() => {
    try {
      process.kill(ppid, 0)
    } catch (e) {
      console.error(`[daemon] Parent process ${ppid} died. Exiting...`)
      process.exit(0)
    }
  }, 5000).unref()
}

startDaemon().catch((e) => {
  console.error(`[daemon] Fatal: ${e.message}`)
  process.exit(1)
})
