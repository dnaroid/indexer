import path from 'path'
import { fileURLToPath } from 'url'
import { Parser, Language } from 'web-tree-sitter'
import type { SymbolInfo } from '../types/index.js'

type SyntaxNode = any
type Point = any

let ready = false
let parser: any
const languages: Partial<Record<SupportedLanguage, any>> = {}

type SupportedLanguage = 'python' | 'csharp'

export async function initTreeSitter(): Promise<void> {
  if (ready) {
    return
  }
  // Initialize WASM before creating parser
  await Parser.init()
  parser = new Parser()
  ready = true
  // Languages are loaded lazily on demand
}

async function loadLanguage(lang: SupportedLanguage): Promise<any> {
  if (languages[lang]) {
    return languages[lang]
  }

  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const base = path.join(__dirname, 'grammars')

  const langMap: Record<SupportedLanguage, string> = {
    python: 'python.wasm',
    csharp: 'csharp.wasm'
  }

  if (!langMap[lang]) {
    throw new Error(`Unsupported language: ${lang}`)
  }

  const wasmPath = path.join(base, langMap[lang])
  const loadedLang = await Language.load(wasmPath)
  languages[lang] = loadedLang
  return loadedLang as any
}

function walk(node: SyntaxNode, cb: (node: SyntaxNode) => void): void {
  cb(node)
  for (let i = 0; i < node.childCount; i++) {
    walk(node.child(i)!, cb)
  }
}

function collectReferences(node: SyntaxNode, symbols: Partial<SymbolInfo>[]): void {
  if (node.type === 'identifier' || node.type === 'type_identifier' || node.type === 'field_identifier') {
    symbols.push({
      name: node.text,
      kind: 'reference',
      line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      column: node.startPosition.column + 1
    })
  }
  for (let i = 0; i < node.childCount; i++) {
    collectReferences(node.child(i)!, symbols)
  }
}

/*
  -------- Python --------
*/
export async function extractPythonSymbols(code: string): Promise<Partial<SymbolInfo>[]> {
  const symbols: Partial<SymbolInfo>[] = []
  const lang = await loadLanguage('python')
  parser.setLanguage(lang)
  const tree = parser.parse(code)
  if (!tree) return []
  collectReferences(tree.rootNode, symbols)

  walk(tree.rootNode, (n) => {
    if (n.type === 'function_definition') {
      const name = n.childForFieldName('name')?.text
      if (name) {
        symbols.push({
          name,
          kind: 'function',
          line: n.startPosition.row + 1,
          end_line: n.endPosition.row + 1
        })
      }
    }

    if (n.type === 'class_definition') {
      const name = n.childForFieldName('name')?.text
      if (name) {
        symbols.push({
          name,
          kind: 'class',
          line: n.startPosition.row + 1,
          end_line: n.endPosition.row + 1
        })
      }
    }
  })

  return symbols
}

// -----------------------------------------------------------------------

