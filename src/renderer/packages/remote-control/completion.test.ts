import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '@shared/types'

const tMock = vi.hoisted(() => vi.fn((key: string) => key))

vi.mock('@/i18n', () => ({ default: { t: tMock } }))

const sendTelegramMessageMock = vi.hoisted(() => vi.fn())

const getSessionBindingMock = vi.hoisted(() => vi.fn())
const unbindSessionMock = vi.hoisted(() => vi.fn())

vi.mock('@/stores/chatStore', () => ({
  getSession: vi.fn(async () => undefined),
}))

vi.mock('@/stores/projectStore', () => ({
  loadProjects: vi.fn(async () => []),
}))

vi.mock('@/stores/settingsStore', () => ({
  settingsStore: {
    getState: () => ({ remote: { enabled: true } }),
  },
}))

vi.mock('./bridge', () => ({
  sendTelegramMessage: sendTelegramMessageMock,
}))

vi.mock('./format', () => ({
  formatCompletionNotification: vi.fn((opts) => `NOTIFICATION:${opts.sessionName}`),
}))

vi.mock('./registry', () => ({
  getSessionBinding: getSessionBindingMock,
  unbindSession: unbindSessionMock,
}))

import { notifyRemoteCompletion } from './completion'
import * as chatStore from '@/stores/chatStore'

function makeMessage(role: Message['role'] = 'assistant', text = 'reply'): Message {
  return {
    id: 'msg-1',
    role,
    contentParts: [{ type: 'text', text }],
    timestamp: Date.now(),
  } as Message
}

function makeSession(sessionId: string, name = 'My Chat', remoteEnabled = true) {
  return {
    id: sessionId,
    name,
    type: 'chat',
    messages: [{} as never],
    settings: { remoteEnabled },
    projectId: 'p1',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(chatStore.getSession).mockResolvedValue(makeSession('s1'))
  sendTelegramMessageMock.mockResolvedValue({ ok: true })
  getSessionBindingMock.mockResolvedValue([])
})

describe('notifyRemoteCompletion', () => {
  it('sends the notification to every bound Telegram chat', async () => {
    getSessionBindingMock.mockResolvedValue(['100', '200'])

    await notifyRemoteCompletion('s1', makeMessage())

    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(2)
    const calls = sendTelegramMessageMock.mock.calls.map((c) => ({
      chatId: c[0],
      text: String(c[1]),
    }))
    expect(calls).toEqual([
      { chatId: '100', text: 'NOTIFICATION:My Chat' },
      { chatId: '200', text: 'NOTIFICATION:My Chat' },
    ])
  })

  it('does nothing when no chats are bound to the session', async () => {
    getSessionBindingMock.mockResolvedValue([])
    await notifyRemoteCompletion('s1', makeMessage())
    expect(sendTelegramMessageMock).not.toHaveBeenCalled()
  })

  it('skips sessions that are not remote-enabled', async () => {
    vi.mocked(chatStore.getSession).mockResolvedValue(makeSession('s1', 'My Chat', false))
    await notifyRemoteCompletion('s1', makeMessage())
    expect(sendTelegramMessageMock).not.toHaveBeenCalled()
  })

  it('unbinds only the chat that returned "chat not found"', async () => {
    getSessionBindingMock.mockResolvedValue(['100', '200'])
    sendTelegramMessageMock
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: 'chat not found' })

    await notifyRemoteCompletion('s1', makeMessage())

    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(2)
    expect(unbindSessionMock).toHaveBeenCalledWith('s1', '200')
    expect(unbindSessionMock).not.toHaveBeenCalledWith('s1', '100')
  })
})
