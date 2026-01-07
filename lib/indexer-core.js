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
  extractPythonSymbols,
  initTreeSitter
} from './tree-sitter.js'

/*
  File filters
*/
const DEFAULT_EXCLUDES = [
  '**/.git/**', '**/node_modules/**', '**/dist/**', '**/build/**', '**/.next/**', '**/.cache/**', '**/coverage/**', '**/.idea/**', '**/.vscode/**',
  '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif', '**/*.webp', '**/*.ico', '**/*.svg',
  '**/*.map', '**/*.csv', '**/*.log', '**/*.pdf', '**/*.zip', '**/*.tar', '**/*.gz', '**/*.7z',
  '**/*.bin', '**/*.exe', '**/*.dll', '**/*.dylib', '**/*.so',
  '**/*.mp3', '**/*.wav', '**/*.ogg', '**/*.mp4', '**/*.mov', '**/*.avi',
  '**/*.ttf', '**/*.otf', '**/*.woff', '**/*.woff2',
  '**/*.json', '**/*.yaml', '**/*.yml', '**/*.toml', '**/*.xml',
  '**/*.lock', '**/yarn.lock', '**/package-lock.json', '**/pnpm-lock.yaml',
  '**/*.css', '**/*.scss', '**/*.less', '**/*.html', '**/*.htm'
]

function log(msg) {
  console.log(`[indexer] ${msg}`)
}

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex')
}

function sha1ToUuid(text) {
  const hex = sha1(text)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function stablePointId(filePath, startLine, endLine) {
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
    if (s.name) names.add(s.name)
    if (s.kind) kinds.add(s.kind)
    if (s.kind === 'unity_lifecycle') unityTags.add('lifecycle')
    if (s.kind === 'serialized_field') unityTags.add('serialized_field')
    if (s.kind === 'scriptable_object') unityTags.add('scriptable_object')
  }

  return {
    names: Array.from(names),
    references: Array.from(references),
    kinds: Array.from(kinds),
    unity: Array.from(unityTags)
  }
}

async function embed(text, ollamaUrl, model) {
  const url = ollamaUrl || process.env.OLLAMA_URL || 'http://127.0.0.1:11434'
  const m = model || process.env.EMBED_MODEL || 'unclemusclez/jina-embeddings-v2-base-code'

  const res = await fetch(`${url}/api/embeddings`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({model: m, prompt: text})
  })
  if (!res.ok) {
    const body = await res.text()
    if (body.includes('context length') || body.includes('input length')) return null
    throw new Error(`Ollama embeddings failed: ${res.status} ${body}`)
  }
  const json = await res.json()
  if (!json.embedding || json.embedding.length === 0) return null
  return json.embedding
}

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

// --- Collections ---

async function ensureCollections(collectionName, opts = {}) {
  const {reset, settings} = opts
  const collName = collectionName || process.env.QDRANT_COLLECTION || 'project_index'

  if (reset) {
    await dropCollection(collName, settings)
  }

  const collections = await qdrantRequest('/collections', null, 'GET', settings)
  const names = (collections.result?.collections || []).map((c) => c.name)

  if (!names.includes(collName)) {
    log(`Creating collection: ${collName}`)
    const vectorSize = Number(process.env.VECTOR_SIZE || settings?.VECTOR_SIZE || '768')
    await qdrantRequest(`/collections/${collName}`, {
      vectors: {size: vectorSize, distance: 'Cosine'}
    }, 'PUT', settings)
    await createPayloadIndexes(collName, settings)
  }
}

async function dropCollection(collectionName, settings = {}) {
  await qdrantRequest(`/collections/${collectionName}`, null, 'DELETE', settings).catch(() => {})
}

async function createPayloadIndexes(collectionName, settings = {}) {
  const indexes = [
    {field_name: 'path', field_schema: 'text'}, {field_name: 'lang', field_schema: 'keyword'},
    {field_name: 'file_hash', field_schema: 'keyword'}, {field_name: 'kind', field_schema: 'keyword'},
    {field_name: 'symbol_names', field_schema: 'text'}, {field_name: 'symbol_references', field_schema: 'text'},
    {field_name: 'symbol_kinds', field_schema: 'keyword'}, {field_name: 'unity_tags', field_schema: 'keyword'}
  ]
  for (const idx of indexes) {
    try {
      await qdrantRequest(`/collections/${collectionName}/index`, idx, 'PUT', settings)
    } catch (e) {}
  }
}

async function upsertPoints(collectionName, points, settings = {}) {
  if (points.length === 0) return
  await qdrantRequest(`/collections/${collectionName}/points?wait=true`, {points}, 'PUT', settings)
}

async function deletePointsByPath(collectionName, filePath, settings = {}) {
  await qdrantRequest(`/collections/${collectionName}/points/delete?wait=true`, {
    filter: {
      must: [{key: 'path', match: {value: filePath}}]
    }
  }, 'POST', settings)
}

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

// --- Caches ---
const _toIndexCache = new Map()
const _ignoreCache = new Map()

function resetConfigCache(projectRoot) {
  if (projectRoot) {
    _toIndexCache.delete(projectRoot)
    _ignoreCache.delete(projectRoot)
  } else {
    _toIndexCache.clear()
    _ignoreCache.clear()
  }
}

