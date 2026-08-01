import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { createClientSessionState } from '@/lib/chat-runtime'
import { $subagentsBySession, upsertSubagent } from '@/store/subagents'
import type { RpcEvent } from '@/types/hermes'

import { useMessageStream } from './index'

const SESSION_ID = 'session-1'
let handleEvent: ((event: RpcEvent) => void) | null = null
const sessionStateByRuntimeIdRef = { current: new Map<string, ClientSessionState>() }

function Harness() {
  const activeSessionIdRef = useRef<string | null>(SESSION_ID)
  const queryClientRef = useRef(new QueryClient())
  const stream = useMessageStream({
    activeSessionIdRef,
    hydrateFromStoredSession: vi.fn(async () => undefined),
    queryClient: queryClientRef.current,
    refreshHermesConfig: vi.fn(async () => undefined),
    refreshSessions: vi.fn(async () => undefined),
    sessionStateByRuntimeIdRef,
    updateSessionState: (sessionId, updater) => {
      const current = sessionStateByRuntimeIdRef.current.get(sessionId) ?? createClientSessionState()
      const next = updater(current)
      sessionStateByRuntimeIdRef.current.set(sessionId, next)

      return next
    }
  })

  useEffect(() => {
    handleEvent = stream.handleGatewayEvent
  }, [stream.handleGatewayEvent])

  return null
}

function emit(type: RpcEvent['type'], payload: RpcEvent['payload']) {
  act(() => handleEvent!({ payload, session_id: SESSION_ID, type }))
}

beforeEach(() => {
  handleEvent = null
  sessionStateByRuntimeIdRef.current.clear()
  $subagentsBySession.set({})
})

afterEach(() => {
  cleanup()
  sessionStateByRuntimeIdRef.current.clear()
  $subagentsBySession.set({})
})

it('ignores stale native subagent events after the session is interrupted', async () => {
  sessionStateByRuntimeIdRef.current.set(SESSION_ID, { ...createClientSessionState(), interrupted: true })
  upsertSubagent(SESSION_ID, {
    goal: 'existing child',
    status: 'running',
    subagent_id: 'existing',
    task_index: 0
  })

  render(<Harness />)
  await waitFor(() => expect(handleEvent).not.toBeNull())
  const before = $subagentsBySession.get()

  emit('subagent.start', {
    goal: 'stale child',
    status: 'running',
    subagent_id: 'stale',
    task_index: 1
  })
  emit('subagent.progress', {
    status: 'running',
    subagent_id: 'existing',
    task_index: 0,
    text: 'stale progress'
  })
  emit('subagent.complete', {
    status: 'completed',
    subagent_id: 'existing',
    summary: 'stale completion',
    task_index: 0
  })

  expect($subagentsBySession.get()).toEqual(before)
})
