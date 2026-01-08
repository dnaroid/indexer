import path from 'path'
import {spawn} from 'child_process'
import {extractJSSymbols, isJSCodeAtPosition} from '../utils/ast-js.js'
import {
  extractCSharpSymbols,
  extractPythonSymbols,
  isCodeAtPosition
} from '../utils/tree-sitter.js'

export interface RipgrepResult {
  path: string
  line: number
  column: number
  snippet: string
}

export interface SymbolInfo {
  name: string
  kind: string
  line?: number
  column?: number
}

export function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const map = {
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.py': 'python',
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

export async function filterReferences(results: RipgrepResult[], workspaceDir: string, readFile: (path: string, encoding: string) => Promise<string>): Promise<RipgrepResult[]> {
  const filtered = []
  const fileCache = new Map()

  for (const res of results) {
    const lang = detectLanguage(res.path)
    // If we don't support the language for AST filtering, keep the result
    if (lang === 'text') {
      filtered.push(res)
      continue
    }

    if (!fileCache.has(res.path)) {
      try {
        const abs = path.resolve(workspaceDir, res.path)
        const content = await readFile(abs, 'utf8')
        fileCache.set(res.path, content)
      } catch (e: any) {
        filtered.push(res)
        continue
      }
    }

    const content = fileCache.get(res.path)
    let isCode = true

    try {
      if (lang === 'javascript' || lang === 'typescript') {
        isCode = isJSCodeAtPosition(content, res.line, res.column - 1)
      } else if (['python', 'csharp'].includes(lang)) {
        isCode = await isCodeAtPosition(content, lang, res.line, res.column - 1)
      }
    } catch (e: any) {
      console.error(`Error filtering reference in ${res.path}:`, e)
      // On error, we prefer to keep the result (fail-open)
      isCode = true
    }

    if (isCode) {
      filtered.push(res)
    }
  }
  return filtered
}

export async function extractSymbols(filePath, content) {
  const lang = detectLanguage(filePath)
  if (lang === 'javascript' || lang === 'typescript') {
    return extractJSSymbols(content)
  }
  if (lang === 'python') {
    return await extractPythonSymbols(content)
  }
  if (lang === 'csharp') {
    return await extractCSharpSymbols(content)
  }
  return []
}

export function buildTreeText(files) {
  const tree = {}
  for (const f of files) {
    const parts = f.split('/')
    let current = tree
    for (const part of parts) {
      if (!current[part]) current[part] = {}
      current = current[part]
    }
  }

  const lines = []
  function render(obj, prefix = '') {
    const keys = Object.keys(obj).sort()
    keys.forEach((key, index) => {
      const isLast = index === keys.length - 1
      const connector = isLast ? '└── ' : '├── '
      lines.push(prefix + connector + key)
      const newPrefix = prefix + (isLast ? '    ' : '│   ')
      render(obj[key], newPrefix)
    })
  }
  render(tree)
  return lines.join('\n')
}

export function runRipgrep(pattern, workspaceDir = process.cwd(), _spawn = spawn) {
  return new Promise((resolve, reject) => {
    // -n: line numbers, -w: whole word, --column: column number, --no-heading: simple output
    const rg = _spawn('rg', [
      '--color=never',
      '--no-heading',
      '--line-number',
      '--column',
      '-w',
      pattern,
      workspaceDir
    ])

    let stdout = ''
    let stderr = ''

    rg.stdout.on('data', (data) => { stdout += data })
    rg.stderr.on('data', (data) => { stderr += data })

    rg.on('close', (code) => {
      if (code !== 0 && code !== 1) {
        console.error(`ripgrep failed with code ${code}: ${stderr}`)
        resolve([])
        return
      }

      const results = stdout.trim().split('\n')
        .filter(line => line.length > 0)
        .map(line => {
          // Format with --column: path:line:col:text
          // On Windows, path can have C:
          const parts = line.split(':')
          if (parts.length < 4) return null

          // To handle Windows paths correctly, we should join all parts except the last 3
          // or just find indices of colons from the end.
          const text = parts.slice(3).join(':').trim()
          const col = parseInt(parts[parts.length - 2], 10)
          const lineNum = parseInt(parts[parts.length - 3], 10)
          const fullPath = parts.slice(0, parts.length - 3).join(':')

          const relPath = path.relative(workspaceDir, fullPath)
          return { path: relPath, line: lineNum, column: col, snippet: text }
        })
        .filter(Boolean)

      resolve(results)
    })

    rg.on('error', (err) => {
       // rg not installed or other spawn error
       console.error('Failed to spawn ripgrep:', err)
       resolve([])
    })
  })
}
