import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Session, TelegramUpdate } from '@shared/types'

const tMock = vi.hoisted(() => vi.fn((key: string) => key))

vi.mock('@/i18n', () => ({ default: { t: tMock } }))

vi.mock('@/lib/utils', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

const {
  listSessionsMetaMock,
  getSessionMock,
  createSessionMock,
  updateSessionMock,
  submitNewUserMessageMock,
  sendTelegramMessageMock,
} = vi.hoisted(() => ({
  listSessionsMetaMock: vi.fn(),
  getSessionMock: vi.fn(),
  createSessionMock: vi.fn(),
  updateSessionMock: vi.fn(),
  submitNewUserMessageMock: vi.fn(),
  sendTelegramMessageMock: vi.fn(),
}))

// In-memory store backing for the settings store mock (mutable per test).
const remoteSettings = vi.hoisted(() => ({
  enabled: true,
  botToken: 'token',
  allowedUsers: [] as Array<{ id: string }>,
}))

vi.mock('@/stores/settingsStore', () => ({
  settingsStore: {
    getState: () => ({
      remote: remoteSettings,
      subscribe: vi.fn(),
    }),
  },
}))

let projects: Project[] = []

vi.mock('@/stores/projectStore', () => ({
  loadProjects: vi.fn(async () => projects),
  projectStore: {
    getState: () => ({ projects }),
  },
}))

vi.mock('@/stores/chatStore', () => ({
  listSessionsMeta: listSessionsMetaMock,
  getSession: getSessionMock,
  createSession: createSessionMock,
  updateSession: updateSessionMock,
}))

vi.mock('@/stores/sessionActions', () => ({
  submitNewUserMessage: submitNewUserMessageMock,
}))

vi.mock('@/stores/sessionHelpers', () => ({
  initEmptyChatSession: (project?: Project) => ({
    name: 'New Chat',
    type: 'chat',
    messages: [],
    projectId: project?.id,
    settings: {},
  }),
}))

vi.mock('./bridge', () => ({
  isRemoteBridgeAvailable: vi.fn(() => true),
  sendTelegramMessage: sendTelegramMessageMock,
  answerCallbackQuery: vi.fn(),
}))

vi.mock('./format', () => ({
  formatLastRequest: vi.fn((session: Session) =>
    session.messages?.length ? `LAST_REQUEST_OF:${session.name}` : null
  ),
}))

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

import { handleTelegramUpdate } from './commands'
import { dismissPendingUser, remoteUiStore } from './registry'

const projectFixtures: Project[] = [
  { id: 'p1', name: 'My Project', createdAt: 1, sortOrder: 1, settings: { remoteEnabled: true } },
  { id: 'p2', name: 'Plain Project', createdAt: 2, sortOrder: 2, settings: {} },
] as Project[]

function makeSession(partial: Partial<Session>): Session {
  return {
    id: 's',
    name: 'S',
    type: 'chat',
    messages: [{} as never],
    settings: {},
    ...partial,
  } as Session
}

function textUpdate(text: string, userId = 42): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      from: { id: userId, first_name: 'Tester' },
      chat: { id: 100, type: 'private', first_name: 'Tester' },
      text,
    },
  }
}

function callbackUpdate(data: string, userId = 42): TelegramUpdate {
  return {
    update_id: 2,
    callback_query: {
      id: 'cb',
      from: { id: userId, first_name: 'Tester' },
      data,
      message: {
        message_id: 3,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 100, type: 'private', first_name: 'Tester' },
      },
    },
  }
}

async function lastReplyText(): Promise<string> {
  const call = sendTelegramMessageMock.mock.calls.at(-1)
  expect(call).toBeDefined()
  return String(call![1])
}

beforeEach(() => {
  vi.clearAllMocks()
  remoteSettings.enabled = true
  remoteSettings.allowedUsers = [{ id: '42' }]
  projects = projectFixtures
  sendTelegramMessageMock.mockResolvedValue({ ok: true })
  submitNewUserMessageMock.mockResolvedValue(undefined)
  createSessionMock.mockImplementation(async (draft: Omit<Session, 'id'>) => ({ ...draft, id: 'created-id' }))
  updateSessionMock.mockResolvedValue(undefined)
  dismissPendingUser('999')
})

describe('handleTelegramUpdate – authorization', () => {
  it('ignores updates while Remote access is disabled', async () => {
    remoteSettings.enabled = false
    await handleTelegramUpdate(textUpdate('/chats'))
    expect(sendTelegramMessageMock).not.toHaveBeenCalled()
  })

  it('answers unauthorized users with "No access." and records a pending request', async () => {
    await handleTelegramUpdate(textUpdate('/chats', 999))
    expect(await lastReplyText()).toBe('No access.')
    expect(remoteUiStore.getState().pendingUsers.some((user) => user.id === '999')).toBe(true)
  })
})

describe('handleTelegramUpdate – /chats', () => {
  it('lists only chats with Remote access enabled', async () => {
    const remoteChat = makeSession({ id: 's1', name: 'Chat One', settings: { remoteEnabled: true }, projectId: 'p1' })
    listSessionsMetaMock.mockResolvedValue([{ id: 's1' }, { id: 's2' }])
    getSessionMock.mockImplementation(async (id: string) => (id === 's1' ? remoteChat : undefined))

    await handleTelegramUpdate(textUpdate('/chats'))

    const text = await lastReplyText()
    expect(text).toContain('Chats with remote access:')
    expect(text).toContain('Chat One')
    expect(text).toContain('My Project')
  })

  it('reports when no chats have Remote access', async () => {
    listSessionsMetaMock.mockResolvedValue([])
    await handleTelegramUpdate(textUpdate('/chats'))
    expect(await lastReplyText()).toBe('No chats with remote access.')
  })
})

