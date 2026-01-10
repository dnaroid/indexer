/**
 * @internal Use adapters instead of direct client access
 * This class is now used internally by adapters and should not be used directly
 */

import { spawn, ChildProcess } from 'child_process'

interface PendingRequest {
  resolve: (value: any) => void
  reject: (reason: any) => void
  timer: NodeJS.Timeout
}

/**
 * LSP client for communicating with Language Server Protocol servers via JSON-RPC over stdio
 */
export class LspClient {
  private process: ChildProcess | null = null
  private buffer: string = ''
  private messageQueue: Map<number, PendingRequest> = new Map()
  private nextRequestId: number = 1
  private command: string
  private args: string[]
  private rootUri: string
  private initializationOptions: any
  private initialized: boolean = false
  private shutdownRequested: boolean = false

  constructor(
    command: string,
    args: string[],
    rootUri: string,
    initializationOptions: any = {}
  ) {
    this.command = command
    this.args = args
    this.rootUri = rootUri
    this.initializationOptions = initializationOptions
  }

  /**
   * Start the LSP server process and perform initialization handshake
   */
  async start(): Promise<void> {
    if (this.initialized) {
      throw new Error('LSP client already started')
    }

    // Spawn the LSP server process
    try {
      this.process = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env
      })
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        throw new Error(
          `LSP server not found: ${this.command}\n` +
          `Please install it first. For TypeScript:\n` +
          `  npm install -g typescript-language-server typescript`
        )
      }
      throw err
    }

    if (!this.process || !this.process.stdout || !this.process.stderr || !this.process.stdin) {
      throw new Error('Failed to spawn LSP server process')
    }

    // Handle process errors
    this.process.on('error', (err: any) => {
      if (err.code === 'ENOENT') {
        const error = new Error(
          `LSP server not found: ${this.command}\n` +
          `Please install it first. For TypeScript:\n` +
          `  npm install -g typescript-language-server typescript`
        )
        this.rejectAllPending(error)
      } else {
        this.rejectAllPending(err)
      }
    })

    // Handle process exit
    this.process.on('exit', (code, signal) => {
      console.log(`[lsp-client] Process exited with code ${code}, signal ${signal}`)
      if (!this.shutdownRequested) {
        this.rejectAllPending(new Error(`LSP server process exited unexpectedly (code: ${code}, signal: ${signal})`))
      }
      this.initialized = false
    })

    // Handle stdout data
    this.process.stdout.on('data', (chunk: Buffer) => {
      this.handleStdout(chunk)
    })

    // Handle stderr (log for debugging)
    this.process.stderr.on('data', (chunk: Buffer) => {
      console.error(`[lsp-client stderr] ${chunk.toString()}`)
    })

    // Send initialize request
    const initializeResult = await this.request(
      'initialize',
      {
        processId: process.pid,
        rootUri: this.rootUri,
        capabilities: {
          textDocument: {
            documentSymbol: {
              hierarchicalDocumentSymbolSupport: true
            },
            definition: {
              linkSupport: true
            },
            references: {}
          }
        },
        initializationOptions: this.initializationOptions
      },
      30000
    )

    // Send initialized notification (no response expected)
    this.sendNotification('initialized', {})

    this.initialized = true
    console.log(`[lsp-client] Initialized ${this.command} for ${this.rootUri}`)
  }

  /**
   * Send a JSON-RPC request and wait for response
   */
  async request(method: string, params: any, timeout: number = 30000): Promise<any> {
    if (!this.process || !this.process.stdin) {
      throw new Error('LSP client not started')
    }

    const id = this.nextRequestId++
    const message = {
      jsonrpc: '2.0',
      id,
      method,
      params
    }

    return new Promise((resolve, reject) => {
      // Set up timeout
      const timer = setTimeout(() => {
        this.messageQueue.delete(id)
        reject(new Error(`LSP request timeout after ${timeout}ms: ${method}`))
      }, timeout)

      // Store pending request
      this.messageQueue.set(id, { resolve, reject, timer })

      // Send request
      this.sendMessage(message)
    })
  }

  /**
   * Send a JSON-RPC notification (no response expected)
   */
  private sendNotification(method: string, params: any): void {
    if (!this.process || !this.process.stdin) {
      throw new Error('LSP client not started')
    }

    const message = {
      jsonrpc: '2.0',
      method,
      params
    }

    this.sendMessage(message)
  }

  /**
   * Gracefully shutdown the LSP server
   */
  async shutdown(): Promise<void> {
    if (!this.process || !this.initialized) {
      return
    }

    this.shutdownRequested = true

    try {
      // Send shutdown request
      await this.request('shutdown', null, 5000)

      // Send exit notification
      this.sendNotification('exit', null)

      // Wait for process to exit
      await new Promise<void>((resolve, reject) => {
        const exitTimer = setTimeout(() => {
          console.warn('[lsp-client] Process did not exit gracefully, killing...')
          if (this.process) {
            this.process.kill('SIGKILL')
          }
          resolve()
        }, 5000)

        if (this.process) {
          this.process.once('exit', () => {
            clearTimeout(exitTimer)
            resolve()
          })
        } else {
          clearTimeout(exitTimer)
          resolve()
        }
      })
    } catch (err) {
      console.error('[lsp-client] Error during shutdown:', err)
      // Force kill if graceful shutdown failed
      if (this.process) {
        this.process.kill('SIGKILL')
      }
    } finally {
      this.initialized = false
      this.process = null
      this.rejectAllPending(new Error('LSP client shut down'))
    }
  }

  /**
   * Send a JSON-RPC message with Content-Length header
   */
  private sendMessage(message: any): void {
    if (!this.process || !this.process.stdin) {
      throw new Error('LSP client not started')
    }

    const content = JSON.stringify(message)
    const contentLength = Buffer.byteLength(content, 'utf8')
    const header = `Content-Length: ${contentLength}\r\n\r\n`
    const fullMessage = header + content

    try {
      this.process.stdin.write(fullMessage, 'utf8')
    } catch (err) {
      console.error('[lsp-client] Error writing to stdin:', err)
      throw err
    }
  }

  /**
   * Handle stdout data from LSP server
   */
  private handleStdout(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    this.parseMessages()
  }

  /**
   * Parse complete messages from buffer
   */
  private parseMessages(): void {
    while (true) {
      // Look for Content-Length header
      const headerMatch = this.buffer.match(/Content-Length: (\d+)\r\n\r\n/)
      if (!headerMatch) {
        // No complete header yet
        break
      }

      const contentLength = parseInt(headerMatch[1], 10)
      const headerEndIndex = headerMatch.index! + headerMatch[0].length
      const messageEndIndex = headerEndIndex + contentLength

      if (this.buffer.length < messageEndIndex) {
        // Not enough data for complete message
        break
      }

      // Extract message
      const messageContent = this.buffer.substring(headerEndIndex, messageEndIndex)
      this.buffer = this.buffer.substring(messageEndIndex)

      // Parse and handle message
      try {
        const message = JSON.parse(messageContent)
        this.handleMessage(message)
      } catch (err) {
        console.error('[lsp-client] Failed to parse message:', err, messageContent)
      }
    }
  }

  /**
   * Handle a complete JSON-RPC message
   */
  private handleMessage(message: any): void {
    // Response to a request
    if ('id' in message && typeof message.id === 'number') {
      const pending = this.messageQueue.get(message.id)
      if (pending) {
        clearTimeout(pending.timer)
        this.messageQueue.delete(message.id)

        if ('error' in message) {
          pending.reject(new Error(`LSP error: ${JSON.stringify(message.error)}`))
        } else {
          pending.resolve(message.result)
        }
      }
    }
    // Notification from server (no id field)
    else if ('method' in message) {
      // Handle server notifications if needed (e.g., window/logMessage, textDocument/publishDiagnostics)
      // For now, just log them
      console.log(`[lsp-client] Received notification: ${message.method}`)
    }
  }

  /**
   * Reject all pending requests (on error or shutdown)
   */
  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.messageQueue.entries()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.messageQueue.clear()
  }

  /**
   * Check if client is ready for requests
   */
  isReady(): boolean {
    return this.initialized && this.process !== null && !this.shutdownRequested
  }
}