function hasAttribute(node: SyntaxNode, names: string[]): boolean {
  const attrs = node.children.filter((c: any) => c.type === 'attribute_list')
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

function hasModifier(node: SyntaxNode, modifier: string): boolean {
  return node.children.some(
    (c: any) => c.type === 'modifier' && c.text === modifier
  )
}

function extendsScriptableObject(node: SyntaxNode): boolean {
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
export async function extractCSharpSymbols(code: string): Promise<Partial<SymbolInfo>[]> {
  const symbols: Partial<SymbolInfo>[] = []

  const lang = await loadLanguage('csharp')
  parser.setLanguage(lang)
  const tree = parser.parse(code)
  if (!tree) return []
  collectReferences(tree.rootNode, symbols)

  function csharpWalk(node: SyntaxNode) {
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
        line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1
      })
    }

    // ----- STRUCT -----
    if (node.type === 'struct_declaration') {
      const name = node.childForFieldName('name')?.text
      if (name) {
        symbols.push({
          name,
          kind: 'struct',
          line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1
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
          line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1
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
          line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1
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
      let parent: SyntaxNode | null = node.parent
      let className: string | undefined = undefined
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
        line: node.startPosition.row + 1,
        end_line: node.endPosition.row + 1
      })
    }

    // property
    if (node.type === 'property_declaration') {
      const name = node.childForFieldName('name')?.text
      if (name) {
        symbols.push({
          name,
          kind: 'property',
          line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1
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
        let parent: SyntaxNode | null = node.parent
        let className: string | undefined = undefined
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
          line: node.startPosition.row + 1,
          end_line: node.endPosition.row + 1
        })
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      csharpWalk(node.child(i)!)
    }
  }

  csharpWalk(tree.rootNode)
  return symbols
}

export async function isCodeAtPosition(code: string, langName: string, line: number, column: number): Promise<boolean> {
  if (!ready || !['python', 'csharp'].includes(langName)) {
    return true
  }

  const lang = await loadLanguage(langName as SupportedLanguage)
  parser.setLanguage(lang)
  const tree = parser.parse(code)
  if (!tree) return true

  // Tree-sitter uses 0-based indexing
  const point: Point = { row: line - 1, column: column }
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

export interface ImportInfo {
  source: string
  importType: 'import' | 'from' | 'using' | 'using_static'
  names: string[]
  line: number
  isTypeOnly: boolean
}

/**
 * Extract import statements from Python source
 */
export async function extractPythonImports(code: string): Promise<ImportInfo[]> {
  const imports: ImportInfo[] = []

  const lang = await loadLanguage('python')
  parser.setLanguage(lang)
  const tree = parser.parse(code)
  if (!tree) return imports

  walk(tree.rootNode, (node) => {
    // import module1, module2
    if (node.type === 'import_statement') {
      const line = node.startPosition.row + 1
      const nameNodes = node.descendantsOfType('dotted_name').concat(node.descendantsOfType('aliased_import'))

      for (const nameNode of nameNodes) {
        let moduleName = ''
        let alias = ''

        if (nameNode.type === 'dotted_name') {
          moduleName = nameNode.text
        } else if (nameNode.type === 'aliased_import') {
          const nameChild = nameNode.childForFieldName('name')
          const aliasChild = nameNode.childForFieldName('alias')
          moduleName = nameChild?.text || ''
          alias = aliasChild?.text || moduleName
        }

        if (moduleName) {
          imports.push({
            source: moduleName,
            importType: 'import',
            names: [alias || moduleName],
            line,
            isTypeOnly: false
          })
        }
      }
    }

    // from module import name1, name2
    if (node.type === 'import_from_statement') {
      const line = node.startPosition.row + 1
      const moduleNode = node.childForFieldName('module_name')
      const moduleName = moduleNode?.text || ''

      // Handle relative imports: from . import X, from .. import Y
      const dots = node.children.filter((c: any) => c.text === '.' || c.text === '...')
      const relativePrefix = dots.map((d: any) => d.text).join('')

      const source = relativePrefix + moduleName

      // Extract imported names
      const names: string[] = []
      const wildcardImport = node.children.some((c: any) => c.text === '*')

      if (wildcardImport) {
        imports.push({
          source,
          importType: 'from',
          names: ['*'],
          line,
          isTypeOnly: false
        })
      } else {
        const importedNames = node.descendantsOfType('dotted_name').concat(node.descendantsOfType('aliased_import'))

        for (const nameNode of importedNames) {
          if (nameNode.type === 'dotted_name') {
            // Skip if this is the module name itself
            if (nameNode.equals(moduleNode)) continue
            names.push(nameNode.text)
          } else if (nameNode.type === 'aliased_import') {
            const aliasChild = nameNode.childForFieldName('alias')
            names.push(aliasChild?.text || nameNode.childForFieldName('name')?.text || '')
          }
        }

        if (names.length > 0) {
          imports.push({
            source,
            importType: 'from',
            names,
            line,
            isTypeOnly: false
          })
        }
      }
    }
  })

  return imports
}

/**
 * Extract using directives from C# source
 */
export async function extractCSharpImports(code: string): Promise<ImportInfo[]> {
  const imports: ImportInfo[] = []

  const lang = await loadLanguage('csharp')
  parser.setLanguage(lang)
  const tree = parser.parse(code)
  if (!tree) return imports

  walk(tree.rootNode, (node) => {
    // using System;
    // using System.Collections.Generic;
    if (node.type === 'using_directive') {
      const line = node.startPosition.row + 1

      // Check if it's a static using
      const isStatic = node.children.some((c: any) => c.text === 'static')

      // Extract the namespace/type name
      const nameNode = node.descendantsOfType('qualified_name')[0] ||
                       node.descendantsOfType('identifier')[0]

      if (nameNode) {
        const namespaceName = nameNode.text

        imports.push({
          source: namespaceName,
          importType: isStatic ? 'using_static' : 'using',
          names: [],
          line,
          isTypeOnly: false
        })
      }
    }
  })

  return imports
}
