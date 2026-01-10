import { parse } from '@babel/parser'
import _traverse from '@babel/traverse'
import type { Node, NodePath } from '@babel/traverse'
import type { SymbolInfo } from '../types/index.js'

const traverse = (_traverse as any).default || _traverse

/*
  Extract symbols from JS / TS source
*/
export function extractJSSymbols(code: string): Partial<SymbolInfo>[] {
  const symbols: Partial<SymbolInfo>[] = []

  function hasJSX(node: any): boolean {
    if (!node || typeof node !== 'object') {
      return false
    }
    if (node.type === 'JSXElement' || node.type === 'JSXFragment') {
      return true
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (hasJSX(child)) return true
        }
      } else if (value && typeof value === 'object') {
        if (hasJSX(value)) return true
      }
    }
    return false
  }

  function isHookName(name: string): boolean {
    return /^use[A-Z0-9]/.test(name)
  }

  function getModuleName(path: any): string {
    const names: string[] = []
    let current = path
    while (current) {
      if (current.isTSModuleDeclaration && current.isTSModuleDeclaration()) {
        const id = current.node.id
        const name = id?.name || id?.value
        if (name) {
          names.push(name)
        }
      }
      current = current.parentPath
    }
    return names.reverse().join('.')
  }

  let ast: Node | null = null
  try {
    ast = parse(code, {
      sourceType: 'module',
      plugins: [
        'typescript',
        'jsx',
        'classProperties',
        'classPrivateProperties',
        'classPrivateMethods'
      ]
    })
  } catch {
    return symbols
  }

  traverse(ast, {
    FunctionDeclaration(path: NodePath<any>) {
      if (!path.node.id || !path.node.loc) return
      const name = path.node.id.name
      if (isHookName(name)) {
        symbols.push({
          name,
          kind: 'hook',
          line: path.node.loc.start.line,
          end_line: path.node.loc.end.line
        })
        return
      }
      if (hasJSX(path.node.body) && /^[A-Z]/.test(name)) {
        symbols.push({
          name,
          kind: 'function_component',
          line: path.node.loc.start.line,
          end_line: path.node.loc.end.line
        })
        return
      }
      symbols.push({
        name,
        kind: 'function',
        line: path.node.loc.start.line,
        end_line: path.node.loc.end.line
      })
    },

    ClassDeclaration(path: NodePath<any>) {
      if (!path.node.id || !path.node.loc) return
      symbols.push({
        name: path.node.id.name,
        kind: 'class',
        line: path.node.loc.start.line,
        end_line: path.node.loc.end.line
      })
    },

    ClassMethod(path: NodePath<any>) {
      if (!path.node.loc) return
      const cls = path.findParent((p: NodePath<any>) => p.isClassDeclaration())
      if (!cls || !(cls.node as any)?.id) {
        return
      }
      const isAccessor = path.node.kind === 'get' || path.node.kind === 'set'
      symbols.push({
        name: `${(cls.node as any).id.name}.${path.node.key.name}`,
        kind: isAccessor ? 'accessor' : 'method',
        line: path.node.loc.start.line,
        end_line: path.node.loc.end.line
      })
    },

    ClassProperty(path: NodePath<any>) {
      if (!path.node.loc) return
      const cls = path.findParent((p: NodePath<any>) => p.isClassDeclaration())
      if (!cls || !(cls.node as any)?.id || !path.node.key || path.node.key.type !== 'Identifier') {
        return
      }
      symbols.push({
        name: `${(cls.node as any).id.name}.${path.node.key.name}`,
        kind: 'property',
        line: path.node.loc.start.line,
        end_line: path.node.loc.end.line
      })
    },

    ClassAccessorProperty(path: NodePath<any>) {
      if (!path.node.loc) return
      const cls = path.findParent((p: NodePath<any>) => p.isClassDeclaration())
      if (!cls || !(cls.node as any)?.id || !path.node.key || path.node.key.type !== 'Identifier') {
        return
      }
      symbols.push({
        name: `${(cls.node as any).id.name}.${path.node.key.name}`,
        kind: 'accessor',
        line: path.node.loc.start.line,
        end_line: path.node.loc.end.line
      })
    },

    ClassPrivateProperty(path: NodePath<any>) {
      if (!path.node.loc) return
      const cls = path.findParent((p: NodePath<any>) => p.isClassDeclaration())
      const privateName = path.node.key?.id?.name
      if (!cls || !(cls.node as any)?.id || !privateName) {
        return
      }
      symbols.push({
        name: `${(cls.node as any).id.name}.#${privateName}`,
        kind: 'private_field',
        line: path.node.loc.start.line,
        end_line: path.node.loc.end.line
      })
    },

    TSInterfaceDeclaration(path: NodePath<any>) {
      if (!path.node.id || !path.node.loc) return
      symbols.push({
        name: path.node.id.name,
        kind: 'interface',
        line: path.node.loc.start.line,
        end_line: path.node.loc.end.line
      })
    },

    TSTypeAliasDeclaration(path: NodePath<any>) {
      if (!path.node.id || !path.node.loc) return
      symbols.push({
        name: path.node.id.name,
        kind: 'type',
        line: path.node.loc.start.line,
        end_line: path.node.loc.end.line
      })
    },

    TSEnumDeclaration(path: NodePath<any>) {
      if (!path.node.id || !path.node.loc) return
      symbols.push({
        name: path.node.id.name,
        kind: 'enum',
        line: path.node.loc.start.line,
        end_line: path.node.loc.end.line
      })
    },

    TSModuleDeclaration(path: NodePath<any>) {
      if (!path.node.loc) return
      const name = getModuleName(path)
      if (!name) {
        return
      }
      symbols.push({
        name,
        kind: 'namespace',
        line: path.node.loc.start.line,
        end_line: path.node.loc.end.line
      })
    },

    VariableDeclaration(path: NodePath<any>) {
      if (path.node.kind !== 'const' || !path.node.loc) {
        return
      }
      for (const declarator of path.node.declarations) {
        if (!declarator.id || declarator.id.type !== 'Identifier') {
          continue
        }
        const name = declarator.id.name
        const init = declarator.init
        if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
          if (hasJSX(init.body) && /^[A-Z]/.test(name)) {
            symbols.push({
              name,
              kind: 'function_component',
              line: path.node.loc.start.line,
              end_line: path.node.loc.end.line
            })
            continue
          }
          if (isHookName(name)) {
            symbols.push({
              name,
              kind: 'hook',
              line: path.node.loc.start.line,
              end_line: path.node.loc.end.line
            })
            continue
          }
        }
        symbols.push({
          name,
          kind: 'const',
          line: path.node.loc.start.line,
          end_line: path.node.loc.end.line
        })
      }
    },

    ExportDefaultDeclaration(path: NodePath<any>) {
      if (!path.node.loc) return
      const decl = path.node.declaration
      let name = 'default'
      if (decl?.type === 'Identifier') {
        name = decl.name
      } else if (decl?.id?.name) {
        name = decl.id.name
      }
      symbols.push({
        name,
        kind: 'default_export',
        line: path.node.loc.start.line,
        end_line: path.node.loc.end.line
      })
    },

    Identifier(path: NodePath<any>) {
      if (path.isReferencedIdentifier() && path.node.loc) {
        symbols.push({
          name: path.node.name,
          kind: 'reference',
          line: path.node.loc.start.line,
          end_line: path.node.loc.end.line,
          column: path.node.loc.start.column + 1
        })
      }
    },

    MemberExpression(path: NodePath<any>) {
      if (path.node.property.type === 'Identifier' && path.node.property.loc) {
        symbols.push({
          name: path.node.property.name,
          kind: 'reference',
          line: path.node.property.loc.start.line,
          end_line: path.node.property.loc.end.line,
          column: path.node.property.loc.start.column + 1
        })
      }
    }
  })

  return symbols
}

