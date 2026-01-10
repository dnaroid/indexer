import type { ToolHandlersDeps } from '../common/types.js'
import {
  getEdgesBySource,
  getEdgesByPathPrefix,
  getNodesByCollection,
  type DependencyEdge,
  type DependencyNode
} from '../../utils/dependency-graph-db.js'

interface GraphNode {
  id: string
  module: string
  lang: string
  isExternal: boolean
  packageName?: string
}

interface GraphEdge {
  source: string
  target: string
  importType: string
  names?: string[]
}

interface DependencyGraphResult {
  nodes: GraphNode[]
  edges: GraphEdge[]
  stats: {
    totalNodes: number
    totalEdges: number
    externalNodes: number
  }
}

/**
 * Build dependency graph using BFS with maxDepth limit
 */
async function buildGraph(
  collectionId: string,
  startFiles: string[],
  maxDepth: number,
  includeExternal: boolean
): Promise<DependencyGraphResult> {
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const visited = new Set<string>()

  interface QueueItem {
    filePath: string
    depth: number
  }

  const queue: QueueItem[] = startFiles.map((f) => ({ filePath: f, depth: 0 }))

  // Get all nodes for external dependencies lookup
  const allNodes = await getNodesByCollection(collectionId)
  const nodeMap = new Map<string, DependencyNode>()
  for (const node of allNodes) {
    nodeMap.set(node.file_path, node)
  }

  while (queue.length > 0) {
    const { filePath, depth } = queue.shift()!

    if (visited.has(filePath) || depth > maxDepth) {
      continue
    }

    visited.add(filePath)

    // Add node
    const nodeData = nodeMap.get(filePath)
    if (nodeData) {
      nodes.set(filePath, {
        id: filePath,
        module: nodeData.module_path,
        lang: nodeData.lang,
        isExternal: nodeData.is_external,
        packageName: nodeData.package_name || undefined
      })
    }

    // Get outgoing edges
    const outgoingEdges = await getEdgesBySource(collectionId, filePath)

    for (const edge of outgoingEdges) {
      const targetFile = edge.target_file

      // Handle unresolved or external imports
      if (!targetFile) {
        if (includeExternal) {
          // Create synthetic node for external dependency
          const externalId = edge.target_module
          if (!nodes.has(externalId)) {
            nodes.set(externalId, {
              id: externalId,
              module: edge.target_module,
              lang: 'external',
              isExternal: true
            })
          }

          edges.push({
            source: filePath,
            target: externalId,
            importType: edge.import_type,
            names: edge.imported_names ? JSON.parse(edge.imported_names) : undefined
          })
        }
        continue
      }

      // Add edge
      edges.push({
        source: filePath,
        target: targetFile,
        importType: edge.import_type,
        names: edge.imported_names ? JSON.parse(edge.imported_names) : undefined
      })

      // Add target to queue if not visited
      if (!visited.has(targetFile) && depth < maxDepth) {
        queue.push({ filePath: targetFile, depth: depth + 1 })
      }
    }
  }

  const nodesArray = Array.from(nodes.values())
  const externalNodes = nodesArray.filter((n) => n.isExternal).length

  return {
    nodes: nodesArray,
    edges,
    stats: {
      totalNodes: nodesArray.length,
      totalEdges: edges.length,
      externalNodes
    }
  }
}

/**
 * Get dependency graph MCP tool handler
 */
export async function getDependencyGraph(
  deps: ToolHandlersDeps,
  {
    collectionId,
    path: startPath,
    path_prefix: pathPrefix,
    maxDepth = 3,
    includeExternal = false
  }: {
    collectionId?: string
    path?: string
    path_prefix?: string
    maxDepth?: number
    includeExternal?: boolean
  }
) {
  if (!collectionId) {
    throw new Error('collectionId is required')
  }

  let startFiles: string[] = []

  if (startPath) {
    // Start from specific file
    startFiles = [startPath]
  } else if (pathPrefix) {
    // Start from all files matching prefix
    const edges = await getEdgesByPathPrefix(collectionId, pathPrefix)
    const uniqueFiles = new Set(edges.map((e) => e.source_file))
    startFiles = Array.from(uniqueFiles)
  } else {
    // No start point specified - return all nodes and edges
    const allNodes = await getNodesByCollection(collectionId)
    const allEdges: DependencyEdge[] = []

    for (const node of allNodes) {
      const edges = await getEdgesBySource(collectionId, node.file_path)
      allEdges.push(...edges)
    }

    const nodes: GraphNode[] = allNodes.map((n) => ({
      id: n.file_path,
      module: n.module_path,
      lang: n.lang,
      isExternal: n.is_external,
      packageName: n.package_name || undefined
    }))

    const edges: GraphEdge[] = allEdges
      .filter((e) => includeExternal || e.target_file !== null)
      .map((e) => ({
        source: e.source_file,
        target: e.target_file || e.target_module,
        importType: e.import_type,
        names: e.imported_names ? JSON.parse(e.imported_names) : undefined
      }))

    const externalNodes = nodes.filter((n) => n.isExternal).length

    const result = {
      nodes,
      edges,
      stats: {
        totalNodes: nodes.length,
        totalEdges: edges.length,
        externalNodes
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    }
  }

  // Build graph from start files
  const result = await buildGraph(collectionId, startFiles, maxDepth, includeExternal)

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }
    ]
  }
}
