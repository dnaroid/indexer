/**
 * @deprecated Use lib/lsp/adapter-manager.ts instead
 * This module will be removed in a future version
 */

import { LspClient } from './lsp-client.js'
import { loadGlobalConfig } from '../utils/config-global.js'
import path from 'path'

interface LspSession {
  client: LspClient
  language: string
  collectionId: string
  projectPath: string
  lastActivity: number
  idleTimer: NodeJS.Timeout
}

interface LspServerConfig {
  command: string
  args: string[]
  initializationOptions?: any
}

interface LspConfig {
  enabled?: boolean
  idleTimeoutMs?: number
  requestTimeoutMs?: number
  servers?: Record<string, LspServerConfig>
}

/**
 * Singleton manager for LSP client sessions
 * Handles session caching, idle timeout, and lifecycle management
 */
class LspSessionManager {
  private sessions: Map<string, LspSession> = new Map()
  private config: LspConfig | null = null

  /**
   * Get or create an LSP client session for the given collection and language
   */
  async getOrCreateSession(
    collectionId: string,
    language: string,
    projectPath: string
  ): Promise<LspClient> {
    // Load config if not already loaded
    if (!this.config) {
      await this.loadConfig()
    }

    // Check if LSP is enabled
    if (this.config?.enabled === false) {
      throw new Error('LSP is disabled in configuration')
    }

    const cacheKey = this.getCacheKey(collectionId, language)

    // Check if session already exists and is active
    const existingSession = this.sessions.get(cacheKey)
    if (existingSession && existingSession.client.isReady()) {
      // Reset idle timer and update activity
      this.resetIdleTimer(existingSession)
      return existingSession.client
    }

    // Clean up stale session if it exists
    if (existingSession) {
      await this.closeSession(cacheKey)
    }

    // Get server config for language
    const serverConfig = this.config?.servers?.[language]
    if (!serverConfig) {
      throw new Error(
        `No LSP server configured for language: ${language}\n` +
        `Please add configuration in ~/.indexer/config.json under lsp.servers.${language}`
      )
    }

    // Create new LSP client
    const rootUri = `file://${path.resolve(projectPath)}`
    const client = new LspClient(
      serverConfig.command,
      serverConfig.args || [],
      rootUri,
      serverConfig.initializationOptions || {}
    )

    // Start the client (performs initialization handshake)
    try {
      await client.start()
    } catch (err: any) {
      throw new Error(`Failed to start LSP server for ${language}: ${err.message}`)
    }

    // Create session
    const session: LspSession = {
      client,
      language,
      collectionId,
      projectPath,
      lastActivity: Date.now(),
      idleTimer: setTimeout(() => {}, 0) // Will be set by resetIdleTimer
    }

    // Store session
    this.sessions.set(cacheKey, session)

    // Set up idle timer
    this.resetIdleTimer(session)

    console.log(`[lsp-session-manager] Created new session: ${cacheKey}`)
    return client
  }

  /**
   * Close a specific session
   */
  async closeSession(key: string): Promise<void> {
    const session = this.sessions.get(key)
    if (!session) {
      return
    }

    console.log(`[lsp-session-manager] Closing session: ${key}`)

    // Clear idle timer
    clearTimeout(session.idleTimer)

    // Shutdown client
    try {
      await session.client.shutdown()
    } catch (err) {
      console.error(`[lsp-session-manager] Error shutting down client for ${key}:`, err)
    }

    // Remove from sessions map
    this.sessions.delete(key)
  }

  /**
   * Close all active sessions (useful for cleanup/testing)
   */
  async closeAllSessions(): Promise<void> {
    console.log(`[lsp-session-manager] Closing all ${this.sessions.size} sessions`)

    const closePromises = Array.from(this.sessions.keys()).map(key =>
      this.closeSession(key)
    )

    await Promise.all(closePromises)
  }

  /**
   * Get cache key for a session
   */
  private getCacheKey(collectionId: string, language: string): string {
    return `${collectionId}-${language}`
  }

  /**
   * Reset idle timer for a session
   */
  private resetIdleTimer(session: LspSession): void {
    // Clear existing timer
    clearTimeout(session.idleTimer)

    // Update last activity
    session.lastActivity = Date.now()

    // Get idle timeout from config
    const idleTimeoutMs = this.config?.idleTimeoutMs || 300000 // Default 5 minutes

    // Set new timer
    session.idleTimer = setTimeout(async () => {
      const cacheKey = this.getCacheKey(session.collectionId, session.language)
      console.log(`[lsp-session-manager] Session idle timeout reached: ${cacheKey}`)
      await this.closeSession(cacheKey)
    }, idleTimeoutMs)
  }

  /**
   * Load LSP configuration from global config
   */
  private async loadConfig(): Promise<void> {
    try {
      const globalConfig = await loadGlobalConfig()
      this.config = globalConfig.lsp || {
        enabled: true,
        idleTimeoutMs: 300000,
        requestTimeoutMs: 30000,
        servers: {}
      }
    } catch (err) {
      console.error('[lsp-session-manager] Failed to load config:', err)
      // Use defaults if config loading fails
      this.config = {
        enabled: true,
        idleTimeoutMs: 300000,
        requestTimeoutMs: 30000,
        servers: {}
      }
    }
  }

  /**
   * Reload configuration (useful for testing or dynamic config updates)
   */
  async reloadConfig(): Promise<void> {
    this.config = null
    await this.loadConfig()
  }

  /**
   * Get active session count (for debugging/monitoring)
   */
  getActiveSessionCount(): number {
    return this.sessions.size
  }

  /**
   * Get session info for debugging
   */
  getSessionInfo(): Array<{key: string, language: string, collectionId: string, projectPath: string, lastActivity: number}> {
    return Array.from(this.sessions.entries()).map(([key, session]) => ({
      key,
      language: session.language,
      collectionId: session.collectionId,
      projectPath: session.projectPath,
      lastActivity: session.lastActivity
    }))
  }
}

// Export singleton instance
export const lspSessionManager = new LspSessionManager()

// Graceful shutdown on process exit
process.on('SIGTERM', async () => {
  console.log('[lsp-session-manager] Received SIGTERM, closing all sessions...')
  await lspSessionManager.closeAllSessions()
})

process.on('SIGINT', async () => {
  console.log('[lsp-session-manager] Received SIGINT, closing all sessions...')
  await lspSessionManager.closeAllSessions()
  process.exit(0)
})