async function loadIgnorePatterns(projectRoot) {
  const root = projectRoot || process.env.WORKSPACE_DIR || process.cwd()
  if (_ignoreCache.has(root)) return _ignoreCache.get(root)
  const ig = ignore()
  ig.add(DEFAULT_EXCLUDES.map((p) => p.replace('**/', '')))
  try {
    const gi = await fs.readFile(path.join(root, '.gitignore'), 'utf8')
    ig.add(gi.split('\n'))
  } catch {}
  _ignoreCache.set(root, ig)
  return ig
}

function parseToIndexConfig(text) {
  const dirs = []; const exts = []
  const lines = text.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    let kind = ''; let value = ''
    const colonIdx = line.indexOf(':')
    if (colonIdx !== -1) {
      const head = line.slice(0, colonIdx).trim().toLowerCase()
      const tail = line.slice(colonIdx + 1).trim()
      if (head === 'dir' || head === 'ext') { kind = head; value = tail }
    }
    if (!kind) {
      if (line.startsWith('./') || line.startsWith('/')) { kind = 'dir'; value = line }
      else if (line.startsWith('.')) { kind = 'ext'; value = line }
      else { kind = 'dir'; value = line }
    }
    if (kind === 'dir') {
      let dir = value.replace(/\\/g, '/')
      if (dir.startsWith('./')) dir = dir.slice(2)
      dir = dir.replace(/^\/+/, '').replace(/\/+$/, '')
      if (dir) dirs.push(dir)
    } else if (kind === 'ext') {
      let ext = value.toLowerCase()
      if (!ext.startsWith('.')) ext = `.${ext}`
      exts.push(ext)
    }
  }
  return {dirs, exts}
}

async function loadToIndexConfig(projectRoot) {
  const root = projectRoot || process.env.WORKSPACE_DIR || process.cwd()
  if (_toIndexCache.has(root)) return _toIndexCache.get(root)
  try {
    const text = await fs.readFile(path.join(root, '.indexer', 'to-index'), 'utf8')
    const config = parseToIndexConfig(text)
    const res = {enabled: true, ...config}
    _toIndexCache.set(root, res)
    return res
  } catch (e) {
    if (e.code === 'ENOENT') {
      _toIndexCache.set(root, null)
      return null
    }
    throw e
  }
}

function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const map = {
    '.js': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
    '.py': 'python', '.java': 'java', '.kt': 'kotlin',
    '.cs': 'csharp', '.cpp': 'cpp', '.c': 'c', '.h': 'c', '.hpp': 'cpp',
    '.swift': 'swift', '.php': 'php', '.rb': 'ruby', '.lua': 'lua'
  }
  return map[ext] || 'text'
}

function chunkByLines(text, maxLines, overlap) {
  const lines = text.split('\n')
  const chunks = []
  let start = 0
  while (start < lines.length) {
    const end = Math.min(start + maxLines, lines.length)
    const chunkLines = lines.slice(start, end)
    chunks.push({
      start_line: start + 1,
      end_line: end,
      text: chunkLines.join('\n')
    })
    if (end >= lines.length) break
    start = Math.max(end - overlap, start + 1)
  }
  return chunks
}

