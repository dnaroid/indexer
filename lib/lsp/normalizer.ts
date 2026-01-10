/**
 * Normalization layer for LSP responses
 * Converts raw LSP protocol objects to canonical, language-agnostic formats
 */

import path from 'path'
import type { Symbol, SymbolKind, Location, Position, Range } from './types.js'

/**
 * LSP SymbolKind enum values
 * https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#symbolKind
 */
const LSP_SYMBOL_KIND = {
  File: 1,
  Module: 2,
  Namespace: 3,
  Package: 4,
  Class: 5,
  Method: 6,
  Property: 7,
  Field: 8,
  Constructor: 9,
  Enum: 10,
  Interface: 11,
  Function: 12,
  Variable: 13,
  Constant: 14,
  String: 15,
  Number: 16,
  Boolean: 17,
  Array: 18,
  Object: 19,
  Key: 20,
  Null: 21,
  EnumMember: 22,
  Struct: 23,
  Event: 24,
  Operator: 25,
  TypeParameter: 26
}

/**
 * Normalize LSP SymbolKind to canonical kind
 */
export function normalizeSymbolKind(lspKind: number, language: string): SymbolKind {
  switch (lspKind) {
    case LSP_SYMBOL_KIND.Class:
    case LSP_SYMBOL_KIND.Struct:
      return 'class'

    case LSP_SYMBOL_KIND.Method:
    case LSP_SYMBOL_KIND.Constructor:
      return 'method'

    case LSP_SYMBOL_KIND.Function:
      return 'function'

    case LSP_SYMBOL_KIND.Interface:
      return 'interface'

    case LSP_SYMBOL_KIND.Enum:
      return 'enum'

    case LSP_SYMBOL_KIND.Variable:
    case LSP_SYMBOL_KIND.Field:
      return 'variable'

    case LSP_SYMBOL_KIND.Property:
      return 'property'

    case LSP_SYMBOL_KIND.Constant:
    case LSP_SYMBOL_KIND.EnumMember:
      return 'constant'

    case LSP_SYMBOL_KIND.TypeParameter:
      return 'type'

    case LSP_SYMBOL_KIND.Namespace:
    case LSP_SYMBOL_KIND.Module:
    case LSP_SYMBOL_KIND.Package:
      return 'namespace'

    default:
      // Fallback based on language
      if (language === 'python') {
        return 'function'
      }
      return 'variable'
  }
}

/**
 * Normalize LSP Range to string format "startLine:startChar-endLine:endChar"
 * Converts from 0-based LSP positions to 1-based user positions
 */
export function normalizeRange(lspRange: any): string {
  if (!lspRange || !lspRange.start || !lspRange.end) {
    return '0:0-0:0'
  }

  const startLine = (lspRange.start.line || 0) + 1
  const startChar = (lspRange.start.character || 0) + 1
  const endLine = (lspRange.end.line || 0) + 1
  const endChar = (lspRange.end.character || 0) + 1

  return `${startLine}:${startChar}-${endLine}:${endChar}`
}

/**
 * Convert file:// URI to relative path
 */
export function normalizeUri(uri: string, projectPath: string): string {
  // Remove file:// prefix
  const filePath = uri.replace(/^file:\/\//, '')

  // Make relative to project path
  const relativePath = path.relative(projectPath, filePath)

  return relativePath
}

/**
 * Normalize document symbols from LSP response
 * Handles both flat and hierarchical symbol arrays
 */
export function normalizeDocumentSymbols(
  raw: any[],
  projectPath: string,
  filePath: string,
  language: string,
  parentName?: string
): Symbol[] {
  if (!Array.isArray(raw)) {
    return []
  }

  const symbols: Symbol[] = []

  for (const item of raw) {
    // Handle DocumentSymbol (hierarchical)
    if ('range' in item && 'name' in item) {
      const symbol: Symbol = {
        name: item.name,
        kind: normalizeSymbolKind(item.kind, language),
        range: normalizeRange(item.range),
        file: filePath
      }

      // Add parent reference
      if (parentName) {
        symbol.parent = parentName
      }

      // Infer public/private (language-specific heuristics)
      if (language === 'typescript' || language === 'javascript') {
        // TypeScript: private members start with #
        symbol.public = !item.name.startsWith('#') && !item.name.startsWith('_')
      }

      symbols.push(symbol)

      // Recursively process children
      if (item.children && Array.isArray(item.children)) {
        const childSymbols = normalizeDocumentSymbols(
          item.children,
          projectPath,
          filePath,
          language,
          item.name
        )
        symbols.push(...childSymbols)
      }
    }
    // Handle SymbolInformation (flat)
    else if ('location' in item && item.location.uri) {
      const symbol: Symbol = {
        name: item.name,
        kind: normalizeSymbolKind(item.kind, language),
        range: normalizeRange(item.location.range),
        file: normalizeUri(item.location.uri, projectPath)
      }

      // containerName is the parent
      if (item.containerName) {
        symbol.parent = item.containerName
      }

      symbols.push(symbol)
    }
  }

  return symbols
}

/**
 * Normalize a single LSP Location to canonical Location
 */
export function normalizeLocation(raw: any, projectPath: string): Location | null {
  if (!raw || !raw.uri) {
    return null
  }

  return {
    file: normalizeUri(raw.uri, projectPath),
    range: normalizeRange(raw.range)
  }
}

/**
 * Normalize definition result (can be Location, Location[], or LocationLink[])
 */
export function normalizeDefinition(raw: any, projectPath: string): Location | null {
  if (!raw) {
    return null
  }

  // Handle array - take first result
  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      return null
    }
    return normalizeDefinitionItem(raw[0], projectPath)
  }

  // Handle single location
  return normalizeDefinitionItem(raw, projectPath)
}

/**
 * Normalize a single definition item (Location or LocationLink)
 */
function normalizeDefinitionItem(item: any, projectPath: string): Location | null {
  // LocationLink format
  if ('targetUri' in item) {
    return {
      file: normalizeUri(item.targetUri, projectPath),
      range: normalizeRange(item.targetRange || item.targetSelectionRange)
    }
  }

  // Location format
  if ('uri' in item) {
    return {
      file: normalizeUri(item.uri, projectPath),
      range: normalizeRange(item.range)
    }
  }

  return null
}

/**
 * Normalize references result with maxResults limit
 */
export function normalizeReferences(
  raw: any[],
  projectPath: string,
  maxResults: number
): Location[] {
  if (!Array.isArray(raw)) {
    return []
  }

  const locations: Location[] = []

  for (const item of raw) {
    const location = normalizeLocation(item, projectPath)
    if (location) {
      locations.push(location)
    }

    // Apply limit during iteration for efficiency
    if (locations.length >= maxResults) {
      break
    }
  }

  return locations
}

/**
 * Convert 1-based user position to 0-based LSP position
 */
export function toLspPosition(position: Position): { line: number; character: number } {
  return {
    line: position.line - 1,
    character: position.character - 1
  }
}

/**
 * Convert relative file path to file:// URI
 */
export function fileToUri(filePath: string, projectPath: string): string {
  const absolutePath = path.resolve(projectPath, filePath)
  return `file://${absolutePath}`
}
