import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

const HOME_DIR = os.homedir()
const INDEXER_DIR = path.join(HOME_DIR, '.indexer')
const GLOBAL_CONFIG_PATH = path.join(INDEXER_DIR, 'config.json')
const LOG_FILE = path.join(INDEXER_DIR, 'daemon.log')
const DAEMON_PID_FILE = path.join(INDEXER_DIR, 'daemon.pid')
const DAEMON_PORT_FILE = path.join(INDEXER_DIR, 'daemon.port')
const SNAPSHOT_DB_PATH = path.join(INDEXER_DIR, 'snapshots.db')

export const DEFAULT_SETTINGS = {
  QDRANT_URL: 'http://localhost:6333',
  OLLAMA_URL: 'http://127.0.0.1:11434',
  EMBED_MODEL: 'unclemusclez/jina-embeddings-v2-base-code',
  VECTOR_SIZE: 768,
  MAX_CHUNK_LINES: 500,
  OVERLAP_LINES: 50,
  MAX_FILE_BYTES: 2 * 1024 * 1024,
  TOP_K_DEFAULT: 10,
  SCORE_THRESHOLD: 0.2,
  SERVICE_PORT: 34567
}

async function ensureGlobalDirs() {
  await fs.mkdir(INDEXER_DIR, { recursive: true })
}

// Migration function to move old config files to new locations
async function migrateOldConfig() {
  const oldConfigPath = path.join(HOME_DIR, '.indexer.cfg')
  const oldLogDir = path.join(HOME_DIR, '.indexer', 'logs')
  const oldLogFile = path.join(oldLogDir, 'indexer.log')

  // Check if old config exists
  try {
    await fs.access(oldConfigPath)

    // Move config
    await fs.rename(oldConfigPath, GLOBAL_CONFIG_PATH)
    console.log(`[Migration] Moved config from ${oldConfigPath} to ${GLOBAL_CONFIG_PATH}`)
  } catch (e: any) {
    // Old config doesn't exist, nothing to do
  }

  // Check if old logs exist
  try {
    await fs.access(oldLogFile)

    // Move logs
    await fs.rename(oldLogFile, LOG_FILE)
    console.log(`[Migration] Moved logs from ${oldLogFile} to ${LOG_FILE}`)

    // Remove empty logs directory
    try {
      await fs.rmdir(oldLogDir)
    } catch (e: any) {
      // Directory not empty or doesn't exist
    }
  } catch (e: any) {
    // Old logs don't exist, nothing to do
  }

  // Migrate log.txt to daemon.log
  const oldLogTxt = path.join(INDEXER_DIR, 'log.txt')
  try {
    await fs.access(oldLogTxt)
    await fs.rename(oldLogTxt, LOG_FILE)
    console.log(`[Migration] Renamed log.txt to daemon.log`)
  } catch (e: any) {
    // Old log.txt doesn't exist, nothing to do
  }
}

export async function loadGlobalConfig() {
  // Run migration first
  await migrateOldConfig()

  try {
    const content = await fs.readFile(GLOBAL_CONFIG_PATH, 'utf8')
    const config = JSON.parse(content)

    // Migration: if projects is an array, convert to object
    if (Array.isArray(config.projects)) {
      const projectsObj: any = {}
      for (const p of config.projects) {
        projectsObj[p] = {
          collectionName: getProjectCollectionName(p),
          settings: {}
        }
      }
      config.projects = projectsObj
    }

    return config
  } catch (e: any) {
    // Distinguish between file not found and JSON parse errors
    if (e.code === 'ENOENT') {
      // File doesn't exist, return default config
      return {
        projects: {}, // path -> { collectionName, settings }
        logging: { enabled: true, level: 'info' }
      }
    }
    // For JSON parse errors or other errors, throw to allow caller to handle
    throw e
  }
}

export async function saveGlobalConfig(config: any): Promise<void> {
  await ensureGlobalDirs()
  await fs.writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8')
}

export async function addProjectToConfig(projectPath: string): Promise<boolean> {
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

export async function removeProjectFromConfig(projectPath: string): Promise<boolean> {
  const config = await loadGlobalConfig()
  const absPath = path.resolve(projectPath)

  if (config.projects[absPath]) {
    delete config.projects[absPath]
    await saveGlobalConfig(config)
    return true
  }
  return false
}

export async function getProjectConfig(projectPath: string) {
  const config = await loadGlobalConfig()
  const absPath = path.resolve(projectPath)
  const project = config.projects[absPath]

  if (!project) return null

  return {
    collectionName: project.collectionName,
    settings: { ...DEFAULT_SETTINGS, ...project.settings }
  }
}

export function getProjectCollectionName(projectPath: string): string {
  const absPath = path.resolve(projectPath)
  const hash = crypto.createHash('sha256').update(absPath).digest('hex')
  return `idx_${hash.substring(0, 16)}`
}

export function getLogFilePath() {
  return LOG_FILE
}

export function getDaemonPidFilePath() {
  // In test mode, use a unique PID file per process to avoid conflicts
  if (process.env.NODE_ENV === 'test') {
    return path.join(INDEXER_DIR, `daemon-test-${process.pid}.pid`)
  }
  return DAEMON_PID_FILE
}

export function getGlobalConfigPath() {
  return GLOBAL_CONFIG_PATH
}

export function getGlobalConfigDir() {
  return INDEXER_DIR
}

export function getDaemonPortFilePath() {
  return DAEMON_PORT_FILE
}

export async function readDaemonPort(): Promise<number | null> {
  try {
    const portStr = await fs.readFile(DAEMON_PORT_FILE, 'utf8')
    return parseInt(portStr.trim())
  } catch {
    return null
  }
}

export async function writeDaemonPortFile(port: number): Promise<void> {
  await ensureGlobalDirs()
  await fs.writeFile(DAEMON_PORT_FILE, String(port), 'utf8')
}

export function getSnapshotDbPath(): string {
  return SNAPSHOT_DB_PATH
}
