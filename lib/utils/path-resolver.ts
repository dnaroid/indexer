import path from 'path'
import fs from 'fs/promises'

export interface ResolvedImport {
  resolved: boolean
  targetPath: string | null
  isExternal: boolean
  packageName: string | null
}

// Cache for tsconfig.json and package.json
const tsconfigCache = new Map<string, any>()
const packageJsonCache = new Map<string, any>()

/**
 * Load and parse tsconfig.json
 */
async function loadTsConfig(projectRoot: string): Promise<any | null> {
  if (tsconfigCache.has(projectRoot)) {
    return tsconfigCache.get(projectRoot)
  }

  try {
    const tsconfigPath = path.join(projectRoot, 'tsconfig.json')
    const content = await fs.readFile(tsconfigPath, 'utf8')

    // Remove comments from JSON (basic implementation)
    const jsonContent = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '')
    const config = JSON.parse(jsonContent)

    tsconfigCache.set(projectRoot, config)
    return config
  } catch {
    tsconfigCache.set(projectRoot, null)
    return null
  }
}

/**
 * Load and parse package.json
 */
async function loadPackageJson(projectRoot: string): Promise<any | null> {
  if (packageJsonCache.has(projectRoot)) {
    return packageJsonCache.get(projectRoot)
  }

  try {
    const packageJsonPath = path.join(projectRoot, 'package.json')
    const content = await fs.readFile(packageJsonPath, 'utf8')
    const config = JSON.parse(content)

    packageJsonCache.set(projectRoot, config)
    return config
  } catch {
    packageJsonCache.set(projectRoot, null)
    return null
  }
}

/**
 * Check if a file exists with any of the given extensions
 */
async function findFileWithExtensions(
  basePath: string,
  extensions: string[]
): Promise<string | null> {
  // Try exact path first
  try {
    const stat = await fs.stat(basePath)
    if (stat.isFile()) {
      return basePath
    }
    // If directory, try index files
    if (stat.isDirectory()) {
      for (const ext of extensions) {
        const indexPath = path.join(basePath, `index${ext}`)
        try {
          const indexStat = await fs.stat(indexPath)
          if (indexStat.isFile()) {
            return indexPath
          }
        } catch {
          // Continue to next extension
        }
      }
    }
  } catch {
    // File doesn't exist, try with extensions
  }

  // Try with each extension
  for (const ext of extensions) {
    const pathWithExt = basePath + ext
    try {
      const stat = await fs.stat(pathWithExt)
      if (stat.isFile()) {
        return pathWithExt
      }
    } catch {
      // Continue to next extension
    }
  }

  return null
}

/**
 * Extract package name from import specifier
 * Examples:
 *   'lodash' → 'lodash'
 *   '@types/node' → '@types/node'
 *   'lodash/debounce' → 'lodash'
 *   '@types/node/fs' → '@types/node'
 */