describe('handleTelegramUpdate – /msg', () => {
  beforeEach(() => {
    const remoteChat = makeSession({
      id: 's1',
      name: 'Chat One',
      messages: [],
      settings: { remoteEnabled: true },
      projectId: 'p1',
    })
    listSessionsMetaMock.mockResolvedValue([{ id: 's1' }])
    getSessionMock.mockResolvedValue(remoteChat)
  })

  it('submits the message to the referenced chat and confirms', async () => {
    await handleTelegramUpdate(textUpdate('/msg 1 hello there'))

    expect(submitNewUserMessageMock).toHaveBeenCalledTimes(1)
    const [sessionId, params] = submitNewUserMessageMock.mock.calls[0]
    expect(sessionId).toBe('s1')
    expect(params.needGenerating).toBe(true)
    // Completion notifications are delivered back to this Telegram chat.
    expect(kvStore.get('remote-control:session-bindings')).toMatchObject({ s1: '100' })

    expect(await lastReplyText()).toBe('Message sent to "{{name}}".')
  })

  it('replies "No access." for an out-of-range or malformed target', async () => {
    await handleTelegramUpdate(textUpdate('/msg 99 hi'))
    await handleTelegramUpdate(textUpdate('/msg abc'))
    await handleTelegramUpdate(textUpdate('/msg 1'))

    expect(submitNewUserMessageMock).not.toHaveBeenCalled()
    const texts = sendTelegramMessageMock.mock.calls.map((call) => String(call[1]))
    expect(texts.filter((text) => text === 'No access.')).toHaveLength(3)
  })
})

describe('handleTelegramUpdate – /new', () => {
  it('creates a chat only inside a Remote-enabled project', async () => {
    await handleTelegramUpdate(textUpdate('/new 1 My Remote Chat'))

    expect(createSessionMock).toHaveBeenCalledTimes(1)
    const draft = createSessionMock.mock.calls[0][0] as Partial<Session>
    expect(draft.projectId).toBe('p1')
    expect(updateSessionMock).toHaveBeenCalledWith('created-id', { name: 'My Remote Chat' })
    expect(await lastReplyText()).toBe('Created chat "{{name}}".')
  })

  it('replies "No access." when the project has no Remote access', async () => {
    await handleTelegramUpdate(textUpdate('/new 2 My Chat'))
    await handleTelegramUpdate(textUpdate('/new 7 My Chat'))

    expect(createSessionMock).not.toHaveBeenCalled()
    const texts = sendTelegramMessageMock.mock.calls.map((call) => String(call[1]))
    expect(texts.filter((text) => text === 'No access.')).toHaveLength(2)
  })
})

describe('handleTelegramUpdate – /last', () => {
  it('returns the formatted last request of a Remote chat', async () => {
    const remoteChat = makeSession({ id: 's1', name: 'Chat One', settings: { remoteEnabled: true } })
    listSessionsMetaMock.mockResolvedValue([{ id: 's1' }])
    getSessionMock.mockResolvedValue(remoteChat)

    await handleTelegramUpdate(textUpdate('/last 1'))

    expect(await lastReplyText()).toBe('LAST_REQUEST_OF:Chat One')
  })

  it('replies "No access." for unknown targets and reports empty chats', async () => {
    const emptyRemoteChat = makeSession({ id: 's1', name: 'Chat One', messages: [], settings: { remoteEnabled: true } })
    listSessionsMetaMock.mockResolvedValue([{ id: 's1' }])
    getSessionMock.mockResolvedValue(emptyRemoteChat)

    await handleTelegramUpdate(textUpdate('/last 5'))
    expect(await lastReplyText()).toBe('No access.')

    await handleTelegramUpdate(textUpdate('/last 1'))
    expect(await lastReplyText()).toBe('No messages yet.')
  })
})

describe('handleTelegramUpdate – inline button', () => {
  it('reads back the last request of a Remote chat', async () => {
    const remoteChat = makeSession({ id: 's1', name: 'Chat One', settings: { remoteEnabled: true } })
    getSessionMock.mockResolvedValue(remoteChat)

    await handleTelegramUpdate(callbackUpdate('read:s1'))

    expect(await lastReplyText()).toBe('LAST_REQUEST_OF:Chat One')
  })

  it('answers "No access." for non-remote or missing chats', async () => {
    const plainChat = makeSession({ id: 's2', name: 'Chat Two', settings: {} })
    getSessionMock.mockResolvedValue(plainChat)

    await handleTelegramUpdate(callbackUpdate('read:s2'))
    expect(await lastReplyText()).toBe('No access.')

    getSessionMock.mockResolvedValue(null)
    await handleTelegramUpdate(callbackUpdate('read:missing'))
    expect(await lastReplyText()).toBe('No access.')

    await handleTelegramUpdate(callbackUpdate('bogus-data'))
    expect(await lastReplyText()).toBe('No access.')
  })
})
