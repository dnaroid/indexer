/**
 * Qdrant Client Module
 * Handles all Qdrant database operations including collections, points, and queries.
 */

let fetch = globalThis.fetch

/**
 * Set custom fetch implementation (useful for testing)
 */
export function setFetch(impl) {
  fetch = impl
}

/**
 * Make a request to Qdrant API with retry logic
 * @param {string} urlPath - URL path (e.g., '/collections')
 * @param {object} body - Request body
 * @param {string} method - HTTP method
 * @param {object} settings - Settings with QDRANT_URL
 * @returns {Promise<object>} Response JSON
 */
async function qdrantRequest(urlPath, body, method, settings = {}) {
  const qdrantUrl = settings?.QDRANT_URL || process.env.QDRANT_URL || 'http://localhost:6333'
  let attempt = 0
  while (attempt <= 3) {
    try {
      const res = await fetch(`${qdrantUrl}${urlPath}`, {
        method: method || (body ? 'POST' : 'GET'),
        headers: body ? {'Content-Type': 'application/json'} : undefined,
        body: body ? JSON.stringify(body) : undefined
      })
      if (!res.ok) {
        if (res.status >= 500 || res.status === 429) throw new Error(`Server error ${res.status}`)
        const text = await res.text()
        throw new Error(`Qdrant request failed: ${res.status} ${text}`)
      }
      return res.json()
    } catch (e) {
      attempt++
      if (attempt > 3) throw e
      const delay = Math.pow(2, attempt) * 500
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

/**
 * Ensure a collection exists, create it if necessary
 * @param {string} collectionName - Collection name
 * @param {object} opts - Options {reset, settings}
 */
async function ensureCollections(collectionName, opts = {}) {
  const {reset, settings} = opts
  const collName = collectionName || process.env.QDRANT_COLLECTION || 'project_index'

  if (reset) {
    await dropCollection(collName, settings)
  }

  const collections = await qdrantRequest('/collections', null, 'GET', settings)
  const names = (collections.result?.collections || []).map((c) => c.name)

  if (!names.includes(collName)) {
    const vectorSize = Number(process.env.VECTOR_SIZE || settings?.VECTOR_SIZE || '768')
    await qdrantRequest(`/collections/${collName}`, {
      vectors: {size: vectorSize, distance: 'Cosine'}
    }, 'PUT', settings)
    await createPayloadIndexes(collName, settings)
  }
}

/**
 * Drop a collection
 * @param {string} collectionName - Collection name
 * @param {object} settings - Settings with QDRANT_URL
 */
async function dropCollection(collectionName, settings = {}) {
  await qdrantRequest(`/collections/${collectionName}`, null, 'DELETE', settings).catch(() => {})
}

/**
 * Create payload indexes for a collection
 * @param {string} collectionName - Collection name
 * @param {object} settings - Settings with QDRANT_URL
 */
async function createPayloadIndexes(collectionName, settings = {}) {
  const indexes = [
    {field_name: 'path', field_schema: 'text'},
    {field_name: 'lang', field_schema: 'keyword'},
    {field_name: 'file_hash', field_schema: 'keyword'},
    {field_name: 'kind', field_schema: 'keyword'},
    {field_name: 'symbol_names', field_schema: 'text'},
    {field_name: 'symbol_references', field_schema: 'text'},
    {field_name: 'symbol_kinds', field_schema: 'keyword'},
    {field_name: 'unity_tags', field_schema: 'keyword'}
  ]
  for (const idx of indexes) {
    try {
      await qdrantRequest(`/collections/${collectionName}/index`, idx, 'PUT', settings)
    } catch (e) {}
  }
}

/**
 * Upsert points to a collection
 * @param {string} collectionName - Collection name
 * @param {Array<object>} points - Points to upsert
 * @param {object} settings - Settings with QDRANT_URL
 */
async function upsertPoints(collectionName, points, settings = {}) {
  if (points.length === 0) return
  await qdrantRequest(`/collections/${collectionName}/points?wait=true`, {points}, 'PUT', settings)
}

/**
 * Delete points by file path
 * @param {string} collectionName - Collection name
 * @param {string} filePath - File path
 * @param {object} settings - Settings with QDRANT_URL
 */
async function deletePointsByPath(collectionName, filePath, settings = {}) {
  await qdrantRequest(`/collections/${collectionName}/points/delete?wait=true`, {
    filter: {
      must: [{key: 'path', match: {value: filePath}}]
    }
  }, 'POST', settings)
}

/**
 * Get existing file hash from Qdrant
 * @param {string} collectionName - Collection name
 * @param {string} filePath - File path
 * @param {object} settings - Settings with QDRANT_URL
 * @returns {Promise<string|null>} File hash or null
 */
async function getExistingFileHash(collectionName, filePath, settings = {}) {
  const res = await qdrantRequest(`/collections/${collectionName}/points/scroll`, {
    filter: {
      must: [{key: 'path', match: {value: filePath}}]
    },
    limit: 1,
    with_payload: true,
    with_vector: false
  }, 'POST', settings)
  const points = res.result?.points || []
  return points.length > 0 ? points[0].payload?.file_hash : null
}

/**
 * List all indexed file paths in a collection
 * @param {string} collectionName - Collection name
 * @param {object} settings - Settings with QDRANT_URL
 * @returns {Promise<Set<string>>} Set of file paths
 */
async function listAllIndexedPaths(collectionName, settings = {}) {
  let offset = null
  const paths = new Set()
  while (true) {
    const body = { limit: 1000, with_payload: ['path'], with_vector: false }
    if (offset) body.offset = offset
    const res = await qdrantRequest(`/collections/${collectionName}/points/scroll`, body, 'POST', settings)
    const pts = res.result?.points || []
    for (const p of pts) {
      if (p.payload?.path) paths.add(p.payload.path)
    }
    offset = res.result?.next_page_offset
    if (!offset) break
  }
  return paths
}

/**
 * List all collections with their point counts
 * @param {object} settings - Settings with QDRANT_URL
 * @returns {Promise<Array<{name: string, count: number}>>} Collections with counts
 */
async function listCollectionsExtended(settings = {}) {
  const data = await qdrantRequest('/collections', null, 'GET', settings)
  const collections = data.result?.collections || []
  const results = []
  for (const c of collections) {
    let count = 0
    try {
      const res = await qdrantRequest(`/collections/${c.name}/points/count`, {exact: true}, 'POST', settings)
      count = res.result?.count || 0
    } catch (_) {}
    results.push({name: c.name, count})
  }
  return results
}

export {
  qdrantRequest,
  ensureCollections,
  dropCollection,
  createPayloadIndexes,
  upsertPoints,
  deletePointsByPath,
  getExistingFileHash,
  listAllIndexedPaths,
  listCollectionsExtended,
  dropCollection as deleteCollectionByName
}