function extractPackageName(specifier: string): string {
  if (specifier.startsWith('@')) {
    // Scoped package: @scope/package/subpath → @scope/package
    const parts = specifier.split('/')
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`
    }
    return specifier
  }

  // Regular package: package/subpath → package
  const firstSlash = specifier.indexOf('/')
  if (firstSlash === -1) {
    return specifier
  }
  return specifier.substring(0, firstSlash)
}

/**
 * Resolve tsconfig paths alias
 */
async function resolveTsConfigAlias(
  specifier: string,
  projectRoot: string
): Promise<string | null> {
  const tsconfig = await loadTsConfig(projectRoot)
  if (!tsconfig || !tsconfig.compilerOptions || !tsconfig.compilerOptions.paths) {
    return null
  }

  const paths = tsconfig.compilerOptions.paths
  const baseUrl = tsconfig.compilerOptions.baseUrl || '.'

  // Find matching path alias
  for (const [alias, targets] of Object.entries(paths)) {
    // Convert alias pattern to regex
    // Example: "@lib/*" → "^@lib/(.*)$"
    const aliasPattern = alias.replace(/\*/g, '(.*)')
    const regex = new RegExp(`^${aliasPattern}$`)
    const match = specifier.match(regex)

    if (match && Array.isArray(targets) && targets.length > 0) {
      // Replace * with captured group
      const target = (targets[0] as string).replace(/\*/g, match[1] || '')
      return path.join(projectRoot, baseUrl, target)
    }
  }

  return null
}

/**
 * Resolve package.json imports field
 */
async function resolvePackageJsonImports(
  specifier: string,
  projectRoot: string
): Promise<string | null> {
  if (!specifier.startsWith('#')) {
    return null
  }

  const packageJson = await loadPackageJson(projectRoot)
  if (!packageJson || !packageJson.imports) {
    return null
  }

  const imports = packageJson.imports

  // Find matching import
  for (const [pattern, target] of Object.entries(imports)) {
    if (pattern.endsWith('/*') && specifier.startsWith(pattern.slice(0, -1))) {
      // Pattern: "#lib/*" matches "#lib/utils"
      const rest = specifier.slice(pattern.length - 1)
      const targetPattern = typeof target === 'string' ? target : (target as any).default || ''
      if (targetPattern.endsWith('/*')) {
        const resolvedPath = targetPattern.slice(0, -1) + rest
        return path.join(projectRoot, resolvedPath)
      }
    } else if (pattern === specifier) {
      // Exact match
      const targetPath = typeof target === 'string' ? target : (target as any).default || ''
      return path.join(projectRoot, targetPath)
    }
  }

  return null
}

/**
 * Resolve JavaScript/TypeScript import
 */
async function resolveJSImport(
  specifier: string,
  sourceFilePath: string,
  projectRoot: string
): Promise<ResolvedImport> {
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.d.ts']
  const sourceDir = path.dirname(path.join(projectRoot, sourceFilePath))

  // 1. Check if it's a relative import
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const absolutePath = path.resolve(sourceDir, specifier)
    const relativePath = path.relative(projectRoot, absolutePath)

    const resolvedPath = await findFileWithExtensions(absolutePath, extensions)

    if (resolvedPath) {
      const finalRelativePath = path.relative(projectRoot, resolvedPath)
      return {
        resolved: true,
        targetPath: finalRelativePath,
        isExternal: false,
        packageName: null
      }
    }

    return {
      resolved: false,
      targetPath: null,
      isExternal: false,
      packageName: null
    }
  }

  // 2. Check tsconfig paths alias
  const tsAliasPath = await resolveTsConfigAlias(specifier, projectRoot)
  if (tsAliasPath) {
    const resolvedPath = await findFileWithExtensions(tsAliasPath, extensions)
    if (resolvedPath) {
      const relativePath = path.relative(projectRoot, resolvedPath)
      return {
        resolved: true,
        targetPath: relativePath,
        isExternal: false,
        packageName: null
      }
    }
  }

  // 3. Check package.json imports
  const pkgImportPath = await resolvePackageJsonImports(specifier, projectRoot)
  if (pkgImportPath) {
    const resolvedPath = await findFileWithExtensions(pkgImportPath, extensions)
    if (resolvedPath) {
      const relativePath = path.relative(projectRoot, resolvedPath)
      return {
        resolved: true,
        targetPath: relativePath,
        isExternal: false,
        packageName: null
      }
    }
  }

  // 4. Otherwise, it's an external package
  const packageName = extractPackageName(specifier)
  return {
    resolved: true,
    targetPath: null,
    isExternal: true,
    packageName
  }
}

/**
 * Resolve Python import
 */
async function resolvePythonImport(
  specifier: string,
  sourceFilePath: string,
  projectRoot: string
): Promise<ResolvedImport> {
  const sourceDir = path.dirname(path.join(projectRoot, sourceFilePath))

  // Handle relative imports
  if (specifier.startsWith('.')) {
    // Count dots for relative level
    let level = 0
    let i = 0
    while (i < specifier.length && specifier[i] === '.') {
      level++
      i++
    }

    const moduleName = specifier.slice(i)
    let currentDir = sourceDir

    // Go up 'level' directories
    for (let j = 0; j < level - 1; j++) {
      currentDir = path.dirname(currentDir)
    }

    // Convert module path to file path
    const modulePath = moduleName.replace(/\./g, path.sep)
    const absolutePath = path.join(currentDir, modulePath)

    // Try .py file or __init__.py in directory
    const pyFile = absolutePath + '.py'
    const initFile = path.join(absolutePath, '__init__.py')

    try {
      await fs.stat(pyFile)
      const relativePath = path.relative(projectRoot, pyFile)
      return {
        resolved: true,
        targetPath: relativePath,
        isExternal: false,
        packageName: null
      }
    } catch {
      // Try __init__.py
    }

    try {
      await fs.stat(initFile)
      const relativePath = path.relative(projectRoot, initFile)
      return {
        resolved: true,
        targetPath: relativePath,
        isExternal: false,
        packageName: null
      }
    } catch {
      // Not found
    }

    return {
      resolved: false,
      targetPath: null,
      isExternal: false,
      packageName: null
    }
  }

  // Absolute import: try to resolve from project root
  const modulePath = specifier.replace(/\./g, path.sep)
  const absolutePath = path.join(projectRoot, modulePath)

  const pyFile = absolutePath + '.py'
  const initFile = path.join(absolutePath, '__init__.py')

  try {
    await fs.stat(pyFile)
    const relativePath = path.relative(projectRoot, pyFile)
    return {
      resolved: true,
      targetPath: relativePath,
      isExternal: false,
      packageName: null
    }
  } catch {
    // Try __init__.py
  }

  try {
    await fs.stat(initFile)
    const relativePath = path.relative(projectRoot, initFile)
    return {
      resolved: true,
      targetPath: relativePath,
      isExternal: false,
      packageName: null
    }
  } catch {
    // Not found in project, assume external
  }

  // External package
  const packageName = specifier.split('.')[0]
  return {
    resolved: true,
    targetPath: null,
    isExternal: true,
    packageName
  }
}

/**
 * Resolve C# using directive
 */
async function resolveCSharpImport(
  specifier: string,
  sourceFilePath: string,
  projectRoot: string
): Promise<ResolvedImport> {
  // For C#, most using directives are external (System.*, Unity.*, etc.)
  // We'll only try to resolve project-internal namespaces

  // Convert namespace to path: MyApp.Utils → MyApp/Utils.cs
  const namespacePath = specifier.replace(/\./g, path.sep)
  const possiblePath = path.join(projectRoot, namespacePath + '.cs')

  try {
    await fs.stat(possiblePath)
    const relativePath = path.relative(projectRoot, possiblePath)
    return {
      resolved: true,
      targetPath: relativePath,
      isExternal: false,
      packageName: null
    }
  } catch {
    // Not found, assume external
  }

  // External package (NuGet, System, Unity, etc.)
  return {
    resolved: true,
    targetPath: null,
    isExternal: true,
    packageName: specifier.split('.')[0]
  }
}

/**
 * Main function to resolve import path
 */
export async function resolveImportPath(
  importSpecifier: string,
  sourceFilePath: string,
  projectRoot: string,
  lang: 'javascript' | 'typescript' | 'python' | 'csharp'
): Promise<ResolvedImport> {
  try {
    if (lang === 'javascript' || lang === 'typescript') {
      return await resolveJSImport(importSpecifier, sourceFilePath, projectRoot)
    }

    if (lang === 'python') {
      return await resolvePythonImport(importSpecifier, sourceFilePath, projectRoot)
    }

    if (lang === 'csharp') {
      return await resolveCSharpImport(importSpecifier, sourceFilePath, projectRoot)
    }

    // Unsupported language
    return {
      resolved: false,
      targetPath: null,
      isExternal: false,
      packageName: null
    }
  } catch (error) {
    // On error, return unresolved
    return {
      resolved: false,
      targetPath: null,
      isExternal: false,
      packageName: null
    }
  }
}

/**
 * Clear caches (useful for testing)
 */
export function clearCaches(): void {
  tsconfigCache.clear()
  packageJsonCache.clear()
}