export function isJSCodeAtPosition(code: string, line: number, column: number): boolean {
  let ast: Node | null = null
  try {
    ast = parse(code, {
      sourceType: 'module',
      plugins: [
        'typescript',
        'jsx',
        'classProperties',
        'classPrivateProperties',
        'classPrivateMethods'
      ]
    })
  } catch {
    return true
  }

  // Check comments
  if (ast.comments) {
    for (const comment of ast.comments) {
      if (comment.loc &&
        line >= comment.loc.start.line &&
        line <= comment.loc.end.line
      ) {
        if (line === comment.loc.start.line && column < comment.loc.start.column) continue
        if (line === comment.loc.end.line && column > comment.loc.end.column) continue
        return false
      }
    }
  }

  let isString = false
  traverse(ast, {
    enter(path: NodePath) {
      const node = path.node
      if (!node.loc) return

      if (
        line >= node.loc.start.line &&
        line <= node.loc.end.line
      ) {
        if (line === node.loc.start.line && column < node.loc.start.column) return
        if (line === node.loc.end.line && column > node.loc.end.column) return

        if (
          node.type === 'StringLiteral' ||
          node.type === 'TemplateElement' ||
          node.type === 'DirectiveLiteral'
        ) {
          isString = true
          path.stop()
        }
      }
    }
  })

  return !isString
}

