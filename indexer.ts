#!/usr/bin/env node

import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import {
  printBanner,
  restoreTerminal,
  printHelp,
  pickOption,
  fail
} from './lib/cli/cli-ui.js'
import {
  findProjectRoot,
  getPaths,
  pathExists
} from './lib/cli/cli-config.js'
import {
  handleInit,
  handleStatus,
  handleCleanIndex,
  handlePruneAll,
  handleMcp,
  handleUninstall,
  handleLogs,
  checkAndAutoUpdate,
  handleListProjects,
  handleDeleteProject,
  handleTestCommand,
  handleUpdateMcp,
  handleStartDaemon,
  handleStopDaemon
} from './lib/cli/cli-actions.js'
import {
  isDaemonRunning
} from './lib/cli/daemon-manager.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const pkgPath = path.resolve(__dirname, '../package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))

const args = process.argv.slice(2)
let command: string | null = null
let projectPathArg: string | null = null

const cleanArgs: string[] = []
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
const exitHandler = (): void => {
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

process.on('uncaughtException', (err: Error) => {
  exitHandler()
  console.error('[indexer] Uncaught Exception:', err)
  process.exit(1)
})

process.on('unhandledRejection', (err: Error) => {
  exitHandler()
  console.error('[indexer] Unhandled Rejection:', err)
  process.exit(1)
})

interface CliOption {
  label: string
  value: string
}

async function interactiveMenu(): Promise<void> {
  while (true) {
    const root = await findProjectRoot(startCwd)
    const paths = getPaths(root)
    const isInstalled = await pathExists(paths.dotDir)
    const daemonRunning = await isDaemonRunning()

    const options: CliOption[] = []

    if (!isInstalled) {
      options.push({ label: 'init        - create .indexer/ config', value: 'init' })
    }

    options.push({ label: 'status      - show status', value: 'status' })
    options.push({ label: 'logs        - tail daemon logs', value: 'logs' })

    if (daemonRunning) {
      options.push({ label: 'stop        - stop daemon', value: 'stop' })
    } else {
      options.push({ label: 'start       - start daemon', value: 'start' })
    }

    if (isInstalled) {
      options.push({ label: 'index       - force index rebuild', value: 'index' })
    }

    options.push({ label: 'projects    - list tracked projects', value: 'projects' })
    options.push({ label: 'delete      - delete project (select or by number)', value: 'delete' })

    if (isInstalled) {
      options.push({ label: 'uninstall   - remove project from index & config', value: 'uninstall' })
      options.push({ label: 'test        - run MCP tool tests', value: 'test' })
    }

    options.push({ label: 'quit', value: 'exit' })

    const choice = await pickOption(options)
    if (!choice || choice === 'exit') {
      return
    }

    console.log(`\x1b[38;5;51m> indexer ${choice}\x1b[0m`)

    switch (choice) {
      case 'init':
        await handleInit(startCwd).catch((e: Error) => {
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
      case 'logs':
        await handleLogs()
        break
      case 'projects':
        await handleListProjects()
        break
      case 'delete':
        await handleDeleteProject()
        break
      case 'uninstall':
        await handleUninstall(startCwd)
        break
      case 'start':
        await handleStartDaemon()
        break
      case 'stop':
        await handleStopDaemon()
        break
      case 'test':
        const testOptions: CliOption[] = [
          { label: 'search_codebase', value: 'search_codebase' },
          { label: 'search_symbols', value: 'search_symbols' },
          { label: 'get_file_outline', value: 'get_file_outline' },
          { label: 'get_project_structure', value: 'get_project_structure' },
          { label: 'find_usages', value: 'find_usages' },
          { label: 'all', value: 'all' },
          { label: 'back', value: 'back' }
        ]
        const tool = await pickOption(testOptions)
        if (tool && tool !== 'back' && tool !== 'exit') {
          await handleTestCommand(startCwd, tool)
        }
        break
      default:
        break
    }

    console.log('---')
  }
}

async function main(): Promise<void> {
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

  switch (command) {
    case 'init':
      await handleInit(startCwd).catch((e: Error) => {
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
    case 'status':
      await handleStatus(startCwd)
      break
    case 'projects':
    case 'collections':
    case 'list':
    case 'ls':
      await handleListProjects()
      break
    case 'delete':
    case 'rm':
      await handleDeleteProject(args[1])
      break
    case 'prune':
      await handlePruneAll()
      break
    case 'test':
      await handleTestCommand(startCwd, cleanArgs[0])
      break
    case 'mcp':
      await handleMcp(cleanArgs, startCwd, projectPathArg as any)
      break
    case 'update-mcp':
      await handleUpdateMcp(startCwd)
      break
    case 'start':
      await handleStartDaemon()
      break
    case 'stop':
      await handleStopDaemon()
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

main().catch((e: Error) => {
  fail(e.message)
})
