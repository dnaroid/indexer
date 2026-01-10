/**
 * Base LSP adapter interface and abstract implementation
 * All language-specific adapters extend BaseLspAdapter
 */

import { LspClient } from '../lsp-client.js'
import type { Symbol, Location, Position, LspServerConfig } from '../types.js'

/**
 * LSP adapter interface
 * Provides language-agnostic API for LSP operations
 */
export interface LspAdapter {
  language: string
  projectPath: string
  collectionId: string

  // Lifecycle
  start(): Promise<void>
  stop(): Promise<void>
  isReady(): boolean

  // Core operations
  documentSymbols(file: string): Promise<Symbol[]>
  definition(file: string, position: Position): Promise<Location | null>
  references(file: string, position: Position, includeDeclaration: boolean): Promise<Location[]>

  // Optional future operations
  hover?(file: string, position: Position): Promise<any>
  rename?(file: string, position: Position, newName: string): Promise<any>
}

/**
 * Base LSP adapter implementation
 * Handles common LSP client lifecycle management
 */
export abstract class BaseLspAdapter implements LspAdapter {
  protected client: LspClient | null = null

  constructor(
    public language: string,
    public projectPath: string,
    public collectionId: string,
    protected serverConfig: LspServerConfig
  ) {}

  /**
   * Start the LSP client
   */
  async start(): Promise<void> {
    if (this.client?.isReady()) {
      return
    }

    const rootUri = `file://${this.projectPath}`
    this.client = new LspClient(
      this.serverConfig.command,
      this.serverConfig.args || [],
      rootUri,
      this.serverConfig.initializationOptions || {}
    )

    try {
      await this.client.start()
    } catch (err: any) {
      this.client = null
      throw new Error(`Failed to start LSP server for ${this.language}: ${err.message}`)
    }
  }

  /**
   * Stop the LSP client
   */
  async stop(): Promise<void> {
    if (this.client) {
      try {
        await this.client.shutdown()
      } catch (err) {
        console.error(`[adapter:${this.language}] Error during shutdown:`, err)
      } finally {
        this.client = null
      }
    }
  }

  /**
   * Check if adapter is ready
   */
  isReady(): boolean {
    return this.client !== null && this.client.isReady()
  }

  /**
   * Abstract methods - must be implemented by language-specific adapters
   */
  abstract documentSymbols(file: string): Promise<Symbol[]>
  abstract definition(file: string, position: Position): Promise<Location | null>
  abstract references(file: string, position: Position, includeDeclaration: boolean): Promise<Location[]>
}