export interface ImportInfo {
  source: string
  importType: 'default' | 'named' | 'namespace' | 'dynamic' | 'require'
  names: string[]
  line: number
  isTypeOnly: boolean
}

/**
 * Extract import statements from JS/TS source
 */
export function extractImports(code: string): ImportInfo[] {
  const imports: ImportInfo[] = []

  let ast: Node | null = null
  try {
    ast = parse(code, {
      sourceType: 'module',
      plugins: [
        'typescript',
        'jsx',
        'classProperties',
        'classPrivateProperties',
        'classPrivateMethods',
        'dynamicImport'
      ]
    })
  } catch {
    return imports
  }

  traverse(ast, {
    ImportDeclaration(path: NodePath<any>) {
      if (!path.node.source || !path.node.loc) return

      const source = path.node.source.value
      const isTypeOnly = path.node.importKind === 'type'
      const specifiers = path.node.specifiers || []

      if (specifiers.length === 0) {
        // Side-effect import: import 'module'
        imports.push({
          source,
          importType: 'named',
          names: [],
          line: path.node.loc.start.line,
          isTypeOnly
        })
        return
      }

      for (const spec of specifiers) {
        if (spec.type === 'ImportDefaultSpecifier') {
          // import X from 'module'
          imports.push({
            source,
            importType: 'default',
            names: [spec.local.name],
            line: path.node.loc.start.line,
            isTypeOnly
          })
        } else if (spec.type === 'ImportNamespaceSpecifier') {
          // import * as X from 'module'
          imports.push({
            source,
            importType: 'namespace',
            names: [spec.local.name],
            line: path.node.loc.start.line,
            isTypeOnly
          })
        } else if (spec.type === 'ImportSpecifier') {
          // import { a, b } from 'module'
          const isSpecTypeOnly = (spec as any).importKind === 'type'
          const importedName = spec.imported.type === 'Identifier'
            ? spec.imported.name
            : (spec.imported as any).value
          const localName = spec.local.name

          const existingImport = imports.find(
            (imp) =>
              imp.source === source &&
              imp.importType === 'named' &&
              imp.line === path.node.loc.start.line &&
              imp.isTypeOnly === (isTypeOnly || isSpecTypeOnly)
          )

          if (existingImport) {
            existingImport.names.push(localName)
          } else {
            imports.push({
              source,
              importType: 'named',
              names: [localName],
              line: path.node.loc.start.line,
              isTypeOnly: isTypeOnly || isSpecTypeOnly
            })
          }
        }
      }
    },

    CallExpression(path: NodePath<any>) {
      if (!path.node.loc) return

      // Dynamic import: import('module')
      if (path.node.callee.type === 'Import') {
        const arg = path.node.arguments[0]
        if (arg && arg.type === 'StringLiteral') {
          imports.push({
            source: arg.value,
            importType: 'dynamic',
            names: [],
            line: path.node.loc.start.line,
            isTypeOnly: false
          })
        }
        return
      }

      // CommonJS require: require('module')
      if (
        path.node.callee.type === 'Identifier' &&
        path.node.callee.name === 'require'
      ) {
        const arg = path.node.arguments[0]
        if (arg && arg.type === 'StringLiteral') {
          imports.push({
            source: arg.value,
            importType: 'require',
            names: [],
            line: path.node.loc.start.line,
            isTypeOnly: false
          })
        }
      }
    }
  })

  return imports
}
