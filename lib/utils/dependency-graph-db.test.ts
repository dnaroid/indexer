import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  saveNode,
  saveEdge,
  saveNodes,
  saveEdges,
  getNodesByCollection,
  getEdgesBySource,
  getEdgesByTarget,
  getEdgesByPathPrefix,
  deleteFileFromGraph,
  clearGraph,
  closeDb
} from './dependency-graph-db.js'

const testCollectionId = 'test_collection_' + Date.now()

test('dependency-graph-db: save and retrieve node', async () => {
  const node = {
    file_path: 'src/index.ts',
    module_path: 'src/index.ts',
    lang: 'typescript',
    is_external: false,
    package_name: null,
    hash: 'abc123'
  }

  await saveNode(testCollectionId, node)

  const nodes = await getNodesByCollection(testCollectionId)
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].file_path, 'src/index.ts')
  assert.equal(nodes[0].lang, 'typescript')
  assert.equal(nodes[0].is_external, false)

  await clearGraph(testCollectionId)
})

test('dependency-graph-db: save and retrieve edge', async () => {
  const edge = {
    source_file: 'src/index.ts',
    target_file: 'src/utils.ts',
    target_module: './utils',
    import_type: 'named',
    imported_names: JSON.stringify(['helper1', 'helper2']),
    line_number: 5,
    is_resolved: true
  }

  await saveEdge(testCollectionId, edge)

  const edges = await getEdgesBySource(testCollectionId, 'src/index.ts')
  assert.equal(edges.length, 1)
  assert.equal(edges[0].source_file, 'src/index.ts')
  assert.equal(edges[0].target_file, 'src/utils.ts')
  assert.equal(edges[0].import_type, 'named')
  assert.equal(edges[0].is_resolved, true)

  const names = JSON.parse(edges[0].imported_names!)
  assert.deepEqual(names, ['helper1', 'helper2'])

  await clearGraph(testCollectionId)
})

test('dependency-graph-db: batch save nodes', async () => {
  const nodes = [
    {
      file_path: 'src/index.ts',
      module_path: 'src/index.ts',
      lang: 'typescript',
      is_external: false,
      package_name: null,
      hash: 'abc123'
    },
    {
      file_path: 'src/utils.ts',
      module_path: 'src/utils.ts',
      lang: 'typescript',
      is_external: false,
      package_name: null,
      hash: 'def456'
    },
    {
      file_path: 'react',
      module_path: 'react',
      lang: 'external',
      is_external: true,
      package_name: 'react',
      hash: 'external'
    }
  ]

  await saveNodes(testCollectionId, nodes)

  const savedNodes = await getNodesByCollection(testCollectionId)
  assert.equal(savedNodes.length, 3)

  const externalNodes = savedNodes.filter((n) => n.is_external)
  assert.equal(externalNodes.length, 1)
  assert.equal(externalNodes[0].package_name, 'react')

  await clearGraph(testCollectionId)
})

test('dependency-graph-db: batch save edges', async () => {
  const edges = [
    {
      source_file: 'src/index.ts',
      target_file: 'src/utils.ts',
      target_module: './utils',
      import_type: 'named',
      imported_names: JSON.stringify(['helper1']),
      line_number: 5,
      is_resolved: true
    },
    {
      source_file: 'src/index.ts',
      target_file: null,
      target_module: 'react',
      import_type: 'default',
      imported_names: JSON.stringify(['React']),
      line_number: 1,
      is_resolved: false
    }
  ]

  await saveEdges(testCollectionId, edges)

  const savedEdges = await getEdgesBySource(testCollectionId, 'src/index.ts')
  assert.equal(savedEdges.length, 2)

  const resolvedEdges = savedEdges.filter((e) => e.is_resolved)
  assert.equal(resolvedEdges.length, 1)

  const unresolvedEdges = savedEdges.filter((e) => !e.is_resolved)
  assert.equal(unresolvedEdges.length, 1)
  assert.equal(unresolvedEdges[0].target_file, null)

  await clearGraph(testCollectionId)
})

