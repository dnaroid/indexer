import type { ToolHandlersDeps } from '../common/types.js'
import { adapterManager } from '../../lsp/adapter-manager.js'
import { responseCache, CACHE_TTL } from '../../lsp/response-cache.js'
import { loadGlobalConfig } from '../../utils/config-global.js'
import path from 'path'

/**
 * Get list of symbols (classes, methods, functions) in a file via LSP
 * Uses adapter layer for normalized, language-agnostic responses
 */
export async function lspDocumentSymbols(
  deps: ToolHandlersDeps,
  { collectionId, path: filePath, language }: {
    collectionId?: string
    path: string
    language?: string
  }
) {
  if (!collectionId) {
    throw new Error('collectionId is required')
  }

  // Resolve project path from collectionId
  const config = await loadGlobalConfig()
  let projectPath: string | null = null

  for (const [p, data] of Object.entries(config.projects)) {
    if ((data as any).collectionName === collectionId) {
      projectPath = p
      break
    }
  }

  if (!projectPath) {
    throw new Error(`Collection not found: ${collectionId}`)
  }

  // Detect language from file extension if not provided
  const detectedLang = language || detectLanguage(filePath)

  try {
    // Check cache
    const cacheKey = responseCache.getCacheKey('documentSymbols', detectedLang, filePath)
    const cached = responseCache.get<any>(cacheKey)
    if (cached) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ file: filePath, symbols: cached }, null, 2)
        }]
      }
    }

    // Get adapter
    const adapter = await adapterManager.getOrCreateAdapter(
      collectionId,
      detectedLang,
      projectPath
    )

    // Call adapter (returns normalized symbols)
    const symbols = await adapter.documentSymbols(filePath)

    // Cache result
    responseCache.set(cacheKey, symbols, CACHE_TTL.DOCUMENT_SYMBOLS)

    // Return normalized response
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ file: filePath, symbols }, null, 2)
      }]
    }
  } catch (err: any) {
    // Return error in user-friendly format
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: err.message,
          language: detectedLang,
          path: filePath,
          collectionId
        }, null, 2)
      }]
    }
  }
}

/**
 * Detect programming language from file extension
 */
function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()

  const langMap: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript'
  }

  return langMap[ext] || 'typescript'
}
