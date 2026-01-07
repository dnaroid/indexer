/**
 * File Indexer Module
 * Handles file indexing, embeddings, chunking, and symbol extraction.
 */

import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import {extractJSSymbols} from '../utils/ast-js.js'
import {
  extractCSharpSymbols,
  extractPythonSymbols
} from '../utils/tree-sitter.js'
import {
  upsertPoints,
  deletePointsByPath,
  getExistingFileHash
} from './qdrant-client.js'

let fetch = globalThis.fetch

/**
 * Set custom fetch implementation (useful for testing)
 */
export function setFetch(impl) {
  fetch = impl
}

/**
 * Default file exclusion patterns
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

/**
 * Simple logger
 */
function log(msg) {
  console.log(`[indexer] ${msg}`)
}

/**
 * SHA1 hash function
 */
function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex')
}

/**
 * Convert SHA1 to UUID format
 */
function sha1ToUuid(text) {
  const hex = sha1(text)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/**
 * Generate stable point ID from file path and line range
 */
function stablePointId(filePath, startLine, endLine) {
  return sha1ToUuid(`${filePath}:${startLine}:${endLine}`)
}

/**
 * Flatten symbols into metadata arrays
 */
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

/**
 * Generate embeddings using Ollama
 * @param {string} text - Text to embed
 * @param {string} ollamaUrl - Ollama API URL
 * @param {string} model - Model name
 * @returns {Promise<Array<number>|null>} Embedding vector or null
 */
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

/**
 * Detect programming language from file extension
 * @param {string} filePath - File path
 * @returns {string} Language name
 */
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

/**
 * Chunk text by lines with overlap
 * @param {string} text - Text to chunk
 * @param {number} maxLines - Maximum lines per chunk
 * @param {number} overlap - Overlap lines between chunks
 * @returns {Array<object>} Chunks with start_line, end_line, text
 */
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

/**
 * Index a single file
 * @param {string} projectRootOrRelPath - Project root or relative path (legacy)
 * @param {string} relPath - Relative file path or settings (legacy)
 * @param {string} collectionName - Collection name
 * @param {object} settings - Settings object
 * @returns {Promise<{indexed: boolean, chunks?: number, reason?: string}>}
 */
async function indexFile(projectRootOrRelPath, relPath, collectionName, settings = {}) {
  let root, file, coll, conf
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

export {
  indexFile,
  embed,
  detectLanguage,
  chunkByLines,
  flattenSymbols,
  stablePointId,
  sha1,
  sha1ToUuid
}
