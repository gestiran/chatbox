import { beforeEach, describe, expect, vi } from 'vitest'
import { getMcpToolTitle, parseMcpToolName } from './tool-name'

const mcpSettings = vi.hoisted(() => ({
  servers: [] as Array<{ name: string }>,
  enabledBuiltinServers: [] as string[],
}))

vi.mock('@/stores/settingsStore', () => ({
  settingsStore: {
    getState: () => ({ mcp: mcpSettings }),
  },
}))

vi.mock('./builtin', () => ({
  BUILTIN_MCP_SERVERS: [
    { id: 'fetch', name: 'Fetch' },
    { id: 'context7', name: 'Context7' },
  ],
}))

describe('parseMcpToolName', () => {
  beforeEach(() => {
    mcpSettings.servers = []
    mcpSettings.enabledBuiltinServers = []
  })

  it('returns null for non-MCP tools', () => {
    expect(parseMcpToolName('web_search')).toBeNull()
    expect(parseMcpToolName('chatbox_cli')).toBeNull()
  })

  it('resolves the server display name from the configured servers', () => {
    mcpSettings.servers = [{ name: 'GitHub' }]
    expect(parseMcpToolName('mcp__github__create_issue')).toEqual({ serverName: 'GitHub', toolName: 'create_issue' })
  })

  it('matches a configured name whose whitespace was encoded as underscores', () => {
    mcpSettings.servers = [{ name: 'My Server' }]
    expect(parseMcpToolName('mcp__my_server__get_weather')).toEqual({
      serverName: 'My Server',
      toolName: 'get_weather',
    })
  })

  it('matches a configured name whose unsupported characters were encoded as underscores', () => {
    mcpSettings.servers = [{ name: 'My.Server' }]
    expect(parseMcpToolName('mcp__my_server__run')).toEqual({ serverName: 'My.Server', toolName: 'run' })
  })

  it('prefers the longest matching server name', () => {
    mcpSettings.servers = [{ name: 'arxiv' }, { name: 'arxiv2' }]
    expect(parseMcpToolName('mcp__arxiv2__search')).toEqual({ serverName: 'arxiv2', toolName: 'search' })
    expect(parseMcpToolName('mcp__arxiv__search')).toEqual({ serverName: 'arxiv', toolName: 'search' })
  })

  it('falls back to builtin server names', () => {
    expect(parseMcpToolName('mcp__context7__resolve-library-id')).toEqual({
      serverName: 'Context7',
      toolName: 'resolve-library-id',
    })
  })

  it('keeps the encoded server segment when the server is not configured anymore', () => {
    expect(parseMcpToolName('mcp__github__create_issue')).toEqual({ serverName: 'github', toolName: 'create_issue' })
  })

  it('returns only the tool when no server segment is present', () => {
    expect(parseMcpToolName('mcp__do_thing')).toEqual({ toolName: 'do_thing' })
  })

  it('accepts an explicit server name list instead of the settings store', () => {
    expect(parseMcpToolName('mcp__my_server__run', ['Other Server', 'My Server'])).toEqual({
      serverName: 'My Server',
      toolName: 'run',
    })
  })
})

describe('getMcpToolTitle', () => {
  beforeEach(() => {
    mcpSettings.servers = []
    mcpSettings.enabledBuiltinServers = []
  })

  it('formats MCP titles as "server (tool)" using the configured name verbatim', () => {
    mcpSettings.servers = [{ name: 'Context 7 Official' }]
    expect(getMcpToolTitle('mcp__context_7_official__get-docs')).toBe('Context 7 Official (get-docs)')
  })

  it('keeps the host prefix for names with dots, spaces or punctuation', () => {
    mcpSettings.servers = [{ name: 'MCP: Server #1' }]
    expect(getMcpToolTitle('mcp__mcp__server__1__search')).toBe('MCP: Server #1 (search)')
  })

  it('falls back to the bare tool name when no server segment exists', () => {
    expect(getMcpToolTitle('mcp__do_thing')).toBe('do_thing')
  })

  it('uses the encoded segment when the server is unknown', () => {
    expect(getMcpToolTitle('mcp__github__create_issue')).toBe('github (create_issue)')
  })

  it('returns null for non-MCP tools', () => {
    expect(getMcpToolTitle('read_file')).toBeNull()
  })
})
