/**
 * TypeScript/JavaScript LSP adapter
 * Uses typescript-language-server
 */

import path from 'path'
import { BaseLspAdapter } from './base.js'
import type { Symbol, Location, Position, LspServerConfig } from '../types.js'
import {
  normalizeDocumentSymbols,
  normalizeDefinition,
  normalizeReferences,
  toLspPosition,
  fileToUri
} from '../normalizer.js'

/**
 * TypeScript LSP adapter
 */
export class TypeScriptAdapter extends BaseLspAdapter {
  constructor(
    projectPath: string,
    collectionId: string,
    serverConfig: LspServerConfig,
    language: 'typescript' | 'javascript' = 'typescript'
  ) {
    super(language, projectPath, collectionId, serverConfig)
  }

  /**
   * Get document symbols
   */
  async documentSymbols(file: string): Promise<Symbol[]> {
    if (!this.client) {
      throw new Error('LSP client not started')
    }

    const uri = fileToUri(file, this.projectPath)

    try {
      const raw = await this.client.request(
        'textDocument/documentSymbol',
        {
          textDocument: { uri }
        },
        30000
      )

      return normalizeDocumentSymbols(
        raw || [],
        this.projectPath,
        file,
        this.language
      )
    } catch (err: any) {
      console.error(`[adapter:${this.language}] documentSymbols error:`, err.message)
      return []
    }
  }

  /**
   * Go to definition
   */
  async definition(file: string, position: Position): Promise<Location | null> {
    if (!this.client) {
      throw new Error('LSP client not started')
    }

    const uri = fileToUri(file, this.projectPath)
    const lspPosition = toLspPosition(position)

    try {
      const raw = await this.client.request(
        'textDocument/definition',
        {
          textDocument: { uri },
          position: lspPosition
        },
        30000
      )

      return normalizeDefinition(raw, this.projectPath)
    } catch (err: any) {
      console.error(`[adapter:${this.language}] definition error:`, err.message)
      return null
    }
  }

  /**
   * Find references
   */
  async references(
    file: string,
    position: Position,
    includeDeclaration: boolean
  ): Promise<Location[]> {
    if (!this.client) {
      throw new Error('LSP client not started')
    }

    const uri = fileToUri(file, this.projectPath)
    const lspPosition = toLspPosition(position)

    try {
      const raw = await this.client.request(
        'textDocument/references',
        {
          textDocument: { uri },
          position: lspPosition,
          context: { includeDeclaration }
        },
        30000
      )

      // TypeScript can return large reference lists, limit to 200
      return normalizeReferences(raw || [], this.projectPath, 200)
    } catch (err: any) {
      console.error(`[adapter:${this.language}] references error:`, err.message)
      return []
    }
  }
}
