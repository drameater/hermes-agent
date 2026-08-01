/**
 * Chromium net:: errors that surface from Electron's SimpleURLLoaderWrapper when
 * the OS network stack is mid-transition (Ethernet↔Wi-Fi, sleep/wake, VPN flap,
 * Tailscale re-mesh). These are recoverable: callers should retry or reconnect
 * rather than crash the main process.
 *
 * See: #56835, electron/electron#39522, electron/electron#42546.
 */

const TRANSIENT_CHROMIUM_NET_ERROR_CODES = new Set([
  'ERR_NETWORK_CHANGED',
  'ERR_NETWORK_IO_SUSPENDED',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NETWORK_ACCESS_DENIED',
  'ERR_HTTP2_PING_FAILED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_ABORTED',
  'ERR_ADDRESS_UNREACHABLE'
])

function extractChromiumNetErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null
  }

  const record = error as { code?: unknown; errno?: unknown; message?: unknown }
  const candidates = [record.code, record.errno]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.startsWith('ERR_')) {
      return candidate
    }

    if (typeof candidate === 'string' && candidate.startsWith('net::ERR_')) {
      return candidate.slice('net::'.length)
    }
  }

  const message = typeof record.message === 'string' ? record.message : ''
  const match = /net::(ERR_[A-Z0-9_]+)/.exec(message)

  return match?.[1] || null
}

function isTransientChromiumNetError(error: unknown): boolean {
  const code = extractChromiumNetErrorCode(error)

  return Boolean(code && TRANSIENT_CHROMIUM_NET_ERROR_CODES.has(code))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

/**
 * Run an async network operation with a small bounded retry budget for
 * transient Chromium net transitions (e.g. ERR_NETWORK_CHANGED).
 */
async function withTransientNetworkRetry<T>(
  operation: () => Promise<T>,
  options: { retries?: number; delayMs?: number; onRetry?: (error: unknown, attempt: number) => void } = {}
): Promise<T> {
  const retries = Number.isFinite(options.retries) ? Math.max(0, Math.floor(Number(options.retries))) : 2
  const delayMs = Number.isFinite(options.delayMs) ? Math.max(0, Number(options.delayMs)) : 400
  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error

      if (!isTransientChromiumNetError(error) || attempt === retries) {
        throw error
      }

      options.onRetry?.(error, attempt + 1)
      await sleep(delayMs * (attempt + 1))
    }
  }

  throw lastError
}

type NetworkErrorGuardOptions = {
  isTransient?: (error: unknown) => boolean
  onTransient?: (error: unknown, source: 'uncaughtException' | 'unhandledRejection') => void
  showFatalError?: (error: unknown) => void
  processRef?: NodeJS.Process
}

/**
 * Install a main-process guard that swallows recoverable Chromium net errors
 * instead of letting Electron's default uncaughtException dialog brick the app.
 *
 * Important: registering *any* `uncaughtException` listener makes Electron's
 * built-in dialog a no-op (listenerCount > 1). Non-transient errors therefore
 * must be re-surfaced via `showFatalError` (typically dialog.showErrorBox).
 *
 * Returns a dispose function for tests.
 */
function installMainProcessNetworkErrorGuard(options: NetworkErrorGuardOptions = {}): () => void {
  const processRef = options.processRef || process
  const isTransient = options.isTransient || isTransientChromiumNetError
  const marker = '__hermesNetworkErrorGuardInstalled' as const

  if ((processRef as any)[marker]) {
    return () => undefined
  }

  ;(processRef as any)[marker] = true

  const handle = (error: unknown, source: 'uncaughtException' | 'unhandledRejection') => {
    if (isTransient(error)) {
      options.onTransient?.(error, source)

      return true
    }

    return false
  }

  const onUncaught = (error: unknown) => {
    if (handle(error, 'uncaughtException')) {
      return
    }

    // Preserve a crash dialog for real bugs. Do NOT rethrow — rethrowing into
    // the same listener recurses forever (review note on #56896).
    options.showFatalError?.(error)
  }

  const onUnhandledRejection = (reason: unknown) => {
    if (handle(reason, 'unhandledRejection')) {
      return
    }

    // Leave non-transient rejections alone so existing Node/Electron reporting
    // still observes them. We only claim transient net failures.
  }

  processRef.on('uncaughtException', onUncaught)
  processRef.on('unhandledRejection', onUnhandledRejection)

  return () => {
    processRef.off('uncaughtException', onUncaught)
    processRef.off('unhandledRejection', onUnhandledRejection)
    delete (processRef as any)[marker]
  }
}

export {
  extractChromiumNetErrorCode,
  installMainProcessNetworkErrorGuard,
  isTransientChromiumNetError,
  TRANSIENT_CHROMIUM_NET_ERROR_CODES,
  withTransientNetworkRetry
}
