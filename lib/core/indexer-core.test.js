import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {initTreeSitter} from '../utils/tree-sitter.js'
import {indexFile, setFetch} from './indexer-core.js'

const VECTOR_SIZE = 3

function createFetchMock(record) {
  return async function fetch(url, options = {}) {
    record.fetchCalls.push({url, options})

    if (url.includes('/api/embeddings')) {
      return {
        ok: true,
        json: async () => ({embedding: Array(VECTOR_SIZE).fill(0.5)}),
        text: async () => ''
      }
    }

    if (options?.body) {
      try {
        const parsed = JSON.parse(options.body)
        if (parsed.points && url.includes('/collections/project_index/points?wait=true')) {
          record.chunkPoints = parsed.points
        }
        if (parsed.points && url.includes('/collections/project_index__meta/points?wait=true')) {
          record.metaPoints = parsed.points
        }
      } catch {
        // ignore JSON parse errors in tests
      }
    }

    return {
      ok: true,
      json: async () => ({result: []}),
      text: async () => ''
    }
  }
}

const FIXTURES_DIR = path.resolve(process.cwd(), 'lib/utils/test_fixtures')

function sortedUnique(values) {
  return Array.from(new Set(values)).sort()
}

function assertSetEqual(actual, expected, message) {
  assert.deepEqual(sortedUnique(actual), sortedUnique(expected), message)
}

async function setupLanguageTest({ext}) {
  const relPath = `sample${ext}`

  process.env.WORKSPACE_DIR = FIXTURES_DIR
  process.env.VECTOR_SIZE = String(VECTOR_SIZE)
  process.env.QDRANT_COLLECTION = 'project_index'

  const record = {fetchCalls: [], chunkPoints: null, metaPoints: null}

  // Inject the mock
  setFetch(createFetchMock(record))

  return {relPath, record}
}

test.before(async () => {
  await initTreeSitter()
})

test.afterEach(() => {
  delete process.env.WORKSPACE_DIR
  delete process.env.QDRANT_COLLECTION
  delete process.env.VECTOR_SIZE
})

async function runLanguageCase({ext, lang, expectedNames, expectedKinds, expectedUnityTags, unexpectedNames}) {
  const {relPath, record} = await setupLanguageTest({ext})

  const res = await indexFile(relPath)

  assert.equal(res.indexed, true)
  assert.ok(Array.isArray(record.chunkPoints), 'points were upserted')

  const payload = record.chunkPoints[0].payload

  assert.equal(payload.lang, lang)
  assertSetEqual(payload.symbol_names, expectedNames, 'symbol names should match expected set')
  assertSetEqual(payload.symbol_kinds, expectedKinds, 'symbol kinds should match expected set')
  if (expectedUnityTags) {
    assertSetEqual(payload.unity_tags, expectedUnityTags, 'unity tags should match expected set')
  }
  if (unexpectedNames?.length) {
    for (const name of unexpectedNames) {
      assert.ok(!payload.symbol_names.includes(name), `unexpected symbol name: ${name}`)
    }
  }
}

test('JavaScript parsing captures functions, classes, and methods', async () => {
  await runLanguageCase({
    ext: '.js',
    lang: 'javascript',
    expectedNames: [
      'foo',
      'main',
      'Widget',
      'Widget.id',
      'Widget.#secret',
      'Widget.status',
      'Widget.render'
    ],
    expectedKinds: ['function', 'default_export', 'class', 'property', 'private_field', 'accessor', 'method']
  })
})

test('TypeScript parsing captures functions, classes, and methods', async () => {
  await runLanguageCase({
    ext: '.ts',
    lang: 'typescript',
    expectedNames: [
      'Runner',
      'UserId',
      'Status',
      'Core',
      'Core.Sub',
      'Version',
      'Name',
      'DEFAULT_TIMEOUT',
      'build',
      'createDefault',
      'Service',
      'Service.id',
      'Service.#secret',
      'Service.status',
      'Service.run'
    ],
    expectedKinds: [
      'interface',
      'type',
      'enum',
      'namespace',
      'const',
      'function',
      'default_export',
      'class',
      'property',
      'private_field',
      'accessor',
      'method'
    ]
  })
})

test('TSX parsing captures functions, classes, and methods', async () => {
  await runLanguageCase({
    ext: '.tsx',
    lang: 'typescript',
    expectedNames: ['Props', 'App', 'useFeature', 'View', 'View.render'],
    expectedKinds: ['type', 'function_component', 'hook', 'class', 'method']
  })
})

test('Python parsing captures functions and classes', async () => {
  await runLanguageCase({
    ext: '.py',
    lang: 'python',
    expectedNames: ['py_func', 'Helper', 'do_work'],
    expectedKinds: ['function', 'class']
  })
})

test('C# parsing captures Unity structures, fields, and lifecycle methods', async () => {
  await runLanguageCase({
    ext: '.cs',
    lang: 'csharp',
    expectedNames: [
      'Player',
      'Settings',
      'Point',
      'IRunnable',
      'State',
      'Run',
      'X',
      'Score',
      'Player.Fire',
      'Player.Update',
      'Player.Health',
      'Player.speed'
    ],
    expectedKinds: [
      'class',
      'scriptable_object',
      'struct',
      'interface',
      'enum',
      'property',
      'method',
      'unity_lifecycle',
      'serialized_field'
    ],
    expectedUnityTags: ['lifecycle', 'serialized_field', 'scriptable_object'],
    unexpectedNames: ['Player.Global', 'Player.DebugValue', 'Player.Hidden']
  })
})