async function indexFile(projectRootOrRelPath, relPath, collectionName, settings = {}) {
  let root, file, coll, conf;
  if (arguments.length === 1 || (arguments.length === 2 && typeof relPath === 'object')) {
    // Legacy call: indexFile(relPath, [settings])
    root = process.env.WORKSPACE_DIR || process.cwd()
    file = projectRootOrRelPath
    coll = process.env.QDRANT_COLLECTION || 'project_index'
    conf = relPath || {}
  } else {
    root = projectRootOrRelPath
    file = relPath
    coll = collectionName
    conf = settings
  }

  const cfg = {
    OLLAMA_URL: process.env.OLLAMA_URL || conf.OLLAMA_URL || 'http://127.0.0.1:11434',
    EMBED_MODEL: process.env.EMBED_MODEL || conf.EMBED_MODEL || 'unclemusclez/jina-embeddings-v2-base-code',
    MAX_CHUNK_LINES: Number(process.env.MAX_CHUNK_LINES || conf.MAX_CHUNK_LINES || '500'),
    OVERLAP_LINES: Number(process.env.OVERLAP_LINES || conf.OVERLAP_LINES || '50'),
    MAX_FILE_BYTES: Number(process.env.MAX_FILE_BYTES || conf.MAX_FILE_BYTES || String(2 * 1024 * 1024))
  }

  const absPath = path.join(root, file)
  const st = await fs.stat(absPath)
  if (st.size > cfg.MAX_FILE_BYTES) return {indexed: false, reason: 'too_large'}

  const content = await fs.readFile(absPath, 'utf8')
  const fileHash = sha1(content)
  const prevHash = await getExistingFileHash(coll, file, conf)
  if (prevHash === fileHash) return {indexed: false, reason: 'unchanged'}
  if (prevHash) await deletePointsByPath(coll, file, conf)

  const lang = detectLanguage(file)
  let symbols = []
  if (lang === 'javascript' || lang === 'typescript') symbols = extractJSSymbols(content)
  if (lang === 'python') symbols = await extractPythonSymbols(content)
  if (lang === 'csharp') symbols = await extractCSharpSymbols(content)

  const chunks = chunkByLines(content, cfg.MAX_CHUNK_LINES, cfg.OVERLAP_LINES)
  const points = []
  const symbolMeta = flattenSymbols(symbols)

  const queue = [...chunks]
  let processedCount = 0
  while (queue.length > 0) {
    const ch = queue.shift()
    const vector = await embed(ch.text, cfg.OLLAMA_URL, cfg.EMBED_MODEL)
    if (vector) {
      processedCount++
      const id = stablePointId(file, ch.start_line, ch.end_line)
      points.push({
        id, vector,
        payload: {
          path: file, lang, start_line: ch.start_line, end_line: ch.end_line, text: ch.text, file_hash: fileHash,
          symbols, symbol_names: symbolMeta.names, symbol_kinds: symbolMeta.kinds, unity_tags: symbolMeta.unity
        }
      })
    } else {
      const lines = ch.text.split('\n')
      if (lines.length > 15) {
        const splitOverlap = Math.min(cfg.OVERLAP_LINES, Math.floor(lines.length / 4))
        const mid = Math.floor(lines.length / 2)
        const leftEndIdx = Math.min(lines.length, mid + splitOverlap)
        const rightStartIdx = Math.max(0, mid - splitOverlap)
        queue.unshift({ start_line: ch.start_line + rightStartIdx, end_line: ch.end_line, text: lines.slice(rightStartIdx).join('\n') })
        queue.unshift({ start_line: ch.start_line, end_line: ch.start_line + leftEndIdx - 1, text: lines.slice(0, leftEndIdx).join('\n') })
      }
    }
  }
  await upsertPoints(coll, points, conf)
  return {indexed: true, chunks: processedCount}
}

async function removeDeletedFiles(projectRoot, collectionName, currentFilesSet, settings = {}) {
  const root = projectRoot || process.env.WORKSPACE_DIR || process.cwd()
  const coll = collectionName || process.env.QDRANT_COLLECTION || 'project_index'

  const indexedPaths = await listAllIndexedPaths(coll, settings)
  const toDelete = []
  for (const p of indexedPaths) {
    if (!currentFilesSet.has(p)) toDelete.push(p)
  }
  if (toDelete.length === 0) return 0
  for (const p of toDelete) await deletePointsByPath(coll, p, settings)
  return toDelete.length
}

async function shouldIndexFile(projectRoot, relPath) {
  const root = projectRoot || process.env.WORKSPACE_DIR || process.cwd()
  const ig = await loadIgnorePatterns(root)
  const toIndex = await loadToIndexConfig(root)
  const normalized = relPath.replace(/\\/g, '/')
  if (ig.ignores(normalized)) return false
  if (toIndex && toIndex.dirs.length === 0 && toIndex.exts.length === 0) return false
  if (toIndex?.dirs?.length) {
    const dirGlobs = toIndex.dirs.map((dir) => {
      const hasGlob = /[*?\[]/.test(dir)
      if (hasGlob) return dir
      return `${dir.replace(/\/+$/, '')}/**/*`
    })
    if (!fg.isMatch(normalized, dirGlobs, {dot: true})) return false
  }
  const ext = path.extname(normalized).toLowerCase()
  if (toIndex?.exts?.length && !toIndex.exts.includes(ext)) return false
  if (['.lock'].includes(ext)) return false
  return true
}

async function listProjectFiles(projectRoot) {
  const root = projectRoot || process.env.WORKSPACE_DIR || process.cwd()
  const ig = await loadIgnorePatterns(root)
  const toIndex = await loadToIndexConfig(root)
  if (toIndex && toIndex.dirs.length === 0 && toIndex.exts.length === 0) return []
  let globs = ['**/*']
  if (toIndex?.dirs?.length) {
    globs = toIndex.dirs.map((dir) => {
      const hasGlob = /[*?\[]/.test(dir)
      if (hasGlob) return dir
      return `${dir.replace(/\/+$/, '')}/**/*`
    })
  }
  const entries = await fg(globs, {
    cwd: root, dot: true, onlyFiles: true, followSymbolicLinks: false, unique: true, ignore: DEFAULT_EXCLUDES
  })
  const files = []
  for (const p of entries) {
    if (ig.ignores(p)) continue
    const ext = path.extname(p).toLowerCase()
    if (toIndex?.exts?.length && !toIndex.exts.includes(ext)) continue
    if (['.lock'].includes(ext)) continue
    files.push(p)
  }
  return files
}

async function runOneOffIndex(projectRoot, collectionName, opts = {}) {
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
    } catch (e) {
      process.stdout.write(`Failed: ${e.message}\n`)
    }
  }
}

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
  ensureCollections, dropCollection as dropCollections, listCollectionsExtended, dropCollection as deleteCollectionByName,
  listProjectFiles, shouldIndexFile, indexFile, removeDeletedFiles, runOneOffIndex, resetConfigCache
}
