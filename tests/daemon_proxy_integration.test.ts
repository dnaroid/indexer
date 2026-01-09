import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import http from 'http'
import { spawn, ChildProcess } from 'child_process'
import {
  getProjectCollectionName,
  addProjectToConfig,
  removeProjectFromConfig
} from '../lib/utils/config-global.js'

/**
 * Integration test: Daemon + Proxy with real MCP clients
 *
 * This test emulates code agents connecting to the daemon via proxy scripts.
 * It verifies:
 * - Multiple clients can connect simultaneously
 * - Each client sees only their project (collection isolation)
 * - get_project_structure tool works correctly for each client
 */

const TEST_ROOT = path.resolve(process.cwd(), 'tests_daemon_proxy')
const PROJECT_A_DIR = path.join(TEST_ROOT, 'project-a')
const PROJECT_B_DIR = path.join(TEST_ROOT, 'project-b')
const DAEMON_PORT = 34568 // Use non-default port to avoid conflicts
const DAEMON_SCRIPT = path.resolve(process.cwd(), 'build/lib/services/indexer-service.js')

let daemonProcess: ChildProcess | null = null
let collectionIdA: string
let collectionIdB: string

/**
 * Setup test projects with different file structures
 */
async function setupTestProjects() {
  await fs.rm(TEST_ROOT, { recursive: true, force: true })
  await fs.mkdir(TEST_ROOT, { recursive: true })

  // Project A: Simple structure
  await fs.mkdir(PROJECT_A_DIR, { recursive: true })
  await fs.writeFile(
    path.join(PROJECT_A_DIR, 'app.js'),
    `
class Application {
  start() { console.log('App A started') }
}
    `.trim()
  )
  await fs.mkdir(path.join(PROJECT_A_DIR, 'modules'))
  await fs.writeFile(
    path.join(PROJECT_A_DIR, 'modules/auth.js'),
    `
function authenticate(user) { return true }
    `.trim()
  )
  await fs.writeFile(path.join(PROJECT_A_DIR, 'README.md'), '# Project A')

  // Create .indexerignore for Project A to exclude nothing (test all files)
  await fs.writeFile(path.join(PROJECT_A_DIR, '.indexerignore'), '')

  // Project B: Different structure
  await fs.mkdir(PROJECT_B_DIR, { recursive: true })
  await fs.mkdir(path.join(PROJECT_B_DIR, 'src'))
  await fs.writeFile(
    path.join(PROJECT_B_DIR, 'src/main.py'),
    `
def main():
    print("Project B")

if __name__ == "__main__":
    main()
    `.trim()
  )
  await fs.mkdir(path.join(PROJECT_B_DIR, 'tests'))
  await fs.writeFile(
    path.join(PROJECT_B_DIR, 'tests/test_main.py'),
    `
def test_main():
    assert True
    `.trim()
  )
  await fs.writeFile(path.join(PROJECT_B_DIR, 'setup.py'), '# Setup script')

  // Create .indexerignore for Project B
  await fs.writeFile(path.join(PROJECT_B_DIR, '.indexerignore'), '')

  // Register projects in global config
  await addProjectToConfig(PROJECT_A_DIR)
  await addProjectToConfig(PROJECT_B_DIR)

  // Generate collection IDs
  collectionIdA = getProjectCollectionName(PROJECT_A_DIR)
  collectionIdB = getProjectCollectionName(PROJECT_B_DIR)

  console.log(`[TEST] Project A registered with collectionId: ${collectionIdA}`)
  console.log(`[TEST] Project B registered with collectionId: ${collectionIdB}`)
}

/**
 * Check if daemon is ready by making a health check request
 */
async function checkDaemonHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: DAEMON_PORT,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 1000
      },
      (res) => {
        // Any response means daemon is up
        resolve(true)
      }
    )

    req.on('error', () => {
      resolve(false)
    })

    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })

    // Send a test request
    req.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
    req.end()
  })
}

/**
 * Start daemon process
 */
async function startDaemon(): Promise<void> {
  console.log(`[TEST] Starting daemon on port ${DAEMON_PORT}...`)

  daemonProcess = spawn('node', [DAEMON_SCRIPT, '--mcp-http', '--port', String(DAEMON_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test' }
  })

  // Log daemon output for debugging
  daemonProcess.stdout?.on('data', (data) => {
    const output = data.toString()
    if (output.includes('error') || output.includes('Error')) {
      console.log('[DAEMON STDOUT]', output)
    }
  })

  daemonProcess.stderr?.on('data', (data) => {
    const output = data.toString()
    if (output.includes('error') || output.includes('Error')) {
      console.log('[DAEMON STDERR]', output)
    }
  })

  daemonProcess.on('error', (err) => {
    console.error('[TEST] Failed to spawn daemon:', err)
    throw new Error(`Failed to start daemon: ${err.message}`)
  })

  daemonProcess.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`[TEST] Daemon exited unexpectedly with code ${code}, signal ${signal}`)
    }
  })

  // Wait for daemon to be ready by polling health endpoint
  const maxAttempts = 30 // 30 seconds max
  const delayMs = 1000

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, delayMs))

    if (await checkDaemonHealth()) {
      console.log(`[TEST] Daemon is ready after ${i + 1} attempts`)
      return
    }

    console.log(`[TEST] Waiting for daemon... (attempt ${i + 1}/${maxAttempts})`)
  }

  throw new Error('Daemon failed to start within timeout period')
}

/**
 * Stop daemon process
 */
async function stopDaemon(): Promise<void> {
  if (daemonProcess) {
    console.log('[TEST] Stopping daemon...')
    daemonProcess.kill('SIGTERM')

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        daemonProcess?.kill('SIGKILL')
        resolve()
      }, 3000)

      daemonProcess?.on('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })

    daemonProcess = null
    console.log('[TEST] Daemon stopped')
  }
}

/**
 * HTTP client for MCP protocol with session management
 */
class McpHttpClient {
  private sessionId: string | null = null
  private requestId = 1

  constructor(
    private port: number,
    private collectionId: string
  ) {}

  /**
   * Send MCP request
   */
  private async sendRequest(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      // Inject collectionId into tool arguments for tools/call method
      if (method === 'tools/call' && params && params.arguments) {
        params.arguments.collectionId = this.collectionId
      }

      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: this.requestId++,
        method,
        params
      })

      const headers: any = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body)
      }

      // Include session ID for non-initialize requests
      if (this.sessionId && method !== 'initialize') {
        headers['mcp-session-id'] = this.sessionId
      }

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: this.port,
          path: '/mcp',
          method: 'POST',
          headers
        },
        (res) => {
          // Extract session ID from initialize response
          if (method === 'initialize' && res.headers['mcp-session-id']) {
            this.sessionId = res.headers['mcp-session-id'] as string
            console.log(`[TEST] Session initialized: ${this.sessionId}`)
          }

          // Handle SSE response
          if (res.headers['content-type']?.includes('text/event-stream')) {
            let sseBuffer = ''

            res.on('data', (chunk) => {
              sseBuffer += chunk.toString()

              let idx
              while ((idx = sseBuffer.indexOf('\n\n')) !== -1) {
                const message = sseBuffer.substring(0, idx)
                sseBuffer = sseBuffer.substring(idx + 2)

                const lines = message.split('\n')
                let event = 'message'
                let data = ''

                for (const line of lines) {
                  if (line.startsWith('event: ')) {
                    event = line.substring(7).trim()
                  } else if (line.startsWith('data: ')) {
                    data += line.substring(6)
                  }
                }

                if (event === 'message' && data) {
                  try {
                    const json = JSON.parse(data)
                    resolve(json)
                  } catch (e) {
                    reject(new Error(`Failed to parse SSE data: ${data}`))
                  }
                  return
                }
              }
            })

            res.on('end', () => {
              // If we haven't resolved yet, no valid message was received
              reject(new Error('SSE stream ended without valid message'))
            })
          } else {
            // Handle JSON response
            let body = ''
            res.on('data', (chunk) => { body += chunk })
            res.on('end', () => {
              try {
                const json = JSON.parse(body)
                resolve(json)
              } catch (e) {
                reject(new Error(`Failed to parse JSON response: ${body}`))
              }
            })
          }
        }
      )

      req.on('error', (err) => {
        reject(new Error(`Request error: ${err.message}`))
      })

      req.write(body)
      req.end()
    })
  }

  /**
   * Initialize MCP session
   */
  async initialize(): Promise<void> {
    const response = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'test-client',
        version: '1.0.0'
      }
    })

    if (response.error) {
      throw new Error(`Initialize failed: ${response.error.message}`)
    }
  }

  /**
   * Call MCP tool
   */
  async callTool(name: string, args: any = {}): Promise<any> {
    const response = await this.sendRequest('tools/call', {
      name,
      arguments: args
    })

    if (response.error) {
      throw new Error(`Tool call failed: ${response.error.message}`)
    }

    return response.result
  }

  /**
   * Close session
   */
  close() {
    this.sessionId = null
  }
}

// --- Tests ---

test.before(async () => {
  await setupTestProjects()
  await startDaemon()

  // Wait a bit for daemon to be fully ready
  await new Promise(resolve => setTimeout(resolve, 2000))
})

test.after(async () => {
  await stopDaemon()

  // Clean up projects from global config
  await removeProjectFromConfig(PROJECT_A_DIR)
  await removeProjectFromConfig(PROJECT_B_DIR)

  await fs.rm(TEST_ROOT, { recursive: true, force: true })
})