test('dependency-graph-db: get reverse dependencies', async () => {
  const edges = [
    {
      source_file: 'src/index.ts',
      target_file: 'src/utils.ts',
      target_module: './utils',
      import_type: 'named',
      imported_names: null,
      line_number: 5,
      is_resolved: true
    },
    {
      source_file: 'src/components/Button.tsx',
      target_file: 'src/utils.ts',
      target_module: '../utils',
      import_type: 'named',
      imported_names: null,
      line_number: 3,
      is_resolved: true
    }
  ]

  await saveEdges(testCollectionId, edges)

  const reverseDeps = await getEdgesByTarget(testCollectionId, 'src/utils.ts')
  assert.equal(reverseDeps.length, 2)

  const sources = reverseDeps.map((e) => e.source_file).sort()
  assert.deepEqual(sources, ['src/components/Button.tsx', 'src/index.ts'])

  await clearGraph(testCollectionId)
})

test('dependency-graph-db: get edges by path prefix', async () => {
  const edges = [
    {
      source_file: 'src/components/Button.tsx',
      target_file: 'src/utils.ts',
      target_module: '../utils',
      import_type: 'named',
      imported_names: null,
      line_number: 3,
      is_resolved: true
    },
    {
      source_file: 'src/components/Input.tsx',
      target_file: 'src/utils.ts',
      target_module: '../utils',
      import_type: 'named',
      imported_names: null,
      line_number: 2,
      is_resolved: true
    },
    {
      source_file: 'src/index.ts',
      target_file: 'src/utils.ts',
      target_module: './utils',
      import_type: 'named',
      imported_names: null,
      line_number: 5,
      is_resolved: true
    }
  ]

  await saveEdges(testCollectionId, edges)

  const componentEdges = await getEdgesByPathPrefix(testCollectionId, 'src/components/')
  assert.equal(componentEdges.length, 2)

  const sources = componentEdges.map((e) => e.source_file).sort()
  assert.deepEqual(sources, ['src/components/Button.tsx', 'src/components/Input.tsx'])

  await clearGraph(testCollectionId)
})

test('dependency-graph-db: delete file from graph', async () => {
  const node = {
    file_path: 'src/index.ts',
    module_path: 'src/index.ts',
    lang: 'typescript',
    is_external: false,
    package_name: null,
    hash: 'abc123'
  }

  const edge = {
    source_file: 'src/index.ts',
    target_file: 'src/utils.ts',
    target_module: './utils',
    import_type: 'named',
    imported_names: null,
    line_number: 5,
    is_resolved: true
  }

  await saveNode(testCollectionId, node)
  await saveEdge(testCollectionId, edge)

  let nodes = await getNodesByCollection(testCollectionId)
  let edges = await getEdgesBySource(testCollectionId, 'src/index.ts')
  assert.equal(nodes.length, 1)
  assert.equal(edges.length, 1)

  await deleteFileFromGraph(testCollectionId, 'src/index.ts')

  nodes = await getNodesByCollection(testCollectionId)
  edges = await getEdgesBySource(testCollectionId, 'src/index.ts')
  assert.equal(nodes.length, 0)
  assert.equal(edges.length, 0)

  await clearGraph(testCollectionId)
})

test('dependency-graph-db: clear graph', async () => {
  const nodes = [
    {
      file_path: 'src/index.ts',
      module_path: 'src/index.ts',
      lang: 'typescript',
      is_external: false,
      package_name: null,
      hash: 'abc123'
    },
    {
      file_path: 'src/utils.ts',
      module_path: 'src/utils.ts',
      lang: 'typescript',
      is_external: false,
      package_name: null,
      hash: 'def456'
    }
  ]

  const edges = [
    {
      source_file: 'src/index.ts',
      target_file: 'src/utils.ts',
      target_module: './utils',
      import_type: 'named',
      imported_names: null,
      line_number: 5,
      is_resolved: true
    }
  ]

  await saveNodes(testCollectionId, nodes)
  await saveEdges(testCollectionId, edges)

  let savedNodes = await getNodesByCollection(testCollectionId)
  let savedEdges = await getEdgesBySource(testCollectionId, 'src/index.ts')
  assert.equal(savedNodes.length, 2)
  assert.equal(savedEdges.length, 1)

  await clearGraph(testCollectionId)

  savedNodes = await getNodesByCollection(testCollectionId)
  savedEdges = await getEdgesBySource(testCollectionId, 'src/index.ts')
  assert.equal(savedNodes.length, 0)
  assert.equal(savedEdges.length, 0)
})

// Cleanup after all tests
test.after(() => {
  closeDb()
})
