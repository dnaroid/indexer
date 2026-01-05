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

  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const base = path.join(__dirname, 'grammars')

  languages.python = await Language.load(path.join(base, 'python.wasm'))
  languages.go = await Language.load(path.join(base, 'go.wasm'))
  languages.rust = await Language.load(path.join(base, 'rust.wasm'))
  languages.csharp = await Language.load(path.join(base, 'csharp.wasm'))

  ready = true
}

function walk(node, cb) {
  cb(node)
  for (let i = 0; i < node.childCount; i++) {
    walk(node.child(i), cb)
  }
}

/*
  -------- Python --------
*/
export function extractPythonSymbols(code) {
  const symbols = []
  parser.setLanguage(languages.python)
  const tree = parser.parse(code)

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

/*
  -------- Go --------
*/
export function extractGoSymbols(code) {
  const symbols = []
  parser.setLanguage(languages.go)
  const tree = parser.parse(code)

  walk(tree.rootNode, (n) => {
    if (n.type === 'function_declaration') {
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

    if (n.type === 'method_declaration') {
      const name = n.childForFieldName('name')?.text
      if (name) {
        symbols.push({
          name,
          kind: 'method',
          start: n.startPosition.row + 1,
          end: n.endPosition.row + 1
        })
      }
    }

    if (n.type === 'type_declaration') {
      const spec = n.descendantsOfType('type_spec')[0]
      const name = spec?.childForFieldName('name')?.text
      if (name) {
        symbols.push({
          name,
          kind: 'type',
          start: n.startPosition.row + 1,
          end: n.endPosition.row + 1
        })
      }
    }
  })

  return symbols
}

/*
  -------- Rust --------
*/
export function extractRustSymbols(code) {
  const symbols = []
  parser.setLanguage(languages.rust)
  const tree = parser.parse(code)

  walk(tree.rootNode, (n) => {
    if (n.type === 'function_item') {
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

    if (n.type === 'struct_item') {
      const name = n.childForFieldName('name')?.text
      if (name) {
        symbols.push({
          name,
          kind: 'struct',
          start: n.startPosition.row + 1,
          end: n.endPosition.row + 1
        })
      }
    }

    if (n.type === 'impl_item') {
      const typeName = n.childForFieldName('type')?.text
      const fns = n.descendantsOfType('function_item')
      for (const fn of fns) {
        const fnName = fn.childForFieldName('name')?.text
        if (fnName && typeName) {
          symbols.push({
            name: `${typeName}.${fnName}`,
            kind: 'method',
            start: fn.startPosition.row + 1,
            end: fn.endPosition.row + 1
          })
        }
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
export function extractCSharpSymbols(code) {
  const symbols = []

  parser.setLanguage(languages.csharp)
  const tree = parser.parse(code)

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
