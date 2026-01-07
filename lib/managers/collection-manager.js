import { createInterface } from 'readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { confirmAction, fail, log } from '../cli/cli-ui.js'
import { deleteCollectionByName, dropCollections, listCollectionsExtended } from '../core/indexer-core.js'

/**
 * Check if Qdrant is up and running
 * @param {string} url - Qdrant URL
 * @returns {Promise<boolean>} True if Qdrant is accessible
 */
export async function isQdrantUp(url) {
  try {
    const res = await fetch(url)
    return res.ok
  } catch (_) {
    return false
  }
}

/**
 * Check if Ollama is up and running
 * @param {string} url - Ollama URL
 * @returns {Promise<boolean>} True if Ollama is accessible
 */
export async function isOllamaUp(url) {
  try {
    const res = await fetch(`${url}/api/tags`)
    return res.ok
  } catch (_) {
    return false
  }
}

/**
 * Count indexed points in a collection
 * @param {string} collectionName - Collection name
 * @returns {Promise<number|null>} Number of points or null if error
 */
export async function countIndexed(collectionName) {
  const url = process.env.QDRANT_URL || 'http://localhost:6333'
  if (!collectionName) {
    return null
  }
  try {
    const res = await fetch(`${url}/collections/${collectionName}/points/count`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exact: true })
    })
    if (!res.ok) {
      return null
    }
    const json = await res.json()
    return json.result?.count ?? null
  } catch (e) {
    return null
  }
}

/**
 * Ensure Qdrant connection is available
 * @throws {Error} If Qdrant is not running
 */
export async function ensureQdrantConnection() {
  const url = process.env.QDRANT_URL || 'http://localhost:6333'
  if (!(await isQdrantUp(url))) {
    fail(`Cannot connect to Qdrant at ${url}. Is it running?`)
  }
}

/**
 * List all collections in Qdrant
 * @param {boolean} silent - If true, suppress output
 * @returns {Promise<Array<{name: string, count: number}>>} List of collections
 */
export async function handleListCollections(silent = false) {
  await ensureQdrantConnection()
  if (!silent) {
    log('Fetching collections...')
  }
  try {
    const list = await listCollectionsExtended()
    if (list.length === 0) {
      if (!silent) {
        console.log('No collections found.')
      }
      return []
    }
    if (!silent) {
      console.log('\nFound collections:')
      list.forEach((c, i) => {
        console.log(`  \x1b[36m[${i + 1}]\x1b[0m ${c.name} \x1b[90m(${c.count} points)\x1b[0m`)
      })
      console.log('')
    }
    return list
  } catch (e) {
    if (silent) {
      throw e
    }
    fail(`Failed to list collections: ${e.message}`)
  }
}

/**
 * Delete a collection by name or interactively
 * @param {string} name - Collection name (optional for interactive mode)
 * @returns {Promise<void>}
 */
export async function handleDeleteCollection(name) {
  await ensureQdrantConnection()

  if (!name) {
    const list = await handleListCollections(true)
    if (list.length === 0) {
      console.log('No collections to delete.')
      return
    }

    console.log('\nSelect collections to delete:')
    list.forEach((c, i) => {
      console.log(`  \x1b[36m[${i + 1}]\x1b[0m ${c.name} \x1b[90m(${c.count} points)\x1b[0m`)
    })
    console.log('')

    const rl = createInterface({ input, output })
    const answer = await rl.question('Enter numbers to delete (e.g. "1 3" or "all"), or empty to cancel: ')
    rl.close()

    const trimmed = answer.trim().toLowerCase()
    if (!trimmed) {
      return
    }

    let toDelete = []
    if (trimmed === 'all') {
      toDelete = list
    } else {
      const parts = trimmed.split(/[\s,]+/)
      const indices = parts.map(p => parseInt(p, 10)).filter(n => !isNaN(n) && n >= 1 && n <= list.length)
      const unique = [...new Set(indices)]
      toDelete = unique.map(i => list[i - 1])
    }

    if (toDelete.length === 0) {
      return
    }

    if (await confirmAction('\nAre you sure?')) {
      for (const c of toDelete) {
        await deleteCollectionByName(c.name)
        console.log(`Deleted ${c.name}`)
      }
    }
    return
  }

  if (await confirmAction(`Delete collection "${name}"?`)) {
    try {
      await deleteCollectionByName(name)
      log(`Collection "${name}" deleted.`)
    } catch (e) {
      fail(`Failed to delete: ${e.message}`)
    }
  }
}

/**
 * Delete all collections
 * @returns {Promise<void>}
 */
export async function handlePruneAll() {
  await ensureQdrantConnection()
  const list = await handleListCollections(true)
  if (list.length === 0) {
    log('No collections to prune.')
    return
  }
  if (await confirmAction('Delete ALL collections?')) {
    for (const c of list) {
      await deleteCollectionByName(c.name)
    }
    log('Pruned.')
  }
}
