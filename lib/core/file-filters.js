/**
 * File Filters Module
 * Handles file filtering, ignore patterns, and to-index configuration.
 */

import fs from 'fs/promises'
import path from 'path'
import fg from 'fast-glob'
import ignore from 'ignore'

/**
 * Default file exclusion patterns
 */
export const DEFAULT_EXCLUDES = [
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

// --- Caches ---
const _toIndexCache = new Map()
const _ignoreCache = new Map()

/**
 * Reset configuration cache
 * @param {string} projectRoot - Project root path (optional)
 */
export function resetConfigCache(projectRoot) {
  if (projectRoot) {
    _toIndexCache.delete(projectRoot)
    _ignoreCache.delete(projectRoot)
  } else {
    _toIndexCache.clear()
    _ignoreCache.clear()
  }
}

/**
 * Load ignore patterns from .gitignore
 * @param {string} projectRoot - Project root path
 * @returns {Promise<Ignore>} Ignore instance
 */
export async function loadIgnorePatterns(projectRoot) {
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

/**
 * Parse to-index configuration text
 * @param {string} text - Configuration text
 * @returns {{dirs: string[], exts: string[]}} Parsed configuration
 */
function parseToIndexConfig(text) {
  const dirs = []
  const exts = []
  const lines = text.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    let kind = ''
    let value = ''
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

/**
 * Load to-index configuration from .indexer/to-index
 * @param {string} projectRoot - Project root path
 * @returns {Promise<object|null>} Configuration object or null
 */
export async function loadToIndexConfig(projectRoot) {
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

/**
 * Check if a file should be indexed
 * @param {string} projectRoot - Project root path
 * @param {string} relPath - Relative file path
 * @returns {Promise<boolean>} True if file should be indexed
 */
export async function shouldIndexFile(projectRoot, relPath) {
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

/**
 * List all project files that should be indexed
 * @param {string} projectRoot - Project root path
 * @returns {Promise<string[]>} List of relative file paths
 */
export async function listProjectFiles(projectRoot) {
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
