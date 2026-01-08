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
import type {
  FileProcessResult,
  IndexerSettings,
  SymbolInfo,
  CustomFetch,
  TextChunk,
  SymbolMetadata,
  QdrantPoint,
} from '../types/index.js'

let fetch: CustomFetch = globalThis.fetch

/**
 * Set custom fetch implementation (useful for testing)
 * @param impl {CustomFetch}
 */
export function setFetch(impl: CustomFetch) {
  fetch = impl
}

/**
 * SHA1 hash function
 */
function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex')
}

/**
 * Convert SHA1 to UUID format
 */
function sha1ToUuid(text: string): string {
  const hex = sha1(text)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/**
 * Generate stable point ID from file path and line range
 */
function stablePointId(filePath: string, startLine: number, endLine: number): string {
  return sha1ToUuid(`${filePath}:${startLine}:${endLine}`)
}

/**
 * Flatten symbols into metadata arrays
 */
function flattenSymbols(symbols: Partial<SymbolInfo>[]): SymbolMetadata {
  const names = new Set<string>()
  const references = new Set<string>()
  const kinds = new Set<string>()
  const unityTags = new Set<string>()

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
    unity: Array.from(unityTags),
  }
}

/**
 * Generate embeddings using Ollama
 * @param text - Text to embed
 * @param ollamaUrl - Ollama API URL
 * @param model - Model name
 * @returns Embedding vector or null
 */
