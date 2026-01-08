// Inactivity timeout configuration
const INACTIVITY_TIMEOUT_MS = Number(process.env.INACTIVITY_TIMEOUT_MS) || 30 * 60 * 1000 // 30 minutes by default
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS) || 5 * 60 * 1000 // Check every 5 minutes

// Inactivity state
let lastActivityTime = Date.now()
let inactivityTimer: NodeJS.Timeout | null = null
let heartbeatInterval: NodeJS.Timeout | null = null

/**
 * Update activity timestamp
 */
export function updateActivity(): void {
  lastActivityTime = Date.now()
  console.log('[inactivity-manager] Activity updated (actual work)')
}

/**
 * Get last activity time
 * @returns Timestamp of last activity
 */
export function getLastActivityTime(): number {
  return lastActivityTime
}

/**
 * Get inactivity timeout
 * @returns Inactivity timeout in milliseconds
 */
export function getInactivityTimeout(): number {
  return INACTIVITY_TIMEOUT_MS
}

/**
 * Start inactivity timer
 * @param [onTimeout] - Callback when timeout occurs
 */
export function startInactivityTimer(onTimeout?: (inactiveTime: number) => void): void {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer)
  }

  inactivityTimer = setTimeout(() => {
    const inactiveTime = Date.now() - lastActivityTime
    if (inactiveTime >= INACTIVITY_TIMEOUT_MS) {
      console.log(`[inactivity-manager] No activity for ${INACTIVITY_TIMEOUT_MS}ms, shutting down...`)
      if (onTimeout) {
        onTimeout(inactiveTime)
      }
    }
  }, INACTIVITY_TIMEOUT_MS)

  console.log(`[inactivity-manager] Inactivity timer started (${INACTIVITY_TIMEOUT_MS}ms timeout)`)
}

/**
 * Stop inactivity timer
 */
export function stopInactivityTimer(): void {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer)
    inactivityTimer = null
    console.log('[inactivity-manager] Inactivity timer stopped')
  }
}

/**
 * Start heartbeat interval
 * @param [onTimeout] - Callback when timeout occurs
 */
export function startHeartbeat(onTimeout?: (inactiveTime: number) => void): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval)
  }

  heartbeatInterval = setInterval(() => {
    const inactiveTime = Date.now() - lastActivityTime
    console.log(`[inactivity-manager] Heartbeat check: inactive for ${inactiveTime}ms`)

    if (inactiveTime >= INACTIVITY_TIMEOUT_MS) {
      console.log(`[inactivity-manager] No activity for ${INACTIVITY_TIMEOUT_MS}ms in heartbeat check, shutting down...`)
      if (onTimeout) {
        onTimeout(inactiveTime)
      }
    }
  }, HEARTBEAT_INTERVAL_MS)

  console.log(`[inactivity-manager] Heartbeat started (${HEARTBEAT_INTERVAL_MS}ms interval)`)
}

/**
 * Stop heartbeat interval
 */
export function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval)
    heartbeatInterval = null
    console.log('[inactivity-manager] Heartbeat stopped')
  }
}

/**
 * Stop all timers (inactivity and heartbeat)
 */
export function stopAllTimers(): void {
  stopInactivityTimer()
  stopHeartbeat()
  console.log('[inactivity-manager] All timers stopped')
}

/**
 * Check if service is inactive
 * @returns True if inactive
 */
export function isInactive(): boolean {
  const inactiveTime = Date.now() - lastActivityTime
  return inactiveTime >= INACTIVITY_TIMEOUT_MS
}

/**
 * Get inactive duration
 * @returns Duration of inactivity in milliseconds
 */
export function getInactiveDuration(): number {
  return Date.now() - lastActivityTime
}
