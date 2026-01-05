#!/usr/bin/env node

import {createRequire} from 'module'
import {
  printBanner, restoreTerminal, printHelp, pickOption, fail
} from './lib/cli-ui.js'
import {
  handleInit, handleStatus, handleCleanIndex, handleListCollections, handleDeleteCollection,
  handlePruneAll, handleMcp, handleUninstall, handleUpdate, checkAndAutoUpdate
} from './lib/cli-actions.js'

const require = createRequire(import.meta.url)
const pkg = require('./package.json')

const args = process.argv.slice(2)
const command = args.length > 0 ? args[0] : null
const startCwd = process.cwd()

// Ensure cursor is restored on exit/interrupt/error
const exitHandler = () => {
  restoreTerminal()
}

process.on('exit', exitHandler)

process.on('SIGINT', () => {
  exitHandler()
  process.exit(130)
})

process.on('SIGTERM', () => {
  exitHandler()
  process.exit(143)
})

process.on('uncaughtException', (err) => {
  exitHandler()
  console.error('[indexer] Uncaught Exception:', err)
  process.exit(1)
})

process.on('unhandledRejection', (err) => {
  exitHandler()
  console.error('[indexer] Unhandled Rejection:', err)
  process.exit(1)
})

async function interactiveMenu() {
  const options = [
    {label: 'init        - create .indexer/ config', value: 'init'},
    {label: 'clean       - drop & rebuild index (alias: clear)', value: 'clean'},
    {label: 'status      - show status', value: 'status'},
    {label: 'collections - list global Qdrant collections', value: 'collections'},
    {label: 'delete      - delete collections (select or all)', value: 'delete'},
    {label: 'update      - update CLI to latest version', value: 'update'},
    {label: 'uninstall   - remove .indexer/', value: 'uninstall'},
    {label: 'quit', value: 'exit'}
  ]

  while (true) {
    const choice = await pickOption(options)
    if (!choice || choice === 'exit') {
      return
    }

    console.log(`\x1b[38;5;51m> indexer ${choice}\x1b[0m`)

    switch(choice) {
    case 'init':
      await handleInit(startCwd)
      break
    case 'status':
      await handleStatus(startCwd)
      break
    case 'clean':
    case 'clear':
      await handleCleanIndex(startCwd)
      break
    case 'collections':
      await handleListCollections()
      break
    case 'delete':
      await handleDeleteCollection()
      break
    case 'update':
      await handleUpdate()
      break
    case 'uninstall':
      await handleUninstall(startCwd)
      break
    default:
      break
    }

    console.log('---')
  }
}

async function main() {
  if (!command || command === 'status') {
    printBanner()
  }

  // Check updates on startup for interactive mode, or status
  if (!command || command === 'status') {
    await checkAndAutoUpdate(command)
  }

  if (!command) {
    await interactiveMenu()
    restoreTerminal()
    process.exit(0)
    return
  }

  switch(command) {
  case 'init':
    await handleInit(startCwd)
    break
  case 'clean':
  case 'clear':
    await handleCleanIndex(startCwd)
    break
  case 'uninstall':
    await handleUninstall(startCwd)
    break
  case 'update':
    await handleUpdate()
    break
  case 'status':
    await handleStatus(startCwd)
    break
  case 'collections':
  case 'list':
  case 'ls':
    await handleListCollections()
    break
  case 'delete':
  case 'rm':
    await handleDeleteCollection(args[1])
    break
  case 'prune':
    await handlePruneAll()
    break
  case 'mcp':
    await handleMcp(args, startCwd)
    break
  case 'help':
  case '--help':
  case '-h':
    printHelp()
    break
  case 'version':
  case '--version':
    console.log(pkg.version)
    break
  default:
    fail(`Unknown command: ${command}`)
  }

  if (command !== 'mcp') {
    // Background check for updates (only if not running mcp server)
    // checkUpdateInBackground() // Removed as it was empty and we have sync check now
    process.exit(0)
  }
}

main().catch((e) => {
  fail(e.message)
})