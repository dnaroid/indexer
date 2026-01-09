import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import http from 'http'
import readline from 'readline'
import { spawn, ChildProcess } from 'child_process'
import { getProjectCollectionName } from '../lib/utils/config-global.js'
import { getPaths, renderMcpProxyScript } from '../lib/cli/cli-config.js'

const TEST_ROOT = path.resolve(process.cwd(), 'tests_daemon_proxy_autostart')
const TEST_HOME = path.join(TEST_ROOT, 'home')
const PROJECT_DIR = path.join(TEST_ROOT, 'project')
const BIN_DIR = path.join(TEST_ROOT, 'bin')
const PROXY_SCRIPT_PATH = path.join(TEST_ROOT, 'mcp-server.js')
const INDEXER_DIR = path.join(TEST_HOME, '.indexer')
const DAEMON_PID_FILE = path.join(INDEXER_DIR, 'daemon.pid')
const DAEMON_PORT_FILE = path.join(INDEXER_DIR, 'daemon.port')

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = http.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close()
      resolve(true)
    })
    server.listen(port, '127.0.0.1')
  })
}

async function findAvailablePort(startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 100; port++) {
    if (await isPortAvailable(port)) {
      return port
    }
  }
  throw new Error(`No available ports found in range ${startPort}-${startPort + 99}`)
}

async function writeGlobalConfig(projectDir: string, collectionId: string) {
  await fs.mkdir(INDEXER_DIR, { recursive: true })
  const absPath = path.resolve(projectDir)
  const config = {
    projects: {
      [absPath]: {
        collectionName: collectionId,
        settings: {}
      }
    },
    logging: { enabled: true, level: 'info' }
  }
  await fs.writeFile(path.join(INDEXER_DIR, 'config.json'), JSON.stringify(config, null, 2), 'utf8')
}

async function createIndexerStub(binDir: string) {
  await fs.mkdir(binDir, { recursive: true })
  const buildIndexer = path.resolve(process.cwd(), 'build', 'indexer.js')
  if (process.platform === 'win32') {
    const cmdPath = path.join(binDir, 'indexer.cmd')
    const content = `@echo off\r\nnode "${buildIndexer}" %*\r\n`
    await fs.writeFile(cmdPath, content, 'utf8')
    return
  }

  const scriptPath = path.join(binDir, 'indexer')
  const content = `#!/bin/sh\nnode "${buildIndexer}" "$@"\n`
  await fs.writeFile(scriptPath, content, 'utf8')
  await fs.chmod(scriptPath, 0o755)
}

async function stopDaemon(): Promise<void> {
  try {
    const pidStr = await fs.readFile(DAEMON_PID_FILE, 'utf8')
    const pid = parseInt(pidStr.trim(), 10)
    if (!Number.isFinite(pid)) {
      return
    }
    try {
      process.kill(pid, 'SIGTERM')
    } catch (e) {
      return
    }

    const start = Date.now()
    while (Date.now() - start < 5000) {
      try {
        process.kill(pid, 0)
        await new Promise(resolve => setTimeout(resolve, 100))
      } catch (e) {
        return
      }
    }

    try {
      process.kill(pid, 'SIGKILL')
    } catch (e) {}
  } catch (e) {
    return
  }
}

function createLineReader(stream: NodeJS.ReadableStream) {
  const rl = readline.createInterface({ input: stream })
  const queue: string[] = []
  const waiters: Array<(line: string) => void> = []

  rl.on('line', (line) => {
    if (waiters.length > 0) {
      const resolve = waiters.shift()!
      resolve(line)
    } else {
      queue.push(line)
    }
  })

  function nextLine(timeoutMs = 20000): Promise<string> {
    if (queue.length > 0) {
      return Promise.resolve(queue.shift() as string)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Timeout waiting for proxy response'))
      }, timeoutMs)
      waiters.push((line) => {
        clearTimeout(timer)
        resolve(line)
      })
    })
  }

  return { nextLine, close: () => rl.close() }
}

async function setupProject() {
  await fs.rm(TEST_ROOT, { recursive: true, force: true })
  await fs.mkdir(TEST_ROOT, { recursive: true })
  await fs.mkdir(PROJECT_DIR, { recursive: true })
  await fs.writeFile(path.join(PROJECT_DIR, 'main.js'), 'console.log("ok")\n', 'utf8')
  await fs.writeFile(path.join(PROJECT_DIR, '.indexerignore'), '', 'utf8')
}

test('Proxy auto-starts daemon on first MCP request', { timeout: 60000 }, async (t) => {
  let proxyProcess: ChildProcess | null = null

  t.after(async () => {
    if (proxyProcess) {
      proxyProcess.kill('SIGTERM')
      proxyProcess = null
    }
    await stopDaemon()
    await fs.rm(TEST_ROOT, { recursive: true, force: true })
  })

  await setupProject()

  const collectionId = getProjectCollectionName(PROJECT_DIR)
  await writeGlobalConfig(PROJECT_DIR, collectionId)

  const port = await findAvailablePort(35600)
  await fs.writeFile(DAEMON_PORT_FILE, String(port), 'utf8')

  await createIndexerStub(BIN_DIR)

  const proxyScript = await renderMcpProxyScript(getPaths(PROJECT_DIR), collectionId)
  await fs.writeFile(PROXY_SCRIPT_PATH, proxyScript, 'utf8')
  await fs.chmod(PROXY_SCRIPT_PATH, 0o755)

  const env = { ...process.env }
  env.HOME = TEST_HOME
  env.USERPROFILE = TEST_HOME
  env.PATH = `${BIN_DIR}${path.delimiter}${process.env.PATH || ''}`
  delete env.NODE_ENV

  proxyProcess = spawn('node', [PROXY_SCRIPT_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env
  })

  let stderr = ''
  proxyProcess.stderr?.on('data', (data) => {
    stderr += data.toString()
  })

  const reader = createLineReader(proxyProcess.stdout!)

  const initRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'test-client',
        version: '1.0.0'
      }
    }
  }

  proxyProcess.stdin?.write(JSON.stringify(initRequest) + '\n')

  const initLine = await reader.nextLine(30000)
  const initResponse = JSON.parse(initLine)
  assert.ok(!initResponse.error, `Initialize failed: ${initResponse.error?.message || 'unknown'}\n${stderr}`)

  const toolRequest = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'get_project_structure',
      arguments: {}
    }
  }

  proxyProcess.stdin?.write(JSON.stringify(toolRequest) + '\n')

  const toolLine = await reader.nextLine(20000)
  const toolResponse = JSON.parse(toolLine)
  assert.ok(!toolResponse.error, `Tool call failed: ${toolResponse.error?.message || 'unknown'}\n${stderr}`)

  const treeText = toolResponse.result?.content?.[0]?.text || ''
  assert.ok(treeText.includes('main.js'), 'Expected project structure to include main.js')

  reader.close()
})
