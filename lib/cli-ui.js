import readline from 'readline'
import {createInterface} from 'readline/promises'
import {stdin as input, stdout as output} from 'node:process'
import {writeSync} from 'fs'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const pkg = require('../package.json')

let terminalRestored = false

export function restoreTerminal() {
  // Always try to reset raw mode if needed
  try {
    if (process.stdin.isTTY) {
      if (process.stdin.setRawMode) {
        process.stdin.setRawMode(false)
      }
    }
  } catch (e) {}

  // Always try to show cursor directly to stdout fd (1)
  try {
    writeSync(1, '\x1b[?25h')
  } catch (e) {
    // Fallback
    try {
      process.stdout.write('\x1b[?25h')
    } catch (e2) {}
  }

  terminalRestored = true
}

export function log(msg) {
  console.log(`[indexer] ${msg}`)
}

export function warn(msg) {
  console.warn(`[indexer] ${msg}`)
}

export function fail(msg, code = 1) {
  restoreTerminal()
  console.error(`[indexer] ${msg}`)
  process.exitCode = code
  process.exit(code)
}

export async function confirmAction(question) {
  const rl = createInterface({input, output})
  const answer = await rl.question(question + ' (y/N): ')
  rl.close()
  return answer.trim().toLowerCase() === 'y'
}

export function printBanner() {
  console.log(`
\x1b[38;5;27m███╗   ███╗\x1b[38;5;33m ██████╗ \x1b[38;5;39m██████╗ \x1b[38;5;45m  ██╗███╗   ██╗██████╗ ███████╗██╗  ██╗███████╗██████╗\x1b[0m
\x1b[38;5;27m████╗ ████║\x1b[38;5;33m██╔════╝\x1b[38;5;39m██╔═══██╗\x1b[38;5;45m  ██║████╗  ██║██╔══██╗██╔════╝╚██╗██╔╝██╔════╝██╔══██╗\x1b[0m
\x1b[38;5;27m██╔████╔██║\x1b[38;5;33m██║     \x1b[38;5;39m██║   ██║\x1b[38;5;45m  ██║██╔██╗ ██║██║  ██║█████╗   ╚███╔╝ █████╗  ██████╔╝\x1b[0m
\x1b[38;5;27m██║╚██╔╝██║\x1b[38;5;33m██║     \x1b[38;5;39m██████╔╝ \x1b[38;5;45m  ██║██║╚██╗██║██║  ██║██╔══╝   ██╔██╗ ██╔══╝  ██╔══██╗\x1b[0m
\x1b[38;5;27m██║ ╚═╝ ██║\x1b[38;5;33m╚██████╗\x1b[38;5;39m██╔═══╝  \x1b[38;5;45m  ██║██║ ╚████║██████╔╝███████╗██╔╝ ██╗███████╗██║  ██║\x1b[0m
\x1b[38;5;27m╚═╝     ╚═╝\x1b[38;5;33m ╚═════╝\x1b[38;5;39m╚═╝      \x1b[38;5;45m  ╚═╝╚═╝  ╚═══╝╚═════╝ ╚══════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝\x1b[0m

\x1b[38;5;244mMCP Indexer • Local Code Indexing & MCP Server • v${pkg.version}\x1b[0m
`)
}

export async function pickOption(options, initial = 0) {
  // Reset restored flag because we are entering interactive mode again
  terminalRestored = false

  if (!process.stdin.isTTY) {
    console.log('Select action:')
    options.forEach((o, i) => console.log(`  ${i + 1}) ${o.label}`))
    const rl = createInterface({input, output})
    const answer = (await rl.question(`Choice [1-${options.length}]: `)).trim().toLowerCase()
    rl.close()
    if (answer === 'exit' || answer === 'quit') {
      return 'exit'
    }
    const n = Number(answer)
    if (Number.isInteger(n) && n >= 1 && n <= options.length) {
      return options[n - 1].value
    }
    return 'exit'
  }

  return await new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin)
    const wasRaw = process.stdin.isRaw
    const wasPaused = typeof process.stdin.isPaused === 'function' ? process.stdin.isPaused() : undefined
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
    }
    if (wasPaused) {
      process.stdin.resume()
    }
    // Hide cursor
    process.stdout.write('\x1b[?25l')

    let idx = initial
    let firstRender = true
    const linesCount = options.length + 1

    const render = () => {
      if (!firstRender) {
        process.stdout.write(`\u001b[${linesCount}A\u001b[0J`)
      }
      process.stdout.write('\x1b[90mSelect action (↑/↓, Enter, Esc to quit):\x1b[0m\n')
      options.forEach((opt, i) => {
        if (i === idx) {
          process.stdout.write(`\x1b[38;5;51m> ${opt.label}\x1b[0m\n`)
        } else {
          process.stdout.write(`  \x1b[38;5;250m${opt.label}\x1b[0m\n`)
        }
      })
      firstRender = false
    }

    const cleanup = () => {
      process.removeListener('exit', cleanup)
      process.removeListener('SIGINT', cleanup)
      process.stdin.removeListener('keypress', onKey)
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(wasRaw || false)
      }
      if (wasPaused) {
        process.stdin.pause()
      }

      // Use direct writes to avoid buffering issues during exit
      try {
        writeSync(1, `\u001b[${linesCount}A\u001b[0J\n`)
      } catch (e) {
        process.stdout.write(`\u001b[${linesCount}A\u001b[0J\n`)
      }

      // Show cursor last to ensure it persists
      restoreTerminal()
    }

    // Safety guards
    process.once('exit', cleanup)
    process.once('SIGINT', cleanup)

    const onKey = (str, key) => {
      if (key.name === 'down') {
        idx = (idx + 1) % options.length
        render()
      } else if (key.name === 'up') {
        idx = (idx - 1 + options.length) % options.length
        render()
      } else if (key.name === 'return') {
        cleanup()
        resolve(options[idx].value)
      } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        cleanup()
        resolve('exit')
      } else if (/^[1-9]$/.test(str)) {
        const n = Number(str) - 1
        if (n >= 0 && n < options.length) {
          idx = n
          render()
        }
      }
    }

    render()
    process.stdin.on('keypress', onKey)
  })
}

export function printHelp() {
  console.log(`indexer CLI (Local Mode)\n\n` +
              `Usage:\n` +
              `  indexer init         # create .indexer/ configs
 ` +
              `  indexer clean        # drop & reindex current project (alias: clear)
 ` +
              `  indexer status       # show status
 ` +
              `  indexer logs         # tail daemon logs (alias: log)
 ` +
              `  indexer projects      # list all tracked projects
 ` +
              `  indexer delete [id]  # delete project (interactive if no id)
 ` +
              `  indexer uninstall    # remove .indexer/ from current project
 ` +
              `  indexer mcp          # run MCP server (internal usage)\n`)
}
