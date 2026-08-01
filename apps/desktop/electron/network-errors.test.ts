/**
 * Tests for Chromium net-transition error helpers and the main-process guard.
 *
 * Run with: vitest run --project electron electron/network-errors.test.ts
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { test } from 'vitest'

import {
  extractChromiumNetErrorCode,
  installMainProcessNetworkErrorGuard,
  isTransientChromiumNetError,
  withTransientNetworkRetry
} from './network-errors'

test('extractChromiumNetErrorCode reads code, errno, and net:: message forms', () => {
  assert.equal(extractChromiumNetErrorCode({ code: 'ERR_NETWORK_CHANGED' }), 'ERR_NETWORK_CHANGED')
  assert.equal(extractChromiumNetErrorCode({ errno: 'ERR_NETWORK_IO_SUSPENDED' }), 'ERR_NETWORK_IO_SUSPENDED')
  assert.equal(
    extractChromiumNetErrorCode({ message: 'Error: net::ERR_NETWORK_CHANGED at SimpleURLLoaderWrapper.<anonymous>' }),
    'ERR_NETWORK_CHANGED'
  )
  assert.equal(extractChromiumNetErrorCode({ code: 'net::ERR_HTTP2_PING_FAILED' }), 'ERR_HTTP2_PING_FAILED')
  assert.equal(extractChromiumNetErrorCode(null), null)
  assert.equal(extractChromiumNetErrorCode('ERR_NETWORK_CHANGED'), null)
  assert.equal(extractChromiumNetErrorCode({ message: 'plain failure' }), null)
})

test('isTransientChromiumNetError covers network-transition codes only', () => {
  assert.equal(isTransientChromiumNetError({ code: 'ERR_NETWORK_CHANGED' }), true)
  assert.equal(isTransientChromiumNetError({ code: 'ERR_NETWORK_IO_SUSPENDED' }), true)
  assert.equal(isTransientChromiumNetError({ code: 'ERR_INTERNET_DISCONNECTED' }), true)
  assert.equal(isTransientChromiumNetError({ code: 'ERR_HTTP2_PING_FAILED' }), true)
  assert.equal(isTransientChromiumNetError({ message: 'net::ERR_CONNECTION_RESET' }), true)

  assert.equal(isTransientChromiumNetError({ code: 'ECONNREFUSED' }), false)
  assert.equal(isTransientChromiumNetError({ code: 'ETIMEDOUT' }), false)
  assert.equal(isTransientChromiumNetError({ code: 'ERR_FILE_NOT_FOUND' }), false)
  assert.equal(isTransientChromiumNetError({ message: 'Expected JSON from http://x' }), false)
  assert.equal(isTransientChromiumNetError(null), false)
  assert.equal(isTransientChromiumNetError(undefined), false)
})

test('withTransientNetworkRetry retries transient net errors then succeeds', async () => {
  let attempts = 0
  const retries: number[] = []

  const result = await withTransientNetworkRetry(
    async () => {
      attempts += 1

      if (attempts < 3) {
        throw Object.assign(new Error('net::ERR_NETWORK_CHANGED'), { code: 'ERR_NETWORK_CHANGED' })
      }

      return 'ok'
    },
    {
      retries: 3,
      delayMs: 1,
      onRetry: (_error, attempt) => {
        retries.push(attempt)
      }
    }
  )

  assert.equal(result, 'ok')
  assert.equal(attempts, 3)
  assert.deepEqual(retries, [1, 2])
})

test('withTransientNetworkRetry does not retry non-transient failures', async () => {
  let attempts = 0

  await assert.rejects(
    () =>
      withTransientNetworkRetry(
        async () => {
          attempts += 1
          throw new Error('401: unauthorized')
        },
        { retries: 3, delayMs: 1 }
      ),
    /401: unauthorized/
  )

  assert.equal(attempts, 1)
})

test('withTransientNetworkRetry exhausts retries for persistent network changes', async () => {
  let attempts = 0

  await assert.rejects(
    () =>
      withTransientNetworkRetry(
        async () => {
          attempts += 1
          throw Object.assign(new Error('net::ERR_NETWORK_CHANGED'), { code: 'ERR_NETWORK_CHANGED' })
        },
        { retries: 2, delayMs: 1 }
      ),
    /ERR_NETWORK_CHANGED/
  )

  assert.equal(attempts, 3)
})

test('installMainProcessNetworkErrorGuard swallows transient uncaught exceptions', () => {
  const processRef = new EventEmitter() as NodeJS.Process & EventEmitter
  const transient: unknown[] = []
  const fatal: unknown[] = []

  const dispose = installMainProcessNetworkErrorGuard({
    processRef,
    onTransient: error => {
      transient.push(error)
    },
    showFatalError: error => {
      fatal.push(error)
    }
  })

  processRef.emit('uncaughtException', Object.assign(new Error('net::ERR_NETWORK_CHANGED'), { code: 'ERR_NETWORK_CHANGED' }))
  processRef.emit(
    'unhandledRejection',
    Object.assign(new Error('net::ERR_NETWORK_IO_SUSPENDED'), { code: 'ERR_NETWORK_IO_SUSPENDED' })
  )
  processRef.emit('uncaughtException', new Error('real bug in main process'))

  assert.equal(transient.length, 2)
  assert.equal(fatal.length, 1)
  assert.match(String((fatal[0] as Error).message), /real bug/)

  // Idempotent install
  const dispose2 = installMainProcessNetworkErrorGuard({ processRef })
  dispose2()
  dispose()
})

test('installMainProcessNetworkErrorGuard does not rethrow non-transient errors', () => {
  const processRef = new EventEmitter() as NodeJS.Process & EventEmitter
  let fatalCalls = 0

  const dispose = installMainProcessNetworkErrorGuard({
    processRef,
    showFatalError: () => {
      fatalCalls += 1
    }
  })

  // Emitting should not throw / recurse
  assert.doesNotThrow(() => {
    processRef.emit('uncaughtException', new Error('boom'))
  })
  assert.equal(fatalCalls, 1)
  dispose()
})
