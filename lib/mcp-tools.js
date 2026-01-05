import path from 'path'
import {spawn} from 'child_process'
import {extractJSSymbols} from './ast-js.js'
import {
  extractCSharpSymbols,
  extractGoSymbols,
  extractPythonSymbols,
  extractRustSymbols
} from './tree-sitter.js'

export function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const map = {
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.cs': 'csharp'
  }
  return map[ext] || 'text'
}

export function extractSymbols(filePath, content) {
  const lang = detectLanguage(filePath)
  if (lang === 'javascript' || lang === 'typescript') {
    return extractJSSymbols(content)
  }
  if (lang === 'python') {
    return extractPythonSymbols(content)
  }
  if (lang === 'go') {
    return extractGoSymbols(content)
  }
  if (lang === 'rust') {
    return extractRustSymbols(content)
  }
  if (lang === 'csharp') {
    return extractCSharpSymbols(content)
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
    // -n: line numbers, -w: whole word, --no-heading: simple output
    const rg = _spawn('rg', [
      '--color=never',
      '--no-heading',
      '--line-number',
      '-w',
      pattern,
      workspaceDir
    ])

    let stdout = ''
    let stderr = ''

    rg.stdout.on('data', (data) => { stdout += data })
    rg.stderr.on('data', (data) => { stderr += data })

    rg.on('close', (code) => {
      // code 0 = found match
      // code 1 = no match found (not an error)
      if (code !== 0 && code !== 1) {
        // Ripgrep errors might be important, but for now we resolve empty
        console.error(`ripgrep failed with code ${code}: ${stderr}`)
        resolve([])
        return
      }

      const results = stdout.trim().split('\n')
        .filter(line => line.length > 0)
        .map(line => {
          // Format: file:line:content...
          // On Windows/Unix paths can vary, but usually relative to CWD if passed as such.
          // rg output with --no-heading is "path:line:text"
          // Be careful about colons in path (Windows C:\...) but usually rg outputs relative if we pass relative dir?
          // We passed absolute workspaceDir.
          
          // Let's parse carefully. Find first and second colon.
          const firstColon = line.indexOf(':')
          const secondColon = line.indexOf(':', firstColon + 1)
          
          if (firstColon === -1 || secondColon === -1) return null

          const fullPath = line.substring(0, firstColon)
          const lineNum = line.substring(firstColon + 1, secondColon)
          const text = line.substring(secondColon + 1).trim()
          
          const relPath = path.relative(workspaceDir, fullPath)
          return { path: relPath, line: parseInt(lineNum, 10), snippet: text }
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
