#!/usr/bin/env node

import {createRequire} from 'module'
import {
  printBanner, restoreTerminal, printHelp, pickOption, fail
} from './lib/cli-ui.js'
import {
  handleInit, handleStatus, handleCleanIndex, handleListCollections, handleDeleteCollection,
  handlePruneAll, handleMcp, handleUninstall, handleUpdate, checkAndAutoUpdate, handleLogs,
  isDaemonRunning, handleStartDaemon
} from './lib/cli-actions.js'

const require = createRequire(import.meta.url)
const pkg = require('./package.json')

const args = process.argv.slice(2)
let command = null
let projectPathArg = null

const cleanArgs = []
for (const arg of args) {
  if (arg.startsWith('--project=')) {
    projectPathArg = arg.split('=')[1]
  } else if (!command) {
    command = arg
  } else {
    cleanArgs.push(arg)
  }
}

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
  while (true) {
    const daemonRunning = await isDaemonRunning()
    
    const options = [
      {label: 'init        - create .indexer/ config', value: 'init'},
      {label: 'index       - force index rebuild (was clean)', value: 'index'},
      {label: 'status      - show status', value: 'status'},
      {label: 'start-daemon - start the background indexing daemon', value: 'start-daemon'},
    ]

    if (daemonRunning) {
      options.push({label: 'logs        - tail daemon logs', value: 'logs'})
    }

    options.push(
      {label: 'collections - list global Qdrant collections', value: 'collections'},
      {label: 'delete      - delete collections (select or all)', value: 'delete'},
      {label: 'update      - update CLI to latest version', value: 'update'},
      {label: 'uninstall   - remove project from index & config', value: 'uninstall'},
      {label: 'quit', value: 'exit'}
    )

    const choice = await pickOption(options)
    if (!choice || choice === 'exit') {
      return
    }

    console.log(`\x1b[38;5;51m> indexer ${choice}\x1b[0m`)

    switch(choice) {
    case 'init':
      await handleInit(startCwd)
        .catch((e) => {
          if (e.message !== 'INDEXER_ALREADY_EXISTS') throw e
        })
      break
    case 'status':
      await handleStatus(startCwd)
      break
    case 'index':
    case 'clean':
      await handleCleanIndex(startCwd)
      break
    case 'start-daemon':
      await handleStartDaemon(startCwd)
      break
    case 'logs':
      await handleLogs()
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

  // Check updates on startup
  await checkAndAutoUpdate(command)

  if (!command) {
    await handleStatus(startCwd)
    console.log('')
    await interactiveMenu()
    restoreTerminal()
    process.exit(0)
    return
  }

  switch(command) {
  case 'init':
    await handleInit(startCwd)
      .catch((e) => {
        if (e.message === 'INDEXER_ALREADY_EXISTS') process.exit(1)
        throw e
      })
    break
  case 'index':
  case 'clean':
  case 'clear':
    await handleCleanIndex(startCwd)
    break
  case 'logs':
  case 'log':
    await handleLogs()
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
  case 'start-daemon':
    await handleStartDaemon(startCwd)
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
    await handleMcp(cleanArgs, startCwd, projectPathArg)
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

  if (command !== 'mcp' && command !== 'logs') {
    process.exit(0)
  }
}

main().catch((e) => {
  fail(e.message)
})