async function embed(text: string, ollamaUrl?: string, model?: string): Promise<number[] | null> {
  const url = ollamaUrl || process.env.OLLAMA_URL || 'http://127.0.0.1:11434'
  const m = model || process.env.EMBED_MODEL || 'unclemusclez/jina-embeddings-v2-base-code'

  const res = await fetch(`${url}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: m, prompt: text }),
  })
  if (!res.ok) {
    const body = await res.text()
    if (body.includes('context length') || body.includes('input length')) return null
    throw new Error(`Ollama embeddings failed: ${res.status} ${body}`)
  }
  const json = await res.json() as { embedding: number[] }
  if (!json.embedding || json.embedding.length === 0) return null
  return json.embedding
}

export type Language =
  | 'javascript' | 'typescript' | 'python' | 'java' | 'kotlin' | 'csharp'
  | 'cpp' | 'c' | 'swift' | 'php' | 'ruby' | 'lua' | 'text'


/**
 * Detect programming language from file extension
 * @param filePath - File path
 * @returns Language name
 */
function detectLanguage(filePath: string): Language {
  const ext = path.extname(filePath).toLowerCase()
  const map: { [key: string]: Language } = {
    '.js': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
    '.py': 'python', '.java': 'java', '.kt': 'kotlin',
    '.cs': 'csharp', '.cpp': 'cpp', '.c': 'c', '.h': 'c', '.hpp': 'cpp',
    '.swift': 'swift', '.php': 'php', '.rb': 'ruby', '.lua': 'lua',
  }
  return map[ext] || 'text'
}

/**
 * Chunk text by lines with overlap
 * @param text - Text to chunk
 * @param maxLines - Maximum lines per chunk
 * @param overlap - Overlap lines between chunks
 * @returns Chunks with start_line, end_line, text
 */
function chunkByLines(text: string, maxLines: number, overlap: number): TextChunk[] {
  const lines = text.split('\n')
  const chunks: TextChunk[] = []
  let start = 0
  while (start < lines.length) {
    const end = Math.min(start + maxLines, lines.length)
    const chunkLines = lines.slice(start, end)
    chunks.push({
      start_line: start + 1,
      end_line: end,
      text: chunkLines.join('\n'),
    })
    if (end >= lines.length) break
    start = Math.max(end - overlap, start + 1)
  }
  return chunks
}

/**
 * Index a single file
 */
async function indexFile(relPath: string, settings?: IndexerSettings): Promise<FileProcessResult>
async function indexFile(projectRoot: string, relPath: string, collectionName: string, settings?: IndexerSettings): Promise<FileProcessResult>
async function indexFile(
  projectRootOrRelPath: string,
  relPathOrSettings?: string | IndexerSettings,
  collectionName?: string,
  settings: IndexerSettings = {},
): Promise<FileProcessResult> {
  let root: string, file: string, coll: string, conf: IndexerSettings
  if (typeof relPathOrSettings === 'string') {
    root = projectRootOrRelPath
    file = relPathOrSettings
    coll = collectionName as string
    conf = settings
  } else {
    root = process.env.WORKSPACE_DIR || process.cwd()
    file = projectRootOrRelPath
    coll = process.env.QDRANT_COLLECTION || 'project_index'
    conf = relPathOrSettings || {}
  }

  type FileIndexerConfig = {
    OLLAMA_URL: string
    EMBED_MODEL: string
    MAX_CHUNK_LINES: number
    OVERLAP_LINES: number
    MAX_FILE_BYTES: number
  }

  const cfg: FileIndexerConfig = {
    OLLAMA_URL: process.env.OLLAMA_URL || conf.OLLAMA_URL || 'http://127.0.0.1:11434',
    EMBED_MODEL: process.env.EMBED_MODEL || conf.EMBED_MODEL || 'unclemusclez/jina-embeddings-v2-base-code',
    MAX_CHUNK_LINES: Number(process.env.MAX_CHUNK_LINES || conf.MAX_CHUNK_LINES || '500'),
    OVERLAP_LINES: Number(process.env.OVERLAP_LINES || conf.OVERLAP_LINES || '50'),
    MAX_FILE_BYTES: Number(process.env.MAX_FILE_BYTES || conf.MAX_FILE_BYTES || String(2 * 1024 * 1024)),
  }

  const absPath = path.join(root, file)
  const st = await fs.stat(absPath)
  if (st.size > cfg.MAX_FILE_BYTES) return { indexed: false, reason: 'too_large' }

  const content = await fs.readFile(absPath, 'utf8')
  const fileHash = sha1(content)
  const prevHash = await getExistingFileHash(coll, file, conf)
  if (prevHash === fileHash) return { indexed: false, reason: 'unchanged' }
  if (prevHash) await deletePointsByPath(coll, file, conf)

  const lang = detectLanguage(file)
  let symbols: Partial<SymbolInfo>[] = []
  if (lang === 'javascript' || lang === 'typescript') symbols = extractJSSymbols(content)
  if (lang === 'python') symbols = await extractPythonSymbols(content)
  if (lang === 'csharp') symbols = await extractCSharpSymbols(content)

  const chunks = chunkByLines(content, cfg.MAX_CHUNK_LINES, cfg.OVERLAP_LINES)
  const points: QdrantPoint[] = []
  const symbolMeta = flattenSymbols(symbols)

  const queue: TextChunk[] = [...chunks]
  let processedCount = 0
  while (queue.length > 0) {
    const ch = queue.shift() as TextChunk
    const vector = await embed(ch.text, cfg.OLLAMA_URL, cfg.EMBED_MODEL)
    if (vector) {
      processedCount++
      const id = stablePointId(file, ch.start_line, ch.end_line)
      points.push({
        id, vector,
        payload: {
          ...symbolMeta,
          path: file,
          lang,
          start_line: ch.start_line,
          end_line: ch.end_line,
          text: ch.text,
          file_hash: fileHash,
          symbols: symbols as SymbolInfo[],
          symbol_names: symbolMeta.names,
          symbol_kinds: symbolMeta.kinds,
          unity_tags: symbolMeta.unity,
        },
      })
    } else {
      const lines = ch.text.split('\n')
      if (lines.length > 15) {
        const splitOverlap = Math.min(cfg.OVERLAP_LINES, Math.floor(lines.length / 4))
        const mid = Math.floor(lines.length / 2)
        const leftEndIdx = Math.min(lines.length, mid + splitOverlap)
        const rightStartIdx = Math.max(0, mid - splitOverlap)
        queue.unshift({
          start_line: ch.start_line + rightStartIdx,
          end_line: ch.end_line,
          text: lines.slice(rightStartIdx).join('\n'),
        })
        queue.unshift({
          start_line: ch.start_line,
          end_line: ch.start_line + leftEndIdx - 1,
          text: lines.slice(0, leftEndIdx).join('\n'),
        })
      }
    }
  }
  await upsertPoints(coll, points, conf)
  return { indexed: true, chunks: processedCount }
}

export {
  indexFile,
  embed,
  detectLanguage,
  chunkByLines,
  flattenSymbols,
  stablePointId,
  sha1,
  sha1ToUuid,
}
