import path from 'path'
import {fileURLToPath} from 'url'
import {Parser, Language} from 'web-tree-sitter'

let ready = false
let parser
const languages = {}

export async function initTreeSitter() {
  if (ready) {
    return
  }
  await Parser.init()
  parser = new Parser()
  ready = true
  // Languages are loaded lazily on demand
}

async function loadLanguage(lang) {
  if (languages[lang]) {
    return languages[lang]
  }

  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const base = path.join(__dirname, 'grammars')

  const langMap = {
    python: 'python.wasm',
    csharp: 'csharp.wasm'
  }

  if (!langMap[lang]) {
    throw new Error(`Unsupported language: ${lang}`)
  }

  const wasmPath = path.join(base, langMap[lang])
  languages[lang] = await Language.load(wasmPath)
  return languages[lang]
}

function walk(node, cb) {
  cb(node)
  for (let i = 0; i < node.childCount; i++) {
    walk(node.child(i), cb)
  }
}

function collectReferences(node, symbols) {
  if (node.type === 'identifier' || node.type === 'type_identifier' || node.type === 'field_identifier') {
    symbols.push({
      name: node.text,
      kind: 'reference',
      start: node.startPosition.row + 1,
      end: node.endPosition.row + 1,
      column: node.startPosition.column + 1
    })
  }
  for (let i = 0; i < node.childCount; i++) {
    collectReferences(node.child(i), symbols)
  }
}

/*
  -------- Python --------
*/
export async function extractPythonSymbols(code) {
  const symbols = []
  const lang = await loadLanguage('python')
  parser.setLanguage(lang)
  const tree = parser.parse(code)
  collectReferences(tree.rootNode, symbols)

  walk(tree.rootNode, (n) => {
    if (n.type === 'function_definition') {
      const name = n.childForFieldName('name')?.text
      if (name) {
        symbols.push({
          name,
          kind: 'function',
          start: n.startPosition.row + 1,
          end: n.endPosition.row + 1
        })
      }
    }

    if (n.type === 'class_definition') {
      const name = n.childForFieldName('name')?.text
      if (name) {
        symbols.push({
          name,
          kind: 'class',
          start: n.startPosition.row + 1,
          end: n.endPosition.row + 1
        })
      }
    }
  })

  return symbols
}

// -----------------------------------------------------------------------

function hasAttribute(node, names) {
  const attrs = node.children.filter(c => c.type === 'attribute_list')
  for (const attr of attrs) {
    const text = attr.text
    for (const n of names) {
      if (text.includes(n)) {
        return true
      }
    }
  }
  return false
}

function hasModifier(node, modifier) {
  return node.children.some(
    c => c.type === 'modifier' && c.text === modifier
  )
}

function extendsScriptableObject(node) {
  const base = node.childForFieldName('base_list')
  if (!base) {
    return false
  }
  return base.text.includes('ScriptableObject')
}

const UNITY_LIFECYCLE = new Set([
  'Awake',
  'OnEnable',
  'Start',
  'Update',
  'LateUpdate',
  'FixedUpdate',
  'OnTriggerEnter',
  'OnTriggerExit',
  'OnTriggerStay',
  'OnCollisionEnter',
  'OnCollisionExit',
  'OnCollisionStay',
  'OnDisable',
  'OnDestroy',
  'OnBecameVisible',
  'OnBecameInvisible',
  'OnGUI'
])

