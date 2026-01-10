import type { ToolHandlersDeps } from '../common/types.js'
import {
  getEdgesByTarget,
  getNodesByCollection,
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
 * Build reverse dependency graph using BFS with maxDepth limit
 */
async function buildReverseGraph(
  collectionId: string,
  targetFile: string,
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

  const queue: QueueItem[] = [{ filePath: targetFile, depth: 0 }]

  // Get all nodes for lookup
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
    } else {
      // Target file might not have a node if it has no imports
      nodes.set(filePath, {
        id: filePath,
        module: filePath,
        lang: 'unknown',
        isExternal: false
      })
    }

    // Get incoming edges (who depends on this file)
    const incomingEdges = await getEdgesByTarget(collectionId, filePath)

    for (const edge of incomingEdges) {
      const sourceFile = edge.source_file

      // Add edge (reverse direction for reverse dependencies)
      edges.push({
        source: sourceFile,
        target: filePath,
        importType: edge.import_type,
        names: edge.imported_names ? JSON.parse(edge.imported_names) : undefined
      })

      // Add source to queue if not visited
      if (!visited.has(sourceFile) && depth < maxDepth) {
        queue.push({ filePath: sourceFile, depth: depth + 1 })
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
 * Get reverse dependencies MCP tool handler
 */
export async function getReverseDependencies(
  deps: ToolHandlersDeps,
  {
    collectionId,
    path,
    maxDepth = 3,
    includeExternal = false
  }: {
    collectionId?: string
    path: string
    maxDepth?: number
    includeExternal?: boolean
  }
) {
  if (!collectionId) {
    throw new Error('collectionId is required')
  }

  if (!path) {
    throw new Error('path is required')
  }

  // Build reverse dependency graph
  const result = await buildReverseGraph(collectionId, path, maxDepth, includeExternal)

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }
    ]
  }
}
