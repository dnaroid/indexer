/**
 * Adapter manager
 * Handles lifecycle and resolution of language-specific LSP adapters
 */

import type { LspAdapter } from './adapters/base.js'
import { TypeScriptAdapter } from './adapters/typescript.js'
import { loadGlobalConfig } from '../utils/config-global.js'
import type { LspConfig, LspServerConfig } from './types.js'

/**
 * Adapter manager
 * Singleton for managing LSP adapter lifecycle
 */
class AdapterManager {
  private adapters: Map<string, LspAdapter> = new Map()
  private config: LspConfig | null = null
  private idleTimers: Map<string, NodeJS.Timeout> = new Map()

  /**
   * Get or create an adapter for the given language and project
   */
  async getOrCreateAdapter(
    collectionId: string,
    language: string,
    projectPath: string
  ): Promise<LspAdapter> {
    const key = this.getCacheKey(collectionId, language)

    // Return existing adapter if ready
    let adapter = this.adapters.get(key)
    if (adapter?.isReady()) {
      this.resetIdleTimer(key)
      return adapter
    }

    // Clean up stale adapter
    if (adapter) {
      await this.closeAdapter(key)
    }

    // Create new adapter
    adapter = await this.createAdapter(language, projectPath, collectionId)
    await adapter.start()

    this.adapters.set(key, adapter)
    this.resetIdleTimer(key)

    console.log(`[adapter-manager] Created adapter: ${key}`)
    return adapter
  }

  /**
   * Create a language-specific adapter
   */
  private async createAdapter(
    language: string,
    projectPath: string,
    collectionId: string
  ): Promise<LspAdapter> {
    // Load config
    await this.ensureConfig()

    // Check if LSP is enabled
    if (this.config?.enabled === false) {
      throw new Error('LSP is disabled in configuration')
    }

    // Get server config
    const serverConfig = this.config?.servers?.[language]
    if (!serverConfig) {
      throw new Error(
        `No LSP server configured for language: ${language}\n` +
        `Please add configuration in ~/.indexer/config.json under lsp.servers.${language}`
      )
    }

    // Resolve adapter by language
    switch (language) {
      case 'typescript':
        return new TypeScriptAdapter(projectPath, collectionId, serverConfig, 'typescript')

      case 'javascript':
        return new TypeScriptAdapter(projectPath, collectionId, serverConfig, 'javascript')

      case 'python':
        throw new Error('Python adapter not yet implemented')

      case 'cpp':
        throw new Error('C++ adapter not yet implemented')

      case 'csharp':
        throw new Error('C# adapter not yet implemented')

      default:
        throw new Error(`Unsupported language: ${language}`)
    }
  }

  /**
   * Close a specific adapter
   */
  async closeAdapter(key: string): Promise<void> {
    const adapter = this.adapters.get(key)
    if (!adapter) {
      return
    }

    console.log(`[adapter-manager] Closing adapter: ${key}`)

    // Clear idle timer
    const timer = this.idleTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.idleTimers.delete(key)
    }

    // Stop adapter
    try {
      await adapter.stop()
    } catch (err) {
      console.error(`[adapter-manager] Error stopping adapter ${key}:`, err)
    }

    // Remove from map
    this.adapters.delete(key)
  }

  /**
   * Close all adapters
   */
  async closeAllAdapters(): Promise<void> {
    console.log(`[adapter-manager] Closing all ${this.adapters.size} adapters`)

    const closePromises = Array.from(this.adapters.keys()).map(key =>
      this.closeAdapter(key)
    )

    await Promise.all(closePromises)
  }

  /**
   * Get cache key for an adapter
   */
  private getCacheKey(collectionId: string, language: string): string {
    return `${collectionId}-${language}`
  }

  /**
   * Reset idle timer for an adapter
   */
  private resetIdleTimer(key: string): void {
    // Clear existing timer
    const existingTimer = this.idleTimers.get(key)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    // Get idle timeout from config
    const idleTimeoutMs = this.config?.idleTimeoutMs || 300000 // Default 5 minutes

    // Set new timer
    const timer = setTimeout(async () => {
      console.log(`[adapter-manager] Adapter idle timeout reached: ${key}`)
      await this.closeAdapter(key)
    }, idleTimeoutMs)

    this.idleTimers.set(key, timer)
  }

  /**
   * Ensure config is loaded
   */
  private async ensureConfig(): Promise<void> {
    if (this.config !== null) {
      return
    }

    try {
      const globalConfig = await loadGlobalConfig()
      this.config = globalConfig.lsp || {
        enabled: true,
        idleTimeoutMs: 300000,
        requestTimeoutMs: 30000,
        servers: {}
      }
    } catch (err) {
      console.error('[adapter-manager] Failed to load config:', err)
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
   * Reload configuration
   */
  async reloadConfig(): Promise<void> {
    this.config = null
    await this.ensureConfig()
  }

  /**
   * Get active adapter count (for debugging)
   */
  getActiveAdapterCount(): number {
    return this.adapters.size
  }

  /**
   * Get adapter info (for debugging)
   */
  getAdapterInfo(): Array<{
    key: string
    language: string
    collectionId: string
    projectPath: string
  }> {
    return Array.from(this.adapters.entries()).map(([key, adapter]) => ({
      key,
      language: adapter.language,
      collectionId: adapter.collectionId,
      projectPath: adapter.projectPath
    }))
  }
}

// Export singleton instance
export const adapterManager = new AdapterManager()

// Graceful shutdown on process exit
process.on('SIGTERM', async () => {
  console.log('[adapter-manager] Received SIGTERM, closing all adapters...')
  await adapterManager.closeAllAdapters()
})

process.on('SIGINT', async () => {
  console.log('[adapter-manager] Received SIGINT, closing all adapters...')
  await adapterManager.closeAllAdapters()
  process.exit(0)
})
