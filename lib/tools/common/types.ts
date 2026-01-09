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
