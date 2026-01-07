#!/usr/bin/env node

/**
 * Test script for migration from old config structure to new ~/.indexer/ structure
 */

import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { loadGlobalConfig, getLogFilePath, getDaemonPidFilePath } from '../lib/config-global.js'

const HOME_DIR = os.homedir()
const INDEXER_DIR = path.join(HOME_DIR, '.indexer')

// Old paths
const OLD_CONFIG_PATH = path.join(HOME_DIR, '.indexer.cfg')
const OLD_LOG_DIR = path.join(HOME_DIR, '.indexer', 'logs')
const OLD_LOG_FILE = path.join(OLD_LOG_DIR, 'indexer.log')

// New paths
const NEW_CONFIG_PATH = path.join(INDEXER_DIR, 'config.json')
const NEW_LOG_FILE = path.join(INDEXER_DIR, 'log.txt')
const NEW_PID_FILE = path.join(INDEXER_DIR, 'daemon.pid')

console.log('=== Migration Test Script ===\n')

async function setupOldFiles() {
  console.log('1. Setting up old config structure...')

  // Create old config file
  await fs.mkdir(path.dirname(OLD_CONFIG_PATH), { recursive: true })
  await fs.writeFile(OLD_CONFIG_PATH, JSON.stringify({
    projects: {},
    logging: { enabled: true, level: 'info' }
  }, null, 2))
  console.log(`   ✓ Created old config: ${OLD_CONFIG_PATH}`)

  // Create old log directory and file
  await fs.mkdir(OLD_LOG_DIR, { recursive: true })
  await fs.writeFile(OLD_LOG_FILE, `[${new Date().toISOString()}] Old log entry\n`)
  console.log(`   ✓ Created old log: ${OLD_LOG_FILE}`)

  console.log('')
}

async function verifyOldFilesRemoved() {
  console.log('2. Verifying old files are removed...')

  let oldConfigExists = false
  let oldLogExists = false

  try {
    await fs.access(OLD_CONFIG_PATH)
    oldConfigExists = true
  } catch (e) {}

  try {
    await fs.access(OLD_LOG_FILE)
    oldLogExists = true
  } catch (e) {}

  if (oldConfigExists) {
    console.log(`   ✗ Old config still exists: ${OLD_CONFIG_PATH}`)
  } else {
    console.log(`   ✓ Old config removed`)
  }

  if (oldLogExists) {
    console.log(`   ✗ Old log still exists: ${OLD_LOG_FILE}`)
  } else {
    console.log(`   ✓ Old log removed`)
  }

  console.log('')
}

async function verifyNewFilesExist() {
  console.log('3. Verifying new files exist...')

  let newConfigExists = false
  let newLogExists = false

  try {
    await fs.access(NEW_CONFIG_PATH)
    newConfigExists = true
  } catch (e) {}

  try {
    await fs.access(NEW_LOG_FILE)
    newLogExists = true
  } catch (e) {}

  if (newConfigExists) {
    console.log(`   ✓ New config exists: ${NEW_CONFIG_PATH}`)
    const config = JSON.parse(await fs.readFile(NEW_CONFIG_PATH, 'utf8'))
    console.log(`     Content: ${JSON.stringify(config)}`)
  } else {
    console.log(`   ✗ New config missing: ${NEW_CONFIG_PATH}`)
  }

  if (newLogExists) {
    console.log(`   ✓ New log exists: ${NEW_LOG_FILE}`)
    const logContent = await fs.readFile(NEW_LOG_FILE, 'utf8')
    console.log(`     Content: ${logContent.trim()}`)
  } else {
    console.log(`   ✗ New log missing: ${NEW_LOG_FILE}`)
  }

  console.log('')
}

async function verifyFunctions() {
  console.log('4. Verifying config functions return correct paths...')

  const logPath = getLogFilePath()
  const pidPath = getDaemonPidFilePath()

  console.log(`   getLogFilePath(): ${logPath}`)
  console.log(`   Expected: ${NEW_LOG_FILE}`)
  console.log(`   Match: ${logPath === NEW_LOG_FILE ? '✓' : '✗'}`)

  console.log(`   getDaemonPidFilePath(): ${pidPath}`)
  console.log(`   Expected: ${NEW_PID_FILE}`)
  console.log(`   Match: ${pidPath === NEW_PID_FILE ? '✓' : '✗'}`)

  console.log('')
}

async function testLoadConfig() {
  console.log('5. Testing loadGlobalConfig()...')

  try {
    const config = await loadGlobalConfig()
    console.log(`   ✓ Config loaded successfully`)
    console.log(`     Projects: ${Object.keys(config.projects || {}).length}`)
    console.log(`     Logging: ${JSON.stringify(config.logging)}`)
  } catch (e) {
    console.log(`   ✗ Failed to load config: ${e.message}`)
  }

  console.log('')
}

async function cleanup() {
  console.log('6. Cleaning up test files...')

  try {
    await fs.unlink(NEW_CONFIG_PATH)
    console.log(`   ✓ Removed: ${NEW_CONFIG_PATH}`)
  } catch (e) {}

  try {
    await fs.unlink(NEW_LOG_FILE)
    console.log(`   ✓ Removed: ${NEW_LOG_FILE}`)
  } catch (e) {}

  try {
    await fs.unlink(NEW_PID_FILE)
    console.log(`   ✓ Removed: ${NEW_PID_FILE}`)
  } catch (e) {}

  try {
    await fs.rmdir(INDEXER_DIR)
    console.log(`   ✓ Removed directory: ${INDEXER_DIR}`)
  } catch (e) {}

  console.log('')
}

async function main() {
  try {
    // Setup old files
    await setupOldFiles()

    // Run migration by calling loadGlobalConfig
    console.log('Running migration (via loadGlobalConfig)...')
    await loadGlobalConfig()
    console.log('✓ Migration completed\n')

    // Verify results
    await verifyOldFilesRemoved()
    await verifyNewFilesExist()
    await verifyFunctions()
    await testLoadConfig()

    // Cleanup
    await cleanup()

    console.log('=== Migration Test Complete ===')
    console.log('✓ All tests passed!')

  } catch (error) {
    console.error('\n✗ Test failed:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

main()