/*
  -------- C# --------
*/
export async function extractCSharpSymbols(code) {
  const symbols = []

  const lang = await loadLanguage('csharp')
  parser.setLanguage(lang)
  const tree = parser.parse(code)
  collectReferences(tree.rootNode, symbols)

  function walk(node) {
    // ----- CLASS -----
    if (node.type === 'class_declaration') {
      const name = node.childForFieldName('name')?.text
      if (!name) {
        return
      }

      const isScriptable =
        extendsScriptableObject(node) ||
        hasAttribute(node, ['CreateAssetMenu'])

      symbols.push({
        name,
        kind: isScriptable ? 'scriptable_object' : 'class',
        start: node.startPosition.row + 1,
        end: node.endPosition.row + 1
      })
    }

    // ----- STRUCT -----
    if (node.type === 'struct_declaration') {
      const name = node.childForFieldName('name')?.text
      if (name) {
        symbols.push({
          name,
          kind: 'struct',
          start: node.startPosition.row + 1,
          end: node.endPosition.row + 1
        })
      }
    }

    // ----- INTERFACE -----
    if (node.type === 'interface_declaration') {
      const name = node.childForFieldName('name')?.text
      if (name) {
        symbols.push({
          name,
          kind: 'interface',
          start: node.startPosition.row + 1,
          end: node.endPosition.row + 1
        })
      }
    }

    // enum
    if (node.type === 'enum_declaration') {
      const name = node.childForFieldName('name')?.text
      if (name) {
        symbols.push({
          name,
          kind: 'enum',
          start: node.startPosition.row + 1,
          end: node.endPosition.row + 1
        })
      }
    }

    // method
    if (node.type === 'method_declaration') {
      const methodName = node.childForFieldName('name')?.text
      if (!methodName) {
        return
      }

      // Find enclosing class
      let parent = node.parent
      let className = null
      while (parent) {
        if (parent.type === 'class_declaration') {
          className = parent.childForFieldName('name')?.text
          break
        }
        parent = parent.parent
      }

      const isUnityLifecycle = UNITY_LIFECYCLE.has(methodName)

      symbols.push({
        name: className ? `${className}.${methodName}` : methodName,
        kind: isUnityLifecycle ? 'unity_lifecycle' : 'method',
        start: node.startPosition.row + 1,
        end: node.endPosition.row + 1
      })
    }

    // property
    if (node.type === 'property_declaration') {
      const name = node.childForFieldName('name')?.text
      if (name) {
        symbols.push({
          name,
          kind: 'property',
          start: node.startPosition.row + 1,
          end: node.endPosition.row + 1
        })
      }
    }

    if (node.type === 'field_declaration') {
      const declarator = node.descendantsOfType('variable_declarator')[0]
      const fieldName = declarator?.childForFieldName('name')?.text
      if (!fieldName) {
        return
      }

      const isStatic = hasModifier(node, 'static')
      if (isStatic) {
        return
      }

      const nonSerialized = hasAttribute(node, ['NonSerialized', 'HideInInspector'])
      if (nonSerialized) {
        return
      }

      const isPublic = hasModifier(node, 'public')
      const hasSerializeField = hasAttribute(node, ['SerializeField'])

      if (isPublic || hasSerializeField) {
        // find enclosing class
        let parent = node.parent
        let className = null
        while (parent) {
          if (parent.type === 'class_declaration') {
            className = parent.childForFieldName('name')?.text
            break
          }
          parent = parent.parent
        }

        symbols.push({
          name: className ? `${className}.${fieldName}` : fieldName,
          kind: 'serialized_field',
          start: node.startPosition.row + 1,
          end: node.endPosition.row + 1
        })
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i))
    }
  }

  walk(tree.rootNode)
  return symbols
}

export async function isCodeAtPosition(code, langName, line, column) {
  if (!ready || !['python', 'csharp'].includes(langName)) {
    return true
  }

  const lang = await loadLanguage(langName)
  parser.setLanguage(lang)
  const tree = parser.parse(code)

  // Tree-sitter uses 0-based indexing
  const point = { row: line - 1, column: column }
  const node = tree.rootNode.descendantForPosition(point)

  if (!node) {
    return true
  }

  const type = node.type
  // Common node types for non-code across languages
  if (
    type.includes('comment') ||
    type.includes('string') ||
    type === 'character_literal'
  ) {
    return false
  }

  return true
}