test('Multiple clients can connect to daemon simultaneously', async () => {
  const clientA = new McpHttpClient(DAEMON_PORT, collectionIdA)
  const clientB = new McpHttpClient(DAEMON_PORT, collectionIdB)

  await clientA.initialize()
  await clientB.initialize()

  // Both clients should be connected
  assert.ok(clientA, 'Client A connected')
  assert.ok(clientB, 'Client B connected')

  clientA.close()
  clientB.close()
})

test('get_project_structure returns correct structure for Project A', async () => {
  const client = new McpHttpClient(DAEMON_PORT, collectionIdA)
  await client.initialize()

  const result = await client.callTool('get_project_structure', {})

  // Result should be in MCP format with content array
  assert.ok(result.content, 'Result should have content array')
  assert.ok(Array.isArray(result.content), 'Content should be an array')
  assert.ok(result.content.length > 0, 'Content should not be empty')

  const tree = result.content[0].text
  console.log('[TEST] Project A structure:\n', tree)

  // Verify expected files are present
  assert.ok(tree.includes('app.js'), 'Should contain app.js')
  assert.ok(tree.includes('modules'), 'Should contain modules directory')
  assert.ok(tree.includes('auth.js'), 'Should contain auth.js')
  assert.ok(tree.includes('README.md'), 'Should contain README.md')

  // Verify Project B files are NOT present
  assert.ok(!tree.includes('main.py'), 'Should NOT contain main.py from Project B')
  assert.ok(!tree.includes('setup.py'), 'Should NOT contain setup.py from Project B')

  client.close()
})

test('get_project_structure returns correct structure for Project B', async () => {
  const client = new McpHttpClient(DAEMON_PORT, collectionIdB)
  await client.initialize()

  const result = await client.callTool('get_project_structure', {})

  const tree = result.content[0].text
  console.log('[TEST] Project B structure:\n', tree)

  // Verify expected files are present
  assert.ok(tree.includes('src'), 'Should contain src directory')
  assert.ok(tree.includes('main.py'), 'Should contain main.py')
  assert.ok(tree.includes('tests'), 'Should contain tests directory')
  assert.ok(tree.includes('test_main.py'), 'Should contain test_main.py')
  assert.ok(tree.includes('setup.py'), 'Should contain setup.py')

  // Verify Project A files are NOT present
  assert.ok(!tree.includes('app.js'), 'Should NOT contain app.js from Project A')
  assert.ok(!tree.includes('auth.js'), 'Should NOT contain auth.js from Project A')

  client.close()
})

test('Collection isolation: clients can only access their own collections', async () => {
  const clientA = new McpHttpClient(DAEMON_PORT, collectionIdA)
  const clientB = new McpHttpClient(DAEMON_PORT, collectionIdB)

  await clientA.initialize()
  await clientB.initialize()

  // Client A requests its structure
  const resultA = await clientA.callTool('get_project_structure', {})
  const treeA = resultA.content[0].text

  // Client B requests its structure
  const resultB = await clientB.callTool('get_project_structure', {})
  const treeB = resultB.content[0].text

  // Verify complete isolation
  assert.ok(treeA.includes('app.js'), 'Client A should see app.js')
  assert.ok(!treeA.includes('main.py'), 'Client A should NOT see main.py')

  assert.ok(treeB.includes('main.py'), 'Client B should see main.py')
  assert.ok(!treeB.includes('app.js'), 'Client B should NOT see app.js')

  clientA.close()
  clientB.close()
})

test('Multiple simultaneous requests from different clients', async () => {
  const clientA = new McpHttpClient(DAEMON_PORT, collectionIdA)
  const clientB = new McpHttpClient(DAEMON_PORT, collectionIdB)

  await clientA.initialize()
  await clientB.initialize()

  // Send requests in parallel
  const [resultA, resultB] = await Promise.all([
    clientA.callTool('get_project_structure', {}),
    clientB.callTool('get_project_structure', {})
  ])

  // Both should succeed and return correct results
  const treeA = resultA.content[0].text
  const treeB = resultB.content[0].text

  assert.ok(treeA.includes('app.js'), 'Parallel request A should succeed')
  assert.ok(treeB.includes('main.py'), 'Parallel request B should succeed')

  clientA.close()
  clientB.close()
})

test('Client reconnection with new session', async () => {
  const client = new McpHttpClient(DAEMON_PORT, collectionIdA)

  // First connection
  await client.initialize()

  const result1 = await client.callTool('get_project_structure', {})
  assert.ok(result1.content[0].text.includes('app.js'), 'First connection should work')

  client.close()

  // Reconnect with new session
  const client2 = new McpHttpClient(DAEMON_PORT, collectionIdA)
  await client2.initialize()

  const result2 = await client2.callTool('get_project_structure', {})
  assert.ok(result2.content[0].text.includes('app.js'), 'Reconnection should work')

  client2.close()
})
