import { beforeEach, describe, expect, it, vi } from 'vitest'

const kvStore = vi.hoisted(() => new Map<string, unknown>())

vi.mock('@/storage', () => ({
  default: {
    getItem: vi.fn(async (key: string, defaultValue: unknown = null) => kvStore.get(key) ?? defaultValue),
    setItem: vi.fn(async (key: string, value: unknown) => {
      kvStore.set(key, value)
    }),
    removeItem: vi.fn(async (key: string) => {
      kvStore.delete(key)
    }),
  },
}))

import { bindSession, dismissPendingUser, forgetSessionBinding, getSessionBinding, notePendingUser, remoteUiStore } from './registry'

beforeEach(() => {
  kvStore.clear()
})

describe('session ↔ telegram chat bindings', () => {
  it('binds a session to a telegram chat and reads it back', async () => {
    await bindSession('s1', '100')
    expect(await getSessionBinding('s1')).toBe('100')
    expect(kvStore.get('remote-control:session-bindings')).toEqual({ s1: '100' })
  })

  it('forgets stale bindings', async () => {
    await bindSession('s1', '100')
    await bindSession('s2', '200')
    await forgetSessionBinding('s1')
    expect(await getSessionBinding('s1')).toBeUndefined()
    expect(await getSessionBinding('s2')).toBe('200')
  })

  it('forgetting an unknown binding is a no-op', async () => {
    await forgetSessionBinding('missing')
    expect(kvStore.get('remote-control:session-bindings')).toBeUndefined()
  })
})

describe('pending authorization users', () => {
  it('records authorization requests deduplicated by user id', () => {
    notePendingUser({ id: '7', name: 'Seven', username: 'seven' })
    notePendingUser({ id: '7', name: 'Seven Again' })
    notePendingUser({ id: '8' })

    const pending = remoteUiStore.getState().pendingUsers
    expect(pending.map((user) => user.id)).toEqual(['8', '7'])
    // The first-seen display data wins.
    expect(pending.find((user) => user.id === '7')?.username).toBe('seven')
  })

  it('dismisses requests from the settings page', () => {
    notePendingUser({ id: '9' })
    dismissPendingUser('9')
    expect(remoteUiStore.getState().pendingUsers.some((user) => user.id === '9')).toBe(false)
  })
})
