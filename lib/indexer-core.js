import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import fg from 'fast-glob'
import ignore from 'ignore'
import nodeFetch from 'node-fetch'
import {extractJSSymbols} from './ast-js.js'

let fetch = nodeFetch
export function setFetch(impl) {
  fetch = impl
}

import {
  extractCSharpSymbols,
  extractGoSymbols,
  extractPythonSymbols,
  extractRustSymbols,
  initTreeSitter
} from './tree-sitter.js'

/*
  Environment
*/
const getWorkspaceDir = () => process.env.WORKSPACE_DIR || process.cwd()
const getQdrantUrl = () => process.env.QDRANT_URL || 'http://localhost:6333'
const getQdrantCollection = () => process.env.QDRANT_COLLECTION || 'project_index'
const getOllamaUrl = () => process.env.OLLAMA_URL || 'http://127.0.0.1:11434'
const getEmbedModel = () => process.env.EMBED_MODEL || 'unclemusclez/jina-embeddings-v2-base-code'
const getVectorSize = () => Number(process.env.VECTOR_SIZE || '768')

/*
  Chunking defaults (tune as needed)
*/
const getMaxChunkLines = () => Number(process.env.MAX_CHUNK_LINES || '500')
const getOverlapLines = () => Number(process.env.OVERLAP_LINES || '50')
const getMaxFileBytes = () => Number(process.env.MAX_FILE_BYTES || String(2 * 1024 * 1024)) // 2MB

const isResetEnv = () => process.env.RESET === '1' || process.argv.includes('--reset')

/*
  File filters
*/
const DEFAULT_EXCLUDES = [
  '**/.git/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.cache/**',
  '**/coverage/**',
  '**/.idea/**',
  '**/.vscode/**',
  '**/*.png',
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.gif',
  '**/*.webp',
  '**/*.ico',
  '**/*.svg',
  '**/*.map',
  '**/*.csv',
  '**/*.log',
  '**/*.pdf',
  '**/*.zip',
  '**/*.tar',
  '**/*.gz',
  '**/*.7z',
  '**/*.bin',
  '**/*.exe',
  '**/*.dll',
  '**/*.dylib',
  '**/*.so',
  '**/*.tga',
  '**/*.psd',
  '**/*.fbx',
  '**/*.FBX',
  '**/*.obj',
  '**/*.blend',
  '**/*.mp3',
  '**/*.wav',
  '**/*.ogg',
  '**/*.mp4',
  '**/*.mov',
  '**/*.avi',
  '**/*.ttf',
  '**/*.otf',
  '**/*.woff',
  '**/*.woff2',
  '**/*.json',
  '**/*.yaml',
  '**/*.yml',
  '**/*.toml',
  '**/*.xml',
  '**/*.lock',
  '**/yarn.lock',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/*.css',
  '**/*.scss',
  '**/*.less',
  '**/*.html',
  '**/*.htm'
]

/*
  Logging
*/
function log(msg) {
  console.log(`[indexer] ${msg}`)
}

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex')
}

function sha1ToUuid(text) {
  // Qdrant requires UUID format for point IDs
  const hex = sha1(text)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function stablePointId(filePath, startLine, endLine) {
  // Stable ID per (path + line range) to overwrite old points predictably
  return sha1ToUuid(`${filePath}:${startLine}:${endLine}`)
}

function flattenSymbols(symbols) {
  const names = new Set()
  const references = new Set()
  const kinds = new Set()
  const unityTags = new Set()

  for (const s of symbols) {
    if (s.kind === 'reference') {
      if (s.name) references.add(s.name)
      continue
    }

    if (s.name) {
      names.add(s.name)
    }
    if (s.kind) {
      kinds.add(s.kind)
    }
    if (s.kind === 'unity_lifecycle') {
      unityTags.add('lifecycle')
    }
    if (s.kind === 'serialized_field') {
      unityTags.add('serialized_field')
    }
    if (s.kind === 'scriptable_object') {
      unityTags.add('scriptable_object')
    }
  }

  return {
    names: Array.from(names),
    references: Array.from(references),
    kinds: Array.from(kinds),
    unity: Array.from(unityTags)
  }
}

/*
  Ollama embeddings
*/
async function embed(text) {
  const res = await fetch(`${getOllamaUrl()}/api/embeddings`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({model: getEmbedModel(), prompt: text})
  })
  if (!res.ok) {
    const body = await res.text()
    // Check for context length error - return null to skip this chunk
    if (body.includes('context length') || body.includes('input length')) {
      return null
    }
    throw new Error(`Ollama embeddings failed: ${res.status} ${body}`)
  }
  const json = await res.json()
  if (!json.embedding || !Array.isArray(json.embedding)) {
    throw new Error('Ollama embeddings response missing \'embedding\' array')
  }
  if (json.embedding.length === 0) {
    // Empty embedding - skip this chunk
    log(`Warning: got empty embedding, skipping`)
    return null
  }
  if (json.embedding.length !== getVectorSize()) {
    log(`Warning: embedding size ${json.embedding.length} != expected ${getVectorSize()}`)
  }
  return json.embedding
}

