import type { ToolHandlersDeps } from '../common/types.js'
import { adapterManager } from '../../lsp/adapter-manager.js'
import { responseCache, CACHE_TTL } from '../../lsp/response-cache.js'
import { loadGlobalConfig } from '../../utils/config-global.js'
import type { Position } from '../../lsp/types.js'
import path from 'path'

/**
 * Go to definition of a symbol at a specific position via LSP
 * Uses adapter layer for normalized, language-agnostic responses
 */
export async function lspDefinition(
  deps: ToolHandlersDeps,
  { collectionId, path: filePath, line, column, language }: {
    collectionId?: string
    path: string
    line: number
    column: number
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
    const cacheKey = responseCache.getCacheKey('definition', detectedLang, filePath, position)
    const cached = responseCache.get<any>(cacheKey)
    if (cached !== null && cached !== undefined) {
      if (!cached) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: 'Symbol not found in indexed workspace' }, null, 2)
          }]
        }
      }
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ defined_in: cached }, null, 2)
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
    const location = await adapter.definition(filePath, position)

    // Cache result
    responseCache.set(cacheKey, location, CACHE_TTL.DEFINITION)

    // Return normalized response
    if (!location) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'Symbol not found in indexed workspace' }, null, 2)
        }]
      }
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ defined_in: location }, null, 2)
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
 * Normalize definition result to a consistent format
 * Converts file:// URIs to relative paths
 */
function normalizeDefinitionResult(result: any, projectPath: string): any {
  if (!result) {
    return []
  }

  // Handle array of locations
  if (Array.isArray(result)) {
    return result.map(loc => normalizeLocation(loc, projectPath))
  }

  // Handle single location
  return [normalizeLocation(result, projectPath)]
}

/**
 * Normalize a single Location or LocationLink
 */
function normalizeLocation(location: any, projectPath: string): any {
  // LocationLink format
  if ('targetUri' in location) {
    return {
      uri: location.targetUri,
      path: uriToRelativePath(location.targetUri, projectPath),
      range: location.targetRange || location.targetSelectionRange,
      // Convert 0-based to 1-based for user display
      start_line: (location.targetRange?.start?.line || 0) + 1,
      start_column: (location.targetRange?.start?.character || 0) + 1,
      end_line: (location.targetRange?.end?.line || 0) + 1,
      end_column: (location.targetRange?.end?.character || 0) + 1
    }
  }

  // Location format
  if ('uri' in location) {
    return {
      uri: location.uri,
      path: uriToRelativePath(location.uri, projectPath),
      range: location.range,
      start_line: (location.range?.start?.line || 0) + 1,
      start_column: (location.range?.start?.character || 0) + 1,
      end_line: (location.range?.end?.line || 0) + 1,
      end_column: (location.range?.end?.character || 0) + 1
    }
  }

  return location
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
