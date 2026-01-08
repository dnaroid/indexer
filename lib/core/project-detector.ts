import fs from 'fs/promises'
import path from 'path'

interface FsImpl {
  stat(path: string): Promise<any>
  readFile(path: string, encoding: string): Promise<string>
}

let fsImpl: FsImpl = fs as any
export function setFs(impl: any): void {
  fsImpl = impl
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fsImpl.stat(targetPath)
    return true
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      return false
    }
    throw e
  }
}

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

async function readPackageJson(root: string): Promise<PackageJson | null> {
  try {
    const text = await fsImpl.readFile(path.join(root, 'package.json'), 'utf8')
    return JSON.parse(text) as PackageJson
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      return null
    }
    return null
  }
}

function collectDeps(pkg: PackageJson | null): Record<string, string> {
  if (!pkg) {
    return {}
  }
  return {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies
  }
}

function hasAnyDep(deps: Record<string, string>, names: string[]): boolean {
  return names.some((name) => Boolean(deps?.[name]))
}

type ProjectType = 'unity' | 'nextjs' | 'nestjs' | 'node' | 'python' | 'generic'

async function detectProjectType(root: string): Promise<ProjectType> {
  const isUnity = await pathExists(path.join(root, 'Assets')) && await pathExists(path.join(root, 'ProjectSettings'))
  if (isUnity) {
    return 'unity'
  }

  const pkg = await readPackageJson(root)
  const deps = collectDeps(pkg)
  const hasNextConfig =
    (await pathExists(path.join(root, 'next.config.js'))) ||
    (await pathExists(path.join(root, 'next.config.mjs'))) ||
    (await pathExists(path.join(root, 'next.config.cjs'))) ||
    (await pathExists(path.join(root, 'next.config.ts')))
  const isNext = hasNextConfig || hasAnyDep(deps, ['next'])
  if (isNext) {
    return 'nextjs'
  }

  const hasNestConfig =
    (await pathExists(path.join(root, 'nest-cli.json'))) ||
    (await pathExists(path.join(root, 'nestjs-cli.json')))
  const isNest = hasNestConfig || hasAnyDep(deps, ['@nestjs/core', '@nestjs/common', '@nestjs/platform-express'])
  if (isNest) {
    return 'nestjs'
  }

  if (pkg) {
    return 'node'
  }

  const isPython =
    (await pathExists(path.join(root, 'requirements.txt'))) ||
    (await pathExists(path.join(root, 'setup.py'))) ||
    (await pathExists(path.join(root, 'pyproject.toml')))
  if (isPython) {
    return 'python'
  }

  return 'generic'
}

async function filterExistingDirs(root: string, candidates: string[]): Promise<string[]> {
  const out: string[] = []
  for (const dir of candidates) {
    if (await pathExists(path.join(root, dir))) {
      out.push(dir)
    }
  }
  return out
}

function getDefaultExts(projectType: ProjectType): string[] {
  const types: Record<ProjectType, string[]> = {
    unity: ['.cs', '.shader', '.hlsl', '.cginc', '.asmdef', '.asmref'],
    nextjs: ['.js', '.jsx', '.ts', '.tsx'],
    nestjs: ['.ts', '.js'],
    node: ['.js', '.jsx', '.ts', '.tsx'],
    python: ['.py'],
    generic: ['.js', '.ts', '.py', '.java', '.kt', '.cs']
  }
  return types[projectType] || types.generic
}

async function getSuggestedDirs(root: string, projectType: ProjectType): Promise<string[]> {
  const candidates: Record<ProjectType, string[]> = {
    unity: ['Assets'],
    nextjs: ['app', 'pages', 'src', 'components', 'lib', 'apps', 'packages'],
    nestjs: ['src', 'apps', 'libs', 'packages'],
    node: ['src', 'apps', 'packages', 'lib'],
    python: ['src', 'app', 'apps', 'services'],
    generic: ['src']
  }
  const list = candidates[projectType] || candidates.generic
  const filtered = await filterExistingDirs(root, list)
  return filtered
}

export interface ProjectIndexConfig {
  type: ProjectType
  dirs: string[]
  exts: string[]
}

export async function detectProjectIndexConfig(root: string): Promise<ProjectIndexConfig> {
  const type = await detectProjectType(root)
  const dirs = await getSuggestedDirs(root, type)
  const exts = getDefaultExts(type)
  return {type, dirs, exts}
}

export function renderToIndex({type, dirs, exts}: ProjectIndexConfig): string {
  const header = [
    `# to-index whitelist`,
    `# Project type: ${type}`,
    `# Use "dir:" entries to limit scope. If none are set, indexing starts at project root.`,
    `# File extensions are required; without them the watcher will ignore all files.`,
    ``
  ].join('\n')

  const dirLines = dirs.length
    ? [`# Directories`, ...dirs.map((dir) => `dir: ${dir}`), ``]
    : [`# Directories`, `# (none) -> index from project root`, ``]

  const extLines = [`# Extensions`, ...exts.map((ext) => `ext: ${ext}`), ``]

  return [header, ...dirLines, ...extLines].join('\n')
}
