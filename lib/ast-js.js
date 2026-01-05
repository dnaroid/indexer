import {parse} from '@babel/parser'
import _traverse from '@babel/traverse'
const traverse = _traverse.default || _traverse

/*
  Extract symbols from JS / TS source
*/
export function extractJSSymbols(code) {
  const symbols = []

  function hasJSX(node) {
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

  function isHookName(name) {
    return /^use[A-Z0-9]/.test(name)
  }

  function getModuleName(path) {
    const names = []
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

  let ast
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
    FunctionDeclaration(path) {
      if (!path.node.id) {
        return
      }
      const name = path.node.id.name
      if (isHookName(name)) {
        symbols.push({
          name,
          kind: 'hook',
          start: path.node.loc.start.line,
          end: path.node.loc.end.line
        })
        return
      }
      if (hasJSX(path.node.body) && /^[A-Z]/.test(name)) {
        symbols.push({
          name,
          kind: 'function_component',
          start: path.node.loc.start.line,
          end: path.node.loc.end.line
        })
        return
      }
      symbols.push({
        name,
        kind: 'function',
        start: path.node.loc.start.line,
        end: path.node.loc.end.line
      })
    },

    ClassDeclaration(path) {
      if (!path.node.id) {
        return
      }
      symbols.push({
        name: path.node.id.name,
        kind: 'class',
        start: path.node.loc.start.line,
        end: path.node.loc.end.line
      })
    },

    ClassMethod(path) {
      const cls = path.findParent((p) => p.isClassDeclaration())
      if (!cls?.node?.id) {
        return
      }
      const isAccessor = path.node.kind === 'get' || path.node.kind === 'set'
      symbols.push({
        name: `${cls.node.id.name}.${path.node.key.name}`,
        kind: isAccessor ? 'accessor' : 'method',
        start: path.node.loc.start.line,
        end: path.node.loc.end.line
      })
    },

    ClassProperty(path) {
      const cls = path.findParent((p) => p.isClassDeclaration())
      if (!cls?.node?.id || !path.node.key || path.node.key.type !== 'Identifier') {
        return
      }
      symbols.push({
        name: `${cls.node.id.name}.${path.node.key.name}`,
        kind: 'property',
        start: path.node.loc.start.line,
        end: path.node.loc.end.line
      })
    },

    ClassAccessorProperty(path) {
      const cls = path.findParent((p) => p.isClassDeclaration())
      if (!cls?.node?.id || !path.node.key || path.node.key.type !== 'Identifier') {
        return
      }
      symbols.push({
        name: `${cls.node.id.name}.${path.node.key.name}`,
        kind: 'accessor',
        start: path.node.loc.start.line,
        end: path.node.loc.end.line
      })
    },

    ClassPrivateProperty(path) {
      const cls = path.findParent((p) => p.isClassDeclaration())
      const privateName = path.node.key?.id?.name
      if (!cls?.node?.id || !privateName) {
        return
      }
      symbols.push({
        name: `${cls.node.id.name}.#${privateName}`,
        kind: 'private_field',
        start: path.node.loc.start.line,
        end: path.node.loc.end.line
      })
    },

    TSInterfaceDeclaration(path) {
      if (!path.node.id) {
        return
      }
      symbols.push({
        name: path.node.id.name,
        kind: 'interface',
        start: path.node.loc.start.line,
        end: path.node.loc.end.line
      })
    },

    TSTypeAliasDeclaration(path) {
      if (!path.node.id) {
        return
      }
      symbols.push({
        name: path.node.id.name,
        kind: 'type',
        start: path.node.loc.start.line,
        end: path.node.loc.end.line
      })
    },

    TSEnumDeclaration(path) {
      if (!path.node.id) {
        return
      }
      symbols.push({
        name: path.node.id.name,
        kind: 'enum',
        start: path.node.loc.start.line,
        end: path.node.loc.end.line
      })
    },

    TSModuleDeclaration(path) {
      const name = getModuleName(path)
      if (!name) {
        return
      }
      symbols.push({
        name,
        kind: 'namespace',
        start: path.node.loc.start.line,
        end: path.node.loc.end.line
      })
    },

    VariableDeclaration(path) {
      if (path.node.kind !== 'const') {
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
              start: path.node.loc.start.line,
              end: path.node.loc.end.line
            })
            continue
          }
          if (isHookName(name)) {
            symbols.push({
              name,
              kind: 'hook',
              start: path.node.loc.start.line,
              end: path.node.loc.end.line
            })
            continue
          }
        }
        symbols.push({
          name,
          kind: 'const',
          start: path.node.loc.start.line,
          end: path.node.loc.end.line
        })
      }
    },

    ExportDefaultDeclaration(path) {
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
        start: path.node.loc.start.line,
        end: path.node.loc.end.line
      })
    }
  })

  return symbols
}

export function isJSCodeAtPosition(code, line, column) {
  let ast
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
      if (
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
    enter(path) {
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
