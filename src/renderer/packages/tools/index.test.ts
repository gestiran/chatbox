import { describe, expect, it, vi } from 'vitest'

vi.mock('i18next', () => ({ t: (key: string) => key }))

const mcpSettings = vi.hoisted(() => ({
  servers: [
    { id: 'github', name: 'GitHub', enabled: true },
    { id: 'my-server', name: 'My Server', enabled: true },
  ],
  enabledBuiltinServers: [] as string[],
}))

vi.mock('@/stores/settingsStore', () => ({
  settingsStore: {
    getState: () => ({ mcp: mcpSettings }),
  },
}))

vi.mock('@/packages/mcp/builtin', () => ({
  BUILTIN_MCP_SERVERS: [{ id: 'context7', name: 'Context7' }],
}))

import { getToolName } from './index'

describe('getToolName', () => {
  it.each([
    [{ argv: ['version'] }, 'Chatbox Version'],
    [{ argv: ['account', 'status'] }, 'Account Status'],
    [{ argv: ['account', 'license'] }, 'License Details'],
    [{ argv: ['account', 'quota'] }, 'Quota Details'],
    [{ argv: ['account', 'refresh'] }, 'Refresh Account Status'],
    [{ argv: ['settings', 'list'] }, 'List Settings'],
    [{ command: 'chatbox settings get appearance.theme' }, 'Read Setting'],
    [{ argv: ['chats', 'list', '--limit', '10'] }, 'Conversation List'],
    [{ argv: ['chats', 'search', 'release notes'] }, 'Search All Conversations'],
    [{ argv: ['chats', 'read', 'session-1'] }, 'Read Conversation'],
    [{ argv: ['image', 'models'] }, 'List Image Models'],
    [{ command: 'chatbox image generate --prompt "a red fox"' }, 'Generate images'],
    [{ argv: ['image', 'status', 'record-1'] }, 'Image Generation Status'],
    [{ argv: ['image', 'history'] }, 'Image History'],
  ])('shows a command-specific Chatbox CLI name for %j', (input, expected) => {
    expect(getToolName('chatbox_cli', input)).toBe(expected)
  })

  it('supports legacy account aliases and safe fallback names', () => {
    expect(getToolName('chatbox_cli', { argv: ['quota'] })).toBe('Quota Details')
    expect(getToolName('chatbox_cli', { argv: ['license', 'refresh'] })).toBe('Refresh Account Status')
    expect(getToolName('chatbox_cli', { argv: ['help'] })).toBe('Chatbox')
    expect(getToolName('chatbox_cli', { command: '"unterminated' })).toBe('Chatbox')
  })

  it.each([
    ['mcp__github__create_issue', 'GitHub (create_issue)'],
    ['mcp__my_server__get_weather', 'My Server (get_weather)'],
    ['mcp__unknown_server__run_query', 'unknown_server (run_query)'],
    ['mcp__do_thing', 'do_thing'],
  ])('formats the MCP tool title "%s" as "%s"', (toolName, expected) => {
    expect(getToolName(toolName)).toBe(expected)
  })

  it('keeps built-in tool names untranslated when they are unknown keys', () => {
    expect(getToolName('read_file')).toBe('Read File')
    expect(getToolName('some_future_tool')).toBe('some_future_tool')
  })
})
