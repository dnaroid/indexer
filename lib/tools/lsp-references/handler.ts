import type { ToolHandlersDeps } from '../common/types.js'
import { adapterManager } from '../../lsp/adapter-manager.js'
import { responseCache, CACHE_TTL } from '../../lsp/response-cache.js'
import { loadGlobalConfig } from '../../utils/config-global.js'
import type { Position } from '../../lsp/types.js'
import path from 'path'

/**
 * Find all references to a symbol at a specific position via LSP
 * Uses adapter layer for normalized, language-agnostic responses
 */
export async function lspReferences(
  deps: ToolHandlersDeps,
  { collectionId, path: filePath, line, column, includeDeclaration = false, maxResults = 200, language }: {
    collectionId?: string
    path: string
    line: number
    column: number
    includeDeclaration?: boolean
    maxResults?: number
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

  const position: Position = { line, character: column }

  try {
    // Check cache
    const cacheKey = responseCache.getCacheKey('references', detectedLang, filePath, position)
    const cached = responseCache.get<any[]>(cacheKey)
    if (cached) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            references: cached,
            total: cached.length,
            truncated: false
          }, null, 2)
        }]
      }
    }

    // Get adapter
    const adapter = await adapterManager.getOrCreateAdapter(
      collectionId,
      detectedLang,
      projectPath
    )

    // Call adapter
    const references = await adapter.references(filePath, position, includeDeclaration)

    // Apply maxResults limit
    const limited = references.slice(0, maxResults)

    // Cache result
    responseCache.set(cacheKey, limited, CACHE_TTL.REFERENCES)

    // Return normalized response
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          references: limited,
          total: references.length,
          truncated: references.length > limited.length
        }, null, 2)
      }]
    }
  } catch (err: any) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          error: err.message,
          language: detectedLang,
          path: filePath,
          line,
          column,
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

/**
 * Normalize references result to a consistent format and limit to maxResults
 */
function normalizeReferencesResult(result: any, projectPath: string, maxResults: number): any[] {
  if (!result || !Array.isArray(result)) {
    return []
  }

  // Limit to maxResults
  const limited = result.slice(0, maxResults)

  // Normalize each location
  return limited.map(location => normalizeLocation(location, projectPath))
}

/**
 * Normalize a single Location
 */
function normalizeLocation(location: any, projectPath: string): any {
  if (!location || !location.uri) {
    return location
  }

  return {
    uri: location.uri,
    path: uriToRelativePath(location.uri, projectPath),
    range: location.range,
    // Convert 0-based to 1-based for user display
    start_line: (location.range?.start?.line || 0) + 1,
    start_column: (location.range?.start?.character || 0) + 1,
    end_line: (location.range?.end?.line || 0) + 1,
    end_column: (location.range?.end?.character || 0) + 1
  }
}

/**
 * Convert file:// URI to relative path
 */
function uriToRelativePath(uri: string, projectPath: string): string {
  // Remove file:// prefix
  const filePath = uri.replace(/^file:\/\//, '')

  // Make relative to project path
  const relativePath = path.relative(projectPath, filePath)

  return relativePath
}