/*
  Qdrant helpers
*/
async function qdrantRequest(urlPath, body, method, retries = 3) {
  let attempt = 0
  while (attempt <= retries) {
    try {
      const res = await fetch(`${getQdrantUrl()}${urlPath}`, {
        method: method || (body ? 'POST' : 'GET'),
        headers: body ? {'Content-Type': 'application/json'} : undefined,
        body: body ? JSON.stringify(body) : undefined
      })
      if (!res.ok) {
        // Don't retry on 4xx errors usually, unless 429
        if (res.status >= 500 || res.status === 429) {
          throw new Error(`Server error ${res.status}`)
        }
        const text = await res.text()
        throw new Error(`Qdrant request failed: ${res.status} ${text}`)
      }
      return res.json()
    } catch (e) {
      attempt++
      if (attempt > retries) {
        throw e
      }
      const delay = Math.pow(2, attempt) * 500 // 1s, 2s, 4s
      log(`Qdrant request failed (${e.message}), retrying in ${delay}ms...`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

async function ensureCollections({reset} = {}) {
  const shouldReset = reset === true || isResetEnv()

  if (shouldReset) {
    log('RESET flag detected: dropping collections')
    await dropCollections()
  }

  // Main vector collection
  const collections = await qdrantRequest('/collections')
  const names = (collections.result?.collections || []).map((c) => c.name)

  if (!names.includes(getQdrantCollection())) {
    log(`Creating collection: ${getQdrantCollection()}`)
    await qdrantRequest(`/collections/${getQdrantCollection()}`, {
      vectors: {size: getVectorSize(), distance: 'Cosine'}
    }, 'PUT')
    // Useful payload indexes (optional)
    await createPayloadIndexes(getQdrantCollection())
  }
}

async function dropCollections() {
  await qdrantRequest(`/collections/${getQdrantCollection()}`, null, 'DELETE').catch(() => {})
}

async function createPayloadIndexes(collectionName) {
  // These are best-effort; Qdrant will ignore invalid ones.
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
      await qdrantRequest(`/collections/${collectionName}/index`, idx, 'PUT')
    } catch (e) {
      // Non-fatal; Qdrant version differences can cause errors.
    }
  }
}

async function upsertPoints(points) {
  if (points.length === 0) {
    return
  }
  await qdrantRequest(`/collections/${getQdrantCollection()}/points?wait=true`, {points}, 'PUT')
}

async function deletePointsByPath(filePath) {
  await qdrantRequest(`/collections/${getQdrantCollection()}/points/delete?wait=true`, {
    filter: {
      must: [
        {key: 'path', match: {value: filePath}}
      ]
    }
  })
}

async function getExistingFileHash(filePath) {
  // Search for just 1 point with this path to check hash
  const res = await qdrantRequest(`/collections/${getQdrantCollection()}/points/scroll`, {
    filter: {
      must: [
        {key: 'path', match: {value: filePath}}
      ]
    },
    limit: 1,
    with_payload: true,
    with_vector: false
  })

  const points = res.result?.points || []
  if (points.length > 0) {
    return points[0].payload?.file_hash || null
  }
  return null
}

async function listAllIndexedPaths() {
  // Scroll entire collection to find unique paths.
  // Note: This scans all points. Qdrant doesn't have a distinct/facet API yet.
  // For small-medium projects this is fine.
  let offset = null
  const paths = new Set()

  while (true) {
    const body = {
      limit: 1000,
      with_payload: ['path'],
      with_vector: false
    }
    if (offset) {
      body.offset = offset
    }

    const res = await qdrantRequest(`/collections/${getQdrantCollection()}/points/scroll`, body)
    const pts = res.result?.points || []

    for (const p of pts) {
      if (p.payload?.path) {
        paths.add(p.payload.path)
      }
    }

    offset = res.result?.next_page_offset
    if (!offset) {
      break
    }
  }
  return paths
}

/*
  Cache for config
*/
let _cachedToIndex = null
let _cachedIgnore = null

function resetConfigCache() {
  _cachedToIndex = null
  _cachedIgnore = null
  log('Config cache cleared')
}

/*
  Gitignore-aware file listing
*/
async function loadIgnorePatterns() {
  if (_cachedIgnore) {
    return _cachedIgnore
  }

  const ig = ignore()
  // Always exclude common big dirs/types
  ig.add(DEFAULT_EXCLUDES.map((p) => p.replace('**/', '')))

  // Load repository .gitignore if present
  try {
    const gi = await fs.readFile(path.join(getWorkspaceDir(), '.gitignore'), 'utf8')
    ig.add(gi.split('\n'))
  } catch {
    // No .gitignore is fine.
  }

  _cachedIgnore = ig
  return ig
}

function parseToIndexConfig(text) {
  const dirs = []
  const exts = []

  const lines = text.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    let kind = ''
    let value = ''
    const colonIdx = line.indexOf(':')
    if (colonIdx !== -1) {
      const head = line.slice(0, colonIdx).trim().toLowerCase()
      const tail = line.slice(colonIdx + 1).trim()
      if (head === 'dir' || head === 'ext') {
        kind = head
        value = tail
      }
    }

    if (!kind) {
      if (line.startsWith('./') || line.startsWith('/')) {
        kind = 'dir'
        value = line
      } else if (line.startsWith('.')) {
        kind = 'ext'
        value = line
      } else {
        kind = 'dir'
        value = line
      }
    }

    if (kind === 'dir') {
      let dir = value.replace(/\\/g, '/')
      if (dir.startsWith('./')) {
        dir = dir.slice(2)
      }
      dir = dir.replace(/^\/+/, '').replace(/\/+$/, '')
      if (dir) {
        dirs.push(dir)
      }
    } else if (kind === 'ext') {
      let ext = value.toLowerCase()
      if (!ext.startsWith('.')) {
        ext = `.${ext}`
      }
      exts.push(ext)
    }
  }

  return {dirs, exts}
}

async function loadToIndexConfig() {
  if (_cachedToIndex) {
    return _cachedToIndex
  }

  try {
    const text = await fs.readFile(path.join(getWorkspaceDir(), '.indexer', 'to-index'), 'utf8')
    const config = parseToIndexConfig(text)
    const summary = `dirs: ${config.dirs.length}, exts: ${config.exts.length}`
    log(`Loaded whitelist .indexer/to-index (${summary})`)
    _cachedToIndex = {enabled: true, ...config}
    return _cachedToIndex
  } catch (e) {
    if (e.code === 'ENOENT') {
      _cachedToIndex = null
      return null
    }
    throw e
  }
}

function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const map = {
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.kt': 'kotlin',
    '.cs': 'csharp',
    '.cpp': 'cpp',
    '.c': 'c',
    '.h': 'c',
    '.hpp': 'cpp',
    '.swift': 'swift',
    '.php': 'php',
    '.rb': 'ruby',
    '.lua': 'lua',
    '.md': 'markdown',
    '.sh': 'shell',
    '.zsh': 'shell'
  }
  return map[ext] || 'text'
}

