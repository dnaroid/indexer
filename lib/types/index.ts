/**
 * Shared type definitions for AI Indexer
 */

import type { z } from 'zod'

// ============================================================================
// Project Configuration
// ============================================================================

export interface ProjectPaths {
  root: string
  dotDir: string
  envPath: string
  rootMcpPath: string
  codexArgsPath: string
  statePath: string
  toIndexPath: string
}

export interface ProjectState {
  projectId: string
  collectionName: string
  workspaceDir: string
  createdAt: string
  updatedAt: string
  indexedAt?: string
  [key: string]: any
}

// ============================================================================
// Indexer Configuration
// ============================================================================

export interface IndexerSettings {
  QDRANT_URL?: string
  OLLAMA_URL?: string
  EMBED_MODEL?: string
  VECTOR_SIZE?: number
  MAX_CHUNK_LINES?: number
  OVERLAP_LINES?: number
  MAX_FILE_BYTES?: number
  TOP_K_DEFAULT?: number
  SCORE_THRESHOLD?: number
}

export interface IndexerOptions {
  reset?: boolean
  settings?: IndexerSettings
}

// ============================================================================
// File Processing
// ============================================================================

export interface FileChunk {
  content: string
  startLine: number
  endLine: number
  filePath: string
}

export interface FileIndexResult {
  indexed: boolean
  reason?: string
  chunks?: number
}

export interface FileProcessResult {
  indexed: boolean
  reason?: 'too_large' | 'unchanged' | 'error'
  chunks?: number
}

export type CustomFetch = (url: string, options?: any) => Promise<Response>

export type SymbolKind =
    | 'function' | 'method' | 'class' | 'interface' | 'struct' | 'enum'
    | 'variable' | 'constant' | 'property' | 'field' | 'import' | 'export'
    | 'reference' | 'unity_lifecycle' | 'serialized_field' | 'scriptable_object'
    | 'hook' | 'function_component' | 'accessor' | 'private_field' | 'type'
    | 'namespace' | 'const' | 'default_export'
    | 'unknown'

export interface SymbolInfo {
  name: string
  kind: SymbolKind
  line: number
  end_line: number
  [key: string]: any
}

export interface SymbolMetadata {
  names: string[]
  references: string[]
  kinds: string[]
  unity: string[]
}

export interface TextChunk {
  start_line: number
  end_line: number
  text: string
}

// ============================================================================
// Qdrant / Vector Storage
// ============================================================================

export interface PointPayload extends SymbolMetadata {
  path: string
  lang: string
  start_line: number
  end_line: number
  text: string
  file_hash: string
  symbols: SymbolInfo[]
  symbol_names: string[]
  symbol_kinds: string[]
  unity_tags: string[]
}

export interface QdrantPoint {
  id: string
  vector: number[]
  payload: PointPayload
}

export interface QdrantSearchResult {
  id: string
  score: number
  payload: {
    filePath: string
    content: string
    startLine: number
    endLine: number
    language: string
    [key: string]: any
  }
}

export interface CollectionInfo {
  name: string
  pointsCount: number
  indexedFiles?: number
  lastUpdated?: string
}

// ============================================================================
// MCP Server Types
// ============================================================================

export interface McpServerConfig {
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface McpConfig {
  mcpServers: {
    [name: string]: McpServerConfig
  }
}

export interface McpTool {
  name: string
  description: string
  inputSchema: z.ZodTypeAny
}

export interface McpToolCall {
  name: string
  arguments: {
    collectionId?: string
    [key: string]: any
  }
}

// ============================================================================
// Service Types
// ============================================================================

export interface DaemonStatus {
  running: boolean
  pid?: number
  uptime?: number
  projects: number
}

export interface ServiceLifecycle {
  start(): Promise<void>
  stop(): Promise<void>
  restart(): Promise<void>
  isRunning(): boolean
}

// ============================================================================
// CLI Types
// ============================================================================

export interface CliOption {
  label: string
  value: string
}

export interface CliCommand {
  name: string
  handler: (...args: any[]) => Promise<void>
  description?: string
}

// ============================================================================
// AST / Code Analysis
// ============================================================================

export interface CodeSymbol {
  name: string
  kind: string
  line: number
  column?: number
  filePath: string
  parent?: string
}

export interface FileAnalysis {
  filePath: string
  language: string
  symbols: CodeSymbol[]
  functions: CodeSymbol[]
  classes: CodeSymbol[]
  imports: string[]
  exports: string[]
}

// ============================================================================
// Tree-sitter Types
// ============================================================================

export interface TreeSitterLanguage {
  name: string
  extensions: string[]
  parser: any
}

// ============================================================================
// Error Types
// ============================================================================

export class IndexerError extends Error {
  code: string
  
  constructor(message: string, code: string) {
    super(message)
    this.name = 'IndexerError'
    this.code = code
  }
}

export class QdrantError extends Error {
  code?: string
  
  constructor(message: string, code?: string) {
    super(message)
    this.name = 'QdrantError'
    this.code = code
  }
}

// ============================================================================
// Utility Types
// ============================================================================

export type AsyncResult<T> = Promise<T>
export type MaybePromise<T> = T | Promise<T>
export type Nullable<T> = T | null
