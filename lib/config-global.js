import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

const HOME_DIR = os.homedir()
const GLOBAL_CONFIG_PATH = path.join(HOME_DIR, '.indexer.cfg')
const LOG_DIR = path.join(HOME_DIR, '.indexer', 'logs')
const DAEMON_PID_FILE = path.join(HOME_DIR, '.indexer', 'daemon.pid')

export const DEFAULT_SETTINGS = {
  QDRANT_URL: 'http://localhost:6333',
  OLLAMA_URL: 'http://127.0.0.1:11434',
  EMBED_MODEL: 'unclemusclez/jina-embeddings-v2-base-code',
  VECTOR_SIZE: 768,
  MAX_CHUNK_LINES: 500,
  OVERLAP_LINES: 50,
  MAX_FILE_BYTES: 2 * 1024 * 1024,
  TOP_K_DEFAULT: 10,
  SCORE_THRESHOLD: 0.2
}

async function ensureGlobalDirs() {
  await fs.mkdir(path.dirname(GLOBAL_CONFIG_PATH), { recursive: true })
  await fs.mkdir(LOG_DIR, { recursive: true })
}

export async function loadGlobalConfig() {
  try {
    const content = await fs.readFile(GLOBAL_CONFIG_PATH, 'utf8')
    const config = JSON.parse(content)
    
    // Migration: if projects is an array, convert to object
    if (Array.isArray(config.projects)) {
      const projectsObj = {}
      for (const p of config.projects) {
        projectsObj[p] = {
          collectionName: getProjectCollectionName(p),
          settings: {}
        }
      }
      config.projects = projectsObj
    }
    
    return config
  } catch (e) {
    return {
      projects: {}, // path -> { collectionName, settings }
      logging: { enabled: true, level: 'info' }
    }
  }
}

export async function saveGlobalConfig(config) {
  await ensureGlobalDirs()
  await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8')
}

export async function addProjectToConfig(projectPath) {
  const config = await loadGlobalConfig()
  const absPath = path.resolve(projectPath)
  
  if (!config.projects[absPath]) {
    config.projects[absPath] = {
      collectionName: getProjectCollectionName(absPath),
      settings: {} // Overrides for DEFAULT_SETTINGS
    }
    await saveGlobalConfig(config)
    return true
  }
  return false
}

export async function removeProjectFromConfig(projectPath) {
  const config = await loadGlobalConfig()
  const absPath = path.resolve(projectPath)
  
  if (config.projects[absPath]) {
    delete config.projects[absPath]
    await saveGlobalConfig(config)
    return true
  }
  return false
}

export async function getProjectConfig(projectPath) {
  const config = await loadGlobalConfig()
  const absPath = path.resolve(projectPath)
  const project = config.projects[absPath]
  
  if (!project) return null
  
  return {
    collectionName: project.collectionName,
    settings: { ...DEFAULT_SETTINGS, ...project.settings }
  }
}

export function getProjectCollectionName(projectPath) {
  const absPath = path.resolve(projectPath)
  const hash = crypto.createHash('sha256').update(absPath).digest('hex')
  return `idx_${hash.substring(0, 16)}`
}

export function getLogFilePath() {
  return path.join(LOG_DIR, 'indexer.log')
}

export function getDaemonPidFilePath() {
  return DAEMON_PID_FILE
}