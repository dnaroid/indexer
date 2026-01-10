import test from 'node:test'
import assert from 'node:assert/strict'
import { extractImports } from './ast-js.js'

test('extractImports: ES6 default import', () => {
  const code = `import React from 'react'`
  const imports = extractImports(code)

  assert.equal(imports.length, 1)
  assert.equal(imports[0].source, 'react')
  assert.equal(imports[0].importType, 'default')
  assert.deepEqual(imports[0].names, ['React'])
  assert.equal(imports[0].line, 1)
  assert.equal(imports[0].isTypeOnly, false)
})

test('extractImports: ES6 named imports', () => {
  const code = `import { useState, useEffect } from 'react'`
  const imports = extractImports(code)

  assert.equal(imports.length, 1)
  assert.equal(imports[0].source, 'react')
  assert.equal(imports[0].importType, 'named')
  assert.deepEqual(imports[0].names, ['useState', 'useEffect'])
  assert.equal(imports[0].line, 1)
})

test('extractImports: ES6 namespace import', () => {
  const code = `import * as React from 'react'`
  const imports = extractImports(code)

  assert.equal(imports.length, 1)
  assert.equal(imports[0].source, 'react')
  assert.equal(imports[0].importType, 'namespace')
  assert.deepEqual(imports[0].names, ['React'])
})

test('extractImports: dynamic import', () => {
  const code = `const module = import('lodash')`
  const imports = extractImports(code)

  assert.equal(imports.length, 1)
  assert.equal(imports[0].source, 'lodash')
  assert.equal(imports[0].importType, 'dynamic')
  assert.deepEqual(imports[0].names, [])
})

test('extractImports: CommonJS require', () => {
  const code = `const fs = require('fs')`
  const imports = extractImports(code)

  assert.equal(imports.length, 1)
  assert.equal(imports[0].source, 'fs')
  assert.equal(imports[0].importType, 'require')
  assert.deepEqual(imports[0].names, [])
})

test('extractImports: TypeScript type-only import', () => {
  const code = `import type { User } from './types'`
  const imports = extractImports(code)

  assert.equal(imports.length, 1)
  assert.equal(imports[0].source, './types')
  assert.equal(imports[0].importType, 'named')
  assert.deepEqual(imports[0].names, ['User'])
  assert.equal(imports[0].isTypeOnly, true)
})

test('extractImports: side-effect import', () => {
  const code = `import './styles.css'`
  const imports = extractImports(code)

  assert.equal(imports.length, 1)
  assert.equal(imports[0].source, './styles.css')
  assert.equal(imports[0].importType, 'named')
  assert.deepEqual(imports[0].names, [])
})

test('extractImports: multiple imports from same module', () => {
  const code = `
import React, { useState } from 'react'
  `
  const imports = extractImports(code)

  assert.equal(imports.length, 2)

  const defaultImport = imports.find(i => i.importType === 'default')
  assert.ok(defaultImport)
  assert.equal(defaultImport.source, 'react')
  assert.deepEqual(defaultImport.names, ['React'])

  const namedImport = imports.find(i => i.importType === 'named')
  assert.ok(namedImport)
  assert.equal(namedImport.source, 'react')
  assert.deepEqual(namedImport.names, ['useState'])
})

test('extractImports: mixed import types', () => {
  const code = `
import React from 'react'
import { helper } from './utils'
import * as lodash from 'lodash'
const fs = require('fs')
  `
  const imports = extractImports(code)

  assert.equal(imports.length, 4)

  const defaultImport = imports.find(i => i.source === 'react')
  assert.equal(defaultImport?.importType, 'default')

  const namedImport = imports.find(i => i.source === './utils')
  assert.equal(namedImport?.importType, 'named')

  const namespaceImport = imports.find(i => i.source === 'lodash')
  assert.equal(namespaceImport?.importType, 'namespace')

  const requireImport = imports.find(i => i.source === 'fs')
  assert.equal(requireImport?.importType, 'require')
})

test('extractImports: relative paths', () => {
  const code = `
import { util1 } from './utils'
import { util2 } from '../helpers'
import { util3 } from '../../shared/utils'
  `
  const imports = extractImports(code)

  assert.equal(imports.length, 3)
  assert.equal(imports[0].source, './utils')
  assert.equal(imports[1].source, '../helpers')
  assert.equal(imports[2].source, '../../shared/utils')
})

test('extractImports: scoped packages', () => {
  const code = `
import { Component } from '@angular/core'
import type { Config } from '@types/node'
  `
  const imports = extractImports(code)

  assert.equal(imports.length, 2)
  assert.equal(imports[0].source, '@angular/core')
  assert.equal(imports[1].source, '@types/node')
  assert.equal(imports[1].isTypeOnly, true)
})

test('extractImports: invalid syntax returns empty array', () => {
  const code = `this is not valid javascript {{{`
  const imports = extractImports(code)

  assert.equal(imports.length, 0)
})

test('extractImports: empty file returns empty array', () => {
  const code = ``
  const imports = extractImports(code)

  assert.equal(imports.length, 0)
})

test('extractImports: aliased imports', () => {
  const code = `import { something as myThing } from 'module'`
  const imports = extractImports(code)

  assert.equal(imports.length, 1)
  assert.equal(imports[0].importType, 'named')
  // We store the local name
  assert.deepEqual(imports[0].names, ['myThing'])
})

test('extractImports: TypeScript inline type imports', () => {
  const code = `import { type User, type Config } from './types'`
  const imports = extractImports(code)

  assert.equal(imports.length, 1)
  assert.equal(imports[0].importType, 'named')
  assert.deepEqual(imports[0].names, ['User', 'Config'])
  assert.equal(imports[0].isTypeOnly, true)
})