/*
  Chunking by lines with overlap
*/
function chunkByLines(text) {
  const lines = text.split('\n')
  const chunks = []

  let start = 0
  while (start < lines.length) {
    const end = Math.min(start + getMaxChunkLines(), lines.length)
    const chunkLines = lines.slice(start, end)
    const chunkText = chunkLines.join('\n')

    chunks.push({
      start_line: start + 1,
      end_line: end,
      text: chunkText
    })

    if (end >= lines.length) {
      break
    }
    start = Math.max(end - getOverlapLines(), start + 1)
  }

  return chunks
}

/*
  Index a single file (read + chunk + embed + upsert)
*/
async function indexFile(relPath) {
  const absPath = path.join(getWorkspaceDir(), relPath)
  const st = await fs.stat(absPath)
  if (st.size > getMaxFileBytes()) {
    log(`Skipping large file (${Math.round(st.size / 1024)} KB): ${relPath}`)
    return {indexed: false, reason: 'too_large'}
  }

  const content = await fs.readFile(absPath, 'utf8')
  const fileHash = sha1(content)

  // Check if unchanged
  const prevHash = await getExistingFileHash(relPath)
  if (prevHash === fileHash) {
    return {indexed: false, reason: 'unchanged'}
  }

  // If changed, remove old points first
  if (prevHash) {
    await deletePointsByPath(relPath)
  }

  const lang = detectLanguage(relPath)

  let symbols = []
  if (lang === 'javascript' || lang === 'typescript') {
    symbols = extractJSSymbols(content)
  }
  if (lang === 'python') {
    symbols = extractPythonSymbols(content)
  }
  if (lang === 'go') {
    symbols = extractGoSymbols(content)
  }
  if (lang === 'rust') {
    symbols = extractRustSymbols(content)
  }
  if (lang === 'csharp') {
    symbols = extractCSharpSymbols(content)
  }

  const chunks = chunkByLines(content)
  const points = []
  const symbolMeta = flattenSymbols(symbols)

  // Dynamic chunk processing queue
  // If a chunk is too large, we split it and add parts back to the queue
  const queue = [...chunks]
  let processedCount = 0

  while (queue.length > 0) {
    const ch = queue.shift()
    const vector = await embed(ch.text)

    if (vector) {
      // Success
      processedCount++
      const id = stablePointId(relPath, ch.start_line, ch.end_line)
      points.push({
        id,
        vector,
        payload: {
          path: relPath,
          lang,
          start_line: ch.start_line,
          end_line: ch.end_line,
          text: ch.text,
          file_hash: fileHash,
          symbols,
          symbol_names: symbolMeta.names,
          symbol_kinds: symbolMeta.kinds,
          unity_tags: symbolMeta.unity
        }
      })
    } else {
      // Failed (too large?). Try splitting.
      const lines = ch.text.split('\n')
      // Minimum chunk size to stop recursion (e.g. 15 lines)
      if (lines.length > 15) {
        log(`Chunk too large (${lines.length} lines), splitting: ${relPath}:${ch.start_line}`)
        
        // Add overlap to preserve semantic context at the split boundary
        // BUT cap it at 25% of the total length to prevent infinite loops (where split parts == original)
        const configOverlap = getOverlapLines()
        const maxOverlap = Math.floor(lines.length / 4)
        const splitOverlap = Math.min(configOverlap, maxOverlap)
        
        const mid = Math.floor(lines.length / 2)
        
        // Left part: 0 to mid + splitOverlap
        const leftEndIdx = Math.min(lines.length, mid + splitOverlap)
        const leftLines = lines.slice(0, leftEndIdx)
        
        // Right part: mid - splitOverlap to end
        const rightStartIdx = Math.max(0, mid - splitOverlap)
        const rightLines = lines.slice(rightStartIdx)

        const leftChunk = {
          start_line: ch.start_line,
          end_line: ch.start_line + leftEndIdx - 1,
          text: leftLines.join('\n')
        }
        
        const rightChunk = {
          start_line: ch.start_line + rightStartIdx,
          end_line: ch.end_line,
          text: rightLines.join('\n')
        }

        // Add to front of queue to process immediately
        queue.unshift(rightChunk)
        queue.unshift(leftChunk)
      } else {
        log(`Skipping chunk (failed & too small to split): ${relPath}:${ch.start_line}-${ch.end_line}`)
      }
    }
  }

  await upsertPoints(points)
  return {indexed: true, chunks: processedCount}
}

