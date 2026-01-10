/**
 * Response cache for LSP operations
 * Implements TTL-based caching to reduce LSP server load
 */

import type { Position } from './types.js'

/**
 * Cache entry
 */
interface CacheEntry<T> {
  value: T
  timestamp: number
  ttl: number
}

/**
 * Response cache
 */
class ResponseCache {
  private cache: Map<string, CacheEntry<any>> = new Map()

  /**
   * Generate cache key
   */
  getCacheKey(
    operation: string,
    language: string,
    file: string,
    position?: Position
  ): string {
    const posStr = position ? `${position.line}:${position.character}` : ''
    return `${operation}:${language}:${file}:${posStr}`
  }

  /**
   * Get cached value
   * Returns null if not found or expired
   */
  get<T>(key: string): T | null {
    const entry = this.cache.get(key)
    if (!entry) {
      return null
    }

    // Check if expired
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key)
      return null
    }

    return entry.value
  }

  /**
   * Set cache value with TTL
   */
  set<T>(key: string, value: T, ttl: number): void {
    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      ttl
    })
  }

  /**
   * Invalidate cache entries matching a file pattern
   */
  invalidate(filePattern: string): void {
    for (const key of this.cache.keys()) {
      if (key.includes(filePattern)) {
        this.cache.delete(key)
      }
    }
  }

  /**
   * Clear all cache entries
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * Get cache size (for debugging)
   */
  size(): number {
    return this.cache.size
  }

  /**
   * Get cache stats (for debugging)
   */
  getStats(): {
    size: number
    entries: Array<{ key: string; age: number; ttl: number }>
  } {
    const now = Date.now()
    const entries = Array.from(this.cache.entries()).map(([key, entry]) => ({
      key,
      age: now - entry.timestamp,
      ttl: entry.ttl
    }))

    return {
      size: this.cache.size,
      entries
    }
  }
}

// Export singleton instance
export const responseCache = new ResponseCache()

/**
 * TTL policies for different operations
 */
export const CACHE_TTL = {
  DOCUMENT_SYMBOLS: 300000,  // 5 minutes
  DEFINITION: 60000,         // 1 minute
  REFERENCES: 30000          // 30 seconds
}
