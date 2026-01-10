/**
 * Normalized LSP types for MCP API
 * These types hide raw LSP protocol details and provide a consistent interface across languages
 */

/**
 * Canonical position (1-based, user-facing)
 */
export interface Position {
  line: number
  character: number
}

/**
 * Canonical range
 */
export interface Range {
  start: Position
  end: Position
}

/**
 * Symbol kinds (normalized across languages)
 */
export type SymbolKind =
  | 'class'
  | 'method'
  | 'function'
  | 'interface'
  | 'enum'
  | 'variable'
  | 'property'
  | 'constant'
  | 'type'
  | 'namespace'

/**
 * Normalized symbol
 */
export interface Symbol {
  name: string
  kind: SymbolKind
  range: string  // "startLine:startChar-endLine:endChar"
  file: string   // relative path
  parent?: string
  public?: boolean
}

/**
 * Normalized location
 */
export interface Location {
  file: string   // relative path
  range: string  // "startLine:startChar-endLine:endChar"
}

/**
 * Response: document symbols
 */
export interface DocumentSymbolsResponse {
  file: string
  symbols: Symbol[]
}

/**
 * Response: definition
 */
export interface DefinitionResponse {
  symbol?: string
  defined_in?: Location
  error?: string
}

/**
 * Response: references
 */
export interface ReferencesResponse {
  symbol?: string
  references: Location[]
  total: number
  truncated: boolean
}

/**
 * LSP server configuration
 */
export interface LspServerConfig {
  command: string
  args: string[]
  initializationOptions?: any
}

/**
 * LSP configuration
 */
export interface LspConfig {
  enabled?: boolean
  idleTimeoutMs?: number
  requestTimeoutMs?: number
  servers?: Record<string, LspServerConfig>
}
