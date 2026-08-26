import { describe, expect, it, vi } from 'vitest'
import type { Message, Session } from '@shared/types'

const tMock = vi.hoisted(() => vi.fn((key: string) => key))

vi.mock('@/i18n', () => ({ default: { t: tMock } }))

vi.mock('@/packages/tools', () => ({
  getToolName: (toolName: string) => {
    if (toolName === 'mcp__github__create_issue') return 'GitHub (create_issue)'
    if (toolName === 'terminal') return 'Terminal'
    return toolName
  },
}))

import { formatCompletionNotification, formatLastRequest, truncate } from './format'

let messageCounter = 0

function userMessage(text: string): Message {
  return {
    id: `user-${messageCounter++}`,
    role: 'user',
    contentParts: [{ type: 'text', text }],
    timestamp: Date.now(),
  }
}

function assistantMessage(text: string): Message {
  return {
    id: `assistant-${messageCounter++}`,
    role: 'assistant',
    contentParts: [{ type: 'text', text }],
    timestamp: Date.now(),
  }
}

function toolCallMessage(toolName: string): Message {
  return {
    id: `tools-${messageCounter++}`,
    role: 'assistant',
    contentParts: [{ type: 'tool-call', toolCallId: `call-${messageCounter}`, toolName, state: 'result' }],
    timestamp: Date.now(),
  }
}

function sessionWith(messages: Message[]): Session {
  return {
    id: 'session-1',
    name: 'Test Chat',
    type: 'chat',
    messages,
    settings: {},
  } as Session
}

describe('formatLastRequest', () => {
  it('returns null when the chat has no user messages', () => {
    const session = sessionWith([assistantMessage('only an answer')])
    expect(formatLastRequest(session)).toBeNull()
  })

  it('returns null for a chat without messages', () => {
    expect(formatLastRequest(sessionWith([]))).toBeNull()
  })

  it('formats the last user message and the AI answer', () => {
    const session = sessionWith([
      userMessage('first question'),
      assistantMessage('first answer'),
      userMessage('second question'),
      assistantMessage('second answer'),
    ])
    const text = formatLastRequest(session)!
    expect(text).toContain('👤 second question')
    expect(text).toContain('🤖 second answer')
    expect(text).not.toContain('first question')
  })

  it('lists MCP tool calls between the request and the answer in the short desktop form', () => {
    const session = sessionWith([
      userMessage('create an issue'),
      toolCallMessage('mcp__github__create_issue'),
      toolCallMessage('terminal'),
      assistantMessage('done'),
    ])
    const text = formatLastRequest(session)!
    expect(text).toContain('🔧 MCP · GitHub (create_issue)')
    expect(text).toContain('🔧 Terminal')
    // Built-in tools keep their translated name without the MCP prefix.
    expect(text).not.toContain('MCP · Terminal')
  })

  it('ignores tool calls from before the last user message', () => {
    const session = sessionWith([
      userMessage('earlier task'),
      toolCallMessage('mcp__github__create_issue'),
      assistantMessage('earlier answer'),
      userMessage('simple question'),
      assistantMessage('simple answer'),
    ])
    const text = formatLastRequest(session)!
    expect(text).not.toContain('MCP ·')
  })

  it('includes the chat name in the output', () => {
    const session = sessionWith([userMessage('hi'), assistantMessage('hello')])
    expect(formatLastRequest(session)).toContain('Chat')
    expect(formatLastRequest(session)).toContain('Test Chat')
  })
})

describe('formatCompletionNotification', () => {
  it('reports success with project and chat names', () => {
    const text = formatCompletionNotification({ success: true, projectName: 'My Project', sessionName: 'My Chat' })
    expect(text).toContain('✅ Task completed')
    expect(text).toContain('My Project')
    expect(text).toContain('My Chat')
  })

  it('reports failure including the error text', () => {
    const text = formatCompletionNotification({
      success: false,
      projectName: undefined,
      sessionName: 'My Chat',
      error: 'boom',
    })
    expect(text).toContain('❌ Task failed')
    expect(text).toContain('boom')
    expect(text).not.toContain('✅')
  })
})

describe('truncate', () => {
  it('keeps short texts intact', () => {
    expect(truncate('short')).toBe('short')
  })

  it('cuts long texts with an ellipsis', () => {
    expect(truncate('a'.repeat(50), 10)).toBe(`${'a'.repeat(10)}…`)
  })
})
