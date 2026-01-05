import fs from 'fs/promises'
import path from 'path'

async function pathExists(targetPath) {
  try {
    await fs.stat(targetPath)
    return true
  } catch (e) {
    if (e.code === 'ENOENT') {
      return false
    }
    throw e
  }
}

async function readPackageJson(root) {
  try {
    const text = await fs.readFile(path.join(root, 'package.json'), 'utf8')
    return JSON.parse(text)
  } catch (e) {
    if (e.code === 'ENOENT') {
      return null
    }
    return null
  }
}

function collectDeps(pkg) {
  if (!pkg) {
    return {}
  }
  return {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.peerDependencies
  }
}

function hasAnyDep(deps, names) {
  return names.some((name) => Boolean(deps?.[name]))
}

async function detectProjectType(root) {
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

  if (await pathExists(path.join(root, 'go.mod'))) {
    return 'go'
  }

  return 'generic'
}

async function filterExistingDirs(root, candidates) {
  const out = []
  for (const dir of candidates) {
    if (await pathExists(path.join(root, dir))) {
      out.push(dir)
    }
  }
  return out
}

function getDefaultExts(projectType) {
  const types = {
    unity: ['.cs', '.shader', '.hlsl', '.cginc', '.asmdef', '.asmref'],
    nextjs: ['.js', '.jsx', '.ts', '.tsx', '.json', '.yml', '.yaml', '.toml', '.css', '.scss', '.html'],
    nestjs: ['.ts', '.js', '.json', '.yml', '.yaml'],
    node: ['.js', '.jsx', '.ts', '.tsx', '.json', '.yml', '.yaml', '.toml', '.css', '.scss', '.html'],
    python: ['.py', '.json', '.yml', '.yaml', '.toml'],
    go: ['.go', '.mod', '.sum', '.json', '.yml', '.yaml'],
    generic: ['.js', '.ts', '.py', '.go', '.rs', '.java', '.kt', '.cs', '.json', '.yml', '.yaml', '.toml']
  }
  return types[projectType] || types.generic
}

async function getSuggestedDirs(root, projectType) {
  const candidates = {
    unity: ['Assets'],
    nextjs: ['app', 'pages', 'src', 'components', 'lib', 'apps', 'packages'],
    nestjs: ['src', 'apps', 'libs', 'packages'],
    node: ['src', 'apps', 'packages', 'lib'],
    python: ['src', 'app', 'apps', 'services'],
    go: [],
    generic: ['src']
  }
  const list = candidates[projectType] || candidates.generic
  const filtered = await filterExistingDirs(root, list)
  return filtered
}

export async function detectProjectIndexConfig(root) {
  const type = await detectProjectType(root)
  const dirs = await getSuggestedDirs(root, type)
  const exts = getDefaultExts(type)
  return {type, dirs, exts}
}

export function renderToIndex({type, dirs, exts}) {
  const header = [
    `# to-index whitelist`,
    `# Project type: ${type}`,
    `# Use \"dir:\" entries to limit scope. If none are set, indexing starts at project root.`,
    `# File extensions are required; without them the watcher will ignore all files.`,
    ``
  ].join('\n')

  const dirLines = dirs.length
    ? [`# Directories`, ...dirs.map((dir) => `dir: ${dir}`), ``]
    : [`# Directories`, `# (none) -> index from project root`, ``]

  const extLines = [`# Extensions`, ...exts.map((ext) => `ext: ${ext}`), ``]

  return [header, ...dirLines, ...extLines].join('\n')
}