/*
  Remove meta + points for deleted files
*/
async function removeDeletedFiles(currentFilesSet) {
  const indexedPaths = await listAllIndexedPaths()
  const toDelete = []

  for (const p of indexedPaths) {
    if (!currentFilesSet.has(p)) {
      toDelete.push(p)
    }
  }

  if (toDelete.length === 0) {
    return 0
  }

  log(`Removing deleted files: ${toDelete.length}`)
  for (const p of toDelete) {
    await deletePointsByPath(p)
  }

  return toDelete.length
}

async function shouldIndexFile(relPath) {
  const ig = await loadIgnorePatterns()
  const toIndex = await loadToIndexConfig()
  const normalized = relPath.replace(/\\/g, '/')

  if (ig.ignores(normalized)) {
    return false
  }

  if (toIndex && toIndex.dirs.length === 0 && toIndex.exts.length === 0) {
    return false
  }

  if (toIndex?.dirs?.length) {
    const dirGlobs = toIndex.dirs.map((dir) => {
      const hasGlob = /[*?\[]/.test(dir)
      if (hasGlob) {
        return dir
      }
      return `${dir.replace(/\/+$/, '')}/**/*`
    })
    if (!fg.isMatch(normalized, dirGlobs, {dot: true})) {
      return false
    }
  }

  const ext = path.extname(normalized).toLowerCase()
  if (toIndex?.exts?.length && !toIndex.exts.includes(ext)) {
    return false
  }
  if (['.lock'].includes(ext)) {
    return false
  }

  return true
}

async function listProjectFiles() {
  const ig = await loadIgnorePatterns()
  const toIndex = await loadToIndexConfig()

  if (toIndex && toIndex.dirs.length === 0 && toIndex.exts.length === 0) {
    log('Whitelist .indexer/to-index is empty; nothing to index')
    return []
  }

  let globs = ['**/*']
  if (toIndex?.dirs?.length) {
    globs = toIndex.dirs.map((dir) => {
      const hasGlob = /[*?\[]/.test(dir)
      if (hasGlob) {
        return dir
      }
      return `${dir.replace(/\/+$/, '')}/**/*`
    })
  }

  // Get all files; fast-glob returns posix-style paths by default.
  const entries = await fg(globs, {
    cwd: getWorkspaceDir(),
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    unique: true,
    ignore: DEFAULT_EXCLUDES
  })

  const files = []
  for (const p of entries) {
    // Apply .gitignore patterns
    if (ig.ignores(p)) {
      continue
    }

    // Skip obviously binary-ish extensions quickly (extra safeguard)
    const ext = path.extname(p).toLowerCase()
    if (toIndex?.exts?.length && !toIndex.exts.includes(ext)) {
      continue
    }
    if (['.lock'].includes(ext)) {
      continue
    }

    files.push(p)
  }

  return files
}

async function runOneOffIndex({reset} = {}) {
  log(`Starting one-off index (reset=${!!reset})`)

  await initTreeSitter()
  await ensureCollections({reset})

  const files = await listProjectFiles()
  const set = new Set(files)

  await removeDeletedFiles(set)

  for (const f of files) {
    process.stdout.write(`Indexing ${f}... `)
    try {
      const res = await indexFile(f)
      if (res.indexed) {
        process.stdout.write(`OK (${res.chunks} chunks)\n`)
      } else {
        process.stdout.write(`Skipped (${res.reason})\n`)
      }
    } catch (e) {
      process.stdout.write(`Failed: ${e.message}\n`)
    }
  }

  log(`Indexing complete.`)
}

async function listCollectionsExtended() {
  const data = await qdrantRequest('/collections')
  const collections = data.result?.collections || []

  const results = []
  for (const c of collections) {
    let count = 0
    try {
      const res = await qdrantRequest(`/collections/${c.name}/points/count`, {exact: true}, 'POST')
      count = res.result?.count || 0
    } catch (_) {}
    results.push({name: c.name, count})
  }
  return results
}

async function deleteCollectionByName(name) {
  await qdrantRequest(`/collections/${name}`, null, 'DELETE')
}

export {
  ensureCollections,
  dropCollections,
  listCollectionsExtended,
  deleteCollectionByName,
  listProjectFiles,
  shouldIndexFile,
  indexFile,
  removeDeletedFiles,
  runOneOffIndex,
  resetConfigCache
}
