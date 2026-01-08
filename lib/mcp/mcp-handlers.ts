import path from 'path'

export interface ToolHandlersDeps {
  embed: (text: string) => Promise<number[]>
  searchQdrant: (vector: number[], topK: number, pathPrefix?: string) => Promise<any[]>
  searchSymbols: (name: string, kind?: string, topK?: number) => Promise<any[]>
  readFile: (path: string) => Promise<string>
  listProjectFiles: () => Promise<string[]>
  extractSymbols: (path: string, content: string) => Promise<any[]>
  buildTreeText: (files: string[]) => string
  runRipgrep: (symbol: string) => Promise<any[]>
  filterReferences: (results: any[], cwd: string | null, readFile: any) => Promise<any[]>
}

export function createToolHandlers(deps: ToolHandlersDeps) {
  const getTopKDefault = () => 5
  
  return {
    search_codebase: async ({query, top_k = getTopKDefault(), path_prefix}: {query: string, top_k?: number, path_prefix?: string}) => {
      const queryVector = await deps.embed(query)
      const results = await deps.searchQdrant(queryVector, top_k, path_prefix)

      const formatted = results.map((r, i) => {
        const p = r.payload || {}
        return {
          rank: i + 1,
          path: p.path,
          start_line: p.start_line,
          end_line: p.end_line,
          snippet: p.text,
          score: r.score,
          symbol_names: p.symbol_names,
          symbol_kinds: p.symbol_kinds,
          unity_tags: p.unity_tags
        }
      })

      return {content: [{type: 'text', text: JSON.stringify(formatted, null, 2)}]}
    },

    search_symbols: async ({name, kind = 'any', top_k = 10}: {name: string, kind?: string, top_k?: number}) => {
      const results = await deps.searchSymbols(name, kind, top_k)

      const formatted = results.map((r, i) => {
        const p = r.payload || {}
        return {
          rank: i + 1,
          path: p.path,
          start_line: p.start_line,
          end_line: p.end_line,
          symbol_names: p.symbol_names,
          symbol_kinds: p.symbol_kinds,
          unity_tags: p.unity_tags,
          snippet: p.text,
          score: r.score
        }
      })

      return {content: [{type: 'text', text: JSON.stringify(formatted, null, 2)}]}
    },

    get_file_outline: async ({path: filePath}) => {
      const content = await deps.readFile(filePath)
      const symbols = await deps.extractSymbols(filePath, content)

      const formatted = symbols
        .filter(s => s.kind !== 'reference')
        .map(s => ({
          name: s.name,
          kind: s.kind,
          line: s.start
        }))

      return {content: [{type: 'text', text: JSON.stringify(formatted, null, 2)}]}
    },

    get_project_structure: async () => {
      const files = await deps.listProjectFiles()
      const treeText = deps.buildTreeText(files)
      return {content: [{type: 'text', text: treeText || '(empty project)'}]}
    },

    find_usages: async ({symbol, context}) => {
      let searchName = symbol
      let autoContext = context

      if (symbol.includes('.') && !context) {
        const parts = symbol.split('.')
        searchName = parts.pop()
        autoContext = parts.join('.')
      }

      const rawResults = await deps.runRipgrep(searchName) 
      const filteredResults = await deps.filterReferences(rawResults, null, deps.readFile) 
      
      let finalResults = filteredResults

      if (autoContext) {
        const points = await deps.searchSymbols(autoContext, 'any', 100)
        const filesWithContext = new Set(points.map(p => p.payload?.path))
        finalResults = filteredResults.filter(r => filesWithContext.has(r.path))
        if (finalResults.length === 0 && filteredResults.length > 0) {
          finalResults = filteredResults
        }
      }

      return {content: [{type: 'text', text: JSON.stringify(finalResults, null, 2)}]}
    }
  }
}
