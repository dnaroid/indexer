import path from 'path'
import fs from 'fs/promises'
import crypto from 'crypto'
import { extractImports as extractJSImports } from '../utils/ast-js.js'
import { extractPythonImports, extractCSharpImports } from '../utils/tree-sitter.js'
import { resolveImportPath } from '../utils/path-resolver.js'
import {
  saveNodes,
  saveEdges,
  deleteFileFromGraph,
  type DependencyNode,
  type DependencyEdge
} from '../utils/dependency-graph-db.js'
import { detectLanguage } from '../tools/common/utils.js'

/**
 * SHA1 hash function
 */
function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex')
}

/**
 * Build dependency graph for multiple files
 */
export async function buildDependencyGraph(
  projectRoot: string,
  collectionId: string,
  filePaths: string[]
): Promise<void> {
  const nodes: Omit<DependencyNode, 'collection_id'>[] = []
  const edges: Omit<DependencyEdge, 'collection_id'>[] = []

  for (const filePath of filePaths) {
    try {
      const result = await processFile(projectRoot, filePath)
      if (result) {
        nodes.push(result.node)
        edges.push(...result.edges)
      }
    } catch (error) {
      // Skip files that can't be processed
      console.error(`Error processing file ${filePath}:`, error)
    }
  }

  // Save all nodes and edges in batches
  if (nodes.length > 0) {
    await saveNodes(collectionId, nodes)
  }
  if (edges.length > 0) {
    await saveEdges(collectionId, edges)
  }
}

/**
 * Process a single file and extract its imports
 */
async function processFile(
  projectRoot: string,
  filePath: string
): Promise<{
  node: Omit<DependencyNode, 'collection_id'>
  edges: Omit<DependencyEdge, 'collection_id'>[]
} | null> {
  const fullPath = path.join(projectRoot, filePath)
  const content = await fs.readFile(fullPath, 'utf8')
  const hash = sha1(content)
  const lang = detectLanguage(filePath)

  // Skip unsupported languages
  if (lang !== 'javascript' && lang !== 'typescript' && lang !== 'python' && lang !== 'csharp') {
    return null
  }

  // Extract imports based on language
  let imports: any[] = []

  if (lang === 'javascript' || lang === 'typescript') {
    imports = extractJSImports(content)
  } else if (lang === 'python') {
    imports = await extractPythonImports(content)
  } else if (lang === 'csharp') {
    imports = await extractCSharpImports(content)
  }

  // Create node
  const node: Omit<DependencyNode, 'collection_id'> = {
    file_path: filePath,
    module_path: filePath,
    lang,
    is_external: false,
    package_name: null,
    hash
  }

  // Create edges for each import
  const edges: Omit<DependencyEdge, 'collection_id'>[] = []

  for (const imp of imports) {
    try {
      const resolved = await resolveImportPath(
        imp.source,
        filePath,
        projectRoot,
        lang as 'javascript' | 'typescript' | 'python' | 'csharp'
      )

      edges.push({
        source_file: filePath,
        target_file: resolved.targetPath,
        target_module: imp.source,
        import_type: imp.importType,
        imported_names: imp.names.length > 0 ? JSON.stringify(imp.names) : null,
        line_number: imp.line,
        is_resolved: resolved.resolved
      })

      // If this is an external dependency, we might want to create a node for it
      // But for MVP, we'll skip creating nodes for external dependencies
    } catch (error) {
      // If resolution fails, still save the edge as unresolved
      edges.push({
        source_file: filePath,
        target_file: null,
        target_module: imp.source,
        import_type: imp.importType,
        imported_names: imp.names.length > 0 ? JSON.stringify(imp.names) : null,
        line_number: imp.line,
        is_resolved: false
      })
    }
  }

  return { node, edges }
}

/**
 * Update dependency graph for a single file (incremental)
 */
export async function updateDependencyGraphForFile(
  projectRoot: string,
  collectionId: string,
  filePath: string
): Promise<void> {
  // Delete old data for this file
  await deleteFileFromGraph(collectionId, filePath)

  // Process the file and add new data
  try {
    const result = await processFile(projectRoot, filePath)
    if (result) {
      await saveNodes(collectionId, [result.node])
      if (result.edges.length > 0) {
        await saveEdges(collectionId, result.edges)
      }
    }
  } catch (error) {
    console.error(`Error updating dependency graph for ${filePath}:`, error)
  }
}
