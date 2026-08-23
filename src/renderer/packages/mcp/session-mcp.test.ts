import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MCPServerConfig } from './types'

const { mcpControllerMock, getSettingsMock } = vi.hoisted(() => ({
  mcpControllerMock: {
    servers: new Map<string, { instance: unknown; config: unknown }>(),
    getServer: vi.fn(),
    startServer: vi.fn(),
    stopServer: vi.fn(),
    updateServer: vi.fn(),
    bootstrap: vi.fn(),
    subscribeToServerStatus: vi.fn(),
    getAvailableTools: vi.fn(() => ({})),
  },
  getSettingsMock: vi.fn(),
}))

vi.mock('@/stores/settingsStore', () => ({
  settingsStore: {
    getState: () => ({
      getSettings: getSettingsMock,
    }),
  },
}))

vi.mock('./controller', () => ({
  mcpController: mcpControllerMock,
}))

vi.mock('./builtin', () => ({
  BUILTIN_MCP_SERVERS: [],
  getBuiltinServerConfig: vi.fn(() => null),
}))

import { ensureSessionMcpServersAvailable } from './session-mcp'

function makeInstance(state: string, error?: string) {
  return {
    status: { state, ...(error ? { error } : {}) },
    reconnect: vi.fn(async () => {}),
  }
}

function globalSettingsWith(servers: MCPServerConfig[]) {
  return {
    mcp: {
      servers,
      enabledBuiltinServers: [],
    },
  }
}

describe('ensureSessionMcpServersAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mcpControllerMock.servers.clear()
    mcpControllerMock.getServer.mockImplementation((id: string) => mcpControllerMock.servers.get(id)?.instance)
    getSettingsMock.mockReturnValue(
      globalSettingsWith([
        {
          id: 'srv-1',
          name: 'My Server',
          enabled: true,
          transport: { type: 'http', url: 'https://example.com/mcp' },
        },
      ])
    )
  })

  it('returns no unavailable servers when every active server is running', async () => {
    const running = makeInstance('running')
    mcpControllerMock.servers.set('srv-1', { instance: running, config: {} })

    await expect(ensureSessionMcpServersAvailable()).resolves.toEqual([])
    expect(running.reconnect).not.toHaveBeenCalled()
    expect(mcpControllerMock.startServer).not.toHaveBeenCalled()
  })

  it('reconnects a registered-but-unavailable server once and reports it when still down', async () => {
    const broken = makeInstance('idle', 'spawn ENOENT')
    mcpControllerMock.servers.set('srv-1', { instance: broken, config: {} })

    await expect(ensureSessionMcpServersAvailable()).resolves.toEqual([
      { id: 'srv-1', name: 'My Server', reason: 'spawn ENOENT' },
    ])
    expect(broken.reconnect).toHaveBeenCalledTimes(1)
    expect(mcpControllerMock.startServer).not.toHaveBeenCalled()
  })

  it('starts and awaits a server that is not registered yet', async () => {
    mcpControllerMock.startServer.mockImplementation(async (config: MCPServerConfig) => {
      const running = makeInstance('running')
      mcpControllerMock.servers.set(config.id, { instance: running, config })
    })

    await expect(ensureSessionMcpServersAvailable()).resolves.toEqual([])
    expect(mcpControllerMock.startServer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'srv-1', enabled: true })
    )
  })

  it('reports a freshly started server that failed to reach the running state', async () => {
    mcpControllerMock.startServer.mockImplementation(async (config: MCPServerConfig) => {
      const failed = makeInstance('idle', 'handshake timed out')
      mcpControllerMock.servers.set(config.id, { instance: failed, config })
    })

    await expect(ensureSessionMcpServersAvailable()).resolves.toEqual([
      { id: 'srv-1', name: 'My Server', reason: 'handshake timed out' },
    ])
  })

  it('ignores allow-list ids that have neither a process nor a config', async () => {
    getSettingsMock.mockReturnValue(globalSettingsWith([]))
    mcpControllerMock.servers.set('ghost', { instance: makeInstance('idle'), config: {} })

    // 'ghost' is registered but not in the chat's allow list, so it is skipped;
    // nothing else is active.
    await expect(ensureSessionMcpServersAvailable()).resolves.toEqual([])
  })
})
