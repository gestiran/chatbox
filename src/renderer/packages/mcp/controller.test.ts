import { afterEach, describe, expect, it, vi } from 'vitest'
import { MCPServer } from './controller'

interface RecordedRequest {
  method: string
  body?: Record<string, unknown>
  protocolVersion: string | null
}

// A healthy 2025-11-25 Streamable HTTP server exposing a single `echo` tool.
function stubWorkingPhpSdkFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(null, { status: 405, statusText: 'Method Not Allowed' })
      }
      if (body?.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'php-sdk', version: '0.7.0' },
          },
        })
      }
      if (body?.method === 'notifications/initialized') {
        return new Response(null, { status: 202 })
      }
      if (body?.method === 'tools/list') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [
              {
                name: 'echo',
                description: 'Echo the input text',
                inputSchema: { type: 'object', properties: {}, required: [] },
              },
            ],
          },
        })
      }
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [] } })
    })
  )
}

describe('MCPServer HTTP transport', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('connects to a 2025-11-25 server that does not support GET SSE', async () => {
    const requests: RecordedRequest[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? 'GET'
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
        const headers = new Headers(init?.headers)
        requests.push({
          method,
          body,
          protocolVersion: headers.get('mcp-protocol-version'),
        })

        if (method === 'GET') {
          return new Response(null, { status: 405, statusText: 'Method Not Allowed' })
        }

        if (body?.method === 'initialize') {
          return Response.json(
            {
              jsonrpc: '2.0',
              id: body.id,
              result: {
                protocolVersion: '2025-11-25',
                capabilities: { tools: {} },
                serverInfo: { name: 'php-sdk', version: '0.7.0' },
              },
            },
            {
              headers: {
                'mcp-session-id': 'php-sdk-session',
              },
            }
          )
        }

        if (body?.method === 'notifications/initialized') {
          return new Response(null, { status: 202 })
        }

        if (body?.method === 'tools/list') {
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              tools: [
                {
                  name: 'echo',
                  description: 'Echo the input text',
                  inputSchema: {
                    type: 'object',
                    properties: { text: { type: 'string' } },
                    required: ['text'],
                  },
                },
              ],
            },
          })
        }

        if (body?.method === 'tools/call') {
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [{ type: 'text', text: 'hello' }],
            },
          })
        }

        return new Response(null, { status: 500 })
      })
    )

    const server = new MCPServer({
      type: 'http',
      url: 'https://php-sdk.example.com/mcp',
    })

    await server.start()

    expect(server.status).toEqual({ state: 'running' })
    expect(Object.keys(server.getAvailableTools())).toEqual(['echo'])
    const echoResult = await server
      .getAvailableTools()
      .echo.execute?.({ text: 'hello' }, { toolCallId: 'echo-call', messages: [] })
    expect(echoResult).toEqual({
      content: [{ type: 'text', text: 'hello' }],
      isError: false,
    })
    expect(requests[0].body).toMatchObject({
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    })
    expect(requests.map((request) => request.body?.method ?? request.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'GET',
      'tools/list',
      'tools/call',
    ])
    expect(requests.slice(1).map((request) => request.protocolVersion)).toEqual([
      '2025-11-25',
      '2025-11-25',
      '2025-11-25',
      '2025-11-25',
    ])

    await server.stop()
  })

  it('preserves the Streamable HTTP error when the legacy SSE fallback also fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'GET') {
          return new Response(null, { status: 405, statusText: 'Method Not Allowed' })
        }

        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2099-01-01',
            capabilities: {},
            serverInfo: { name: 'future-server', version: '1.0.0' },
          },
        })
      })
    )

    const server = new MCPServer({
      type: 'http',
      url: 'https://future.example.com/mcp',
    })

    await server.start()

    expect(server.status.state).toBe('idle')
    expect(server.status.error).toContain(
      "Streamable HTTP connection failed: Server's protocol version is not supported: 2099-01-01"
    )
    expect(server.status.error).toContain('Legacy SSE fallback failed: MCP SSE Transport Error: 405 Method Not Allowed')
  })

  it('reconnects with a fresh client after a failed start', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 500, statusText: 'Internal Server Error' }))
    )

    const server = new MCPServer({
      type: 'http',
      url: 'https://php-sdk.example.com/mcp',
    })

    await server.start()
    expect(server.status.state).toBe('idle')
    expect(server.status.error).toBeTruthy()
    expect(server.getAvailableTools()).toEqual({})

    // The server comes back online; reconnect() must attempt a fresh
    // connection instead of keeping the failed one.
    stubWorkingPhpSdkFetch()

    await server.reconnect()

    expect(server.status).toEqual({ state: 'running' })
    await server.stop()
  })

  it('reconnect() reports the failure when a running server goes down, then recovers', async () => {
    stubWorkingPhpSdkFetch()

    const server = new MCPServer({
      type: 'http',
      url: 'https://php-sdk.example.com/mcp',
    })

    await server.start()
    expect(server.status).toEqual({ state: 'running' })
    expect(Object.keys(server.getAvailableTools())).toEqual(['echo'])

    // The server goes down; reconnect must surface the failure instead of
    // silently keeping the stale "running" status.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused')
      })
    )
    await server.reconnect()
    expect(server.status.state).toBe('idle')
    // The SDK may wrap the transport failure, so only check that a reason survived.
    expect(server.status.error).toBeTruthy()
    expect(server.getAvailableTools()).toEqual({})

    // ...and a later reconnect recovers once the server is back.
    stubWorkingPhpSdkFetch()
    await server.reconnect()
    expect(server.status).toEqual({ state: 'running' })
    expect(Object.keys(server.getAvailableTools())).toEqual(['echo'])

    await server.stop()
  })
})

/** Records the JSON-RPC method (or 'GET') of every request the transport makes. */
function stubRecordingFetch(options: { failToolsList?: () => boolean } = {}) {
  const methods: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
      const method = (init?.method ?? 'GET') === 'GET' ? 'GET' : String(body?.method ?? 'GET')
      methods.push(method)

      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(null, { status: 405, statusText: 'Method Not Allowed' })
      }
      if (body?.method === 'tools/list' && options.failToolsList?.()) {
        return Promise.reject(new Error('socket hang up'))
      }
      if (body?.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'php-sdk', version: '0.7.0' },
          },
        })
      }
      if (body?.method === 'notifications/initialized') {
        return new Response(null, { status: 202 })
      }
      if (body?.method === 'tools/list') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [
              {
                name: 'echo',
                description: 'Echo the input text',
                inputSchema: { type: 'object', properties: {}, required: [] },
              },
            ],
          },
        })
      }
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [] } })
    })
  )
  return {
    methods,
    count: (method: string) => methods.filter((entry) => entry === method).length,
  }
}

describe('MCPServer connection lifecycle', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function stubHangingFetch() {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {}))
    )
  }

  it('gives up on a server that never answers instead of waiting forever', async () => {
    stubHangingFetch()
    vi.useFakeTimers()

    const server = new MCPServer({ type: 'http', url: 'https://hanging.example.com/mcp' })
    const started = server.start()
    // Both bounded attempts plus the delay between them; without the timeout
    // this promise would never settle and the server would stay a zombie.
    await vi.advanceTimersByTimeAsync(120_000)
    await started

    expect(server.status.state).toBe('idle')
    expect(server.status.error).toContain('timed out')
    expect(server.getAvailableTools()).toEqual({})
  })

  it('does not resurrect a server that was stopped while connecting', async () => {
    stubHangingFetch()
    vi.useFakeTimers()

    const server = new MCPServer({ type: 'http', url: 'https://hanging.example.com/mcp' })
    const started = server.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(server.status.state).toBe('starting')

    // Stopping must not wait for the slow handshake, and the attempt that is
    // still running must not bring the server back to life afterwards.
    await server.stop()
    expect(server.status).toEqual({ state: 'idle' })

    await vi.advanceTimersByTimeAsync(120_000)
    await started
    expect(server.status).toEqual({ state: 'idle' })
  })

  it('probes a healthy connection instead of respawning it', async () => {
    const recorded = stubRecordingFetch()
    const server = new MCPServer({ type: 'http', url: 'https://php-sdk.example.com/mcp' })

    await server.start()
    expect(server.status).toEqual({ state: 'running' })
    expect(recorded.count('initialize')).toBe(1)
    expect(recorded.count('tools/list')).toBe(1)

    await server.ensureReady()

    expect(server.status).toEqual({ state: 'running' })
    expect(recorded.count('initialize')).toBe(1)
    // The liveness probe re-reads the tool list, which also picks up tools the
    // server added since the connection was made.
    expect(recorded.count('tools/list')).toBe(2)
    expect(Object.keys(server.getAvailableTools())).toEqual(['echo'])

    await server.stop()
  })

  it('recovers a running server whose connection died without a close event', async () => {
    let healthy = true
    stubRecordingFetch({ failToolsList: () => !healthy })
    const server = new MCPServer({ type: 'http', url: 'https://php-sdk.example.com/mcp' })

    await server.start()
    expect(server.status).toEqual({ state: 'running' })

    // The server goes away while the status still claims it is running: the
    // next review must notice instead of handing out tools that cannot work.
    healthy = false
    await server.ensureReady()
    expect(server.status.state).toBe('idle')
    expect(server.status.error).toBeTruthy()
    expect(server.getAvailableTools()).toEqual({})

    // ...and it comes back on its own once the server is reachable again.
    healthy = true
    await server.ensureReady()
    expect(server.status).toEqual({ state: 'running' })
    expect(Object.keys(server.getAvailableTools())).toEqual(['echo'])

    await server.stop()
  })

  it('shares a single reconnect between chats sending at the same time', async () => {
    const recorded = stubRecordingFetch()
    const server = new MCPServer({ type: 'http', url: 'https://php-sdk.example.com/mcp' })

    await Promise.all([server.ensureReady(), server.ensureReady(), server.ensureReady()])

    expect(server.status).toEqual({ state: 'running' })
    expect(recorded.count('initialize')).toBe(1)

    await server.stop()
  })

  it('waits for a start another chat triggered instead of reporting it unavailable', async () => {
    const recorded = stubRecordingFetch()
    const server = new MCPServer({ type: 'http', url: 'https://php-sdk.example.com/mcp' })

    const starting = server.start()
    await server.ensureReady()
    await starting

    expect(server.status).toEqual({ state: 'running' })
    expect(recorded.count('initialize')).toBe(1)

    await server.stop()
  })

  it('stops claiming to be running when a tool call hits a dead connection', async () => {
    stubWorkingPhpSdkFetch()
    const server = new MCPServer({ type: 'http', url: 'https://php-sdk.example.com/mcp' })

    await server.start()
    expect(server.status).toEqual({ state: 'running' })

    // What @ai-sdk/mcp throws for every call made over a transport that closed:
    // the server must stop handing out tools that cannot possibly work.
    server.reportToolCallFailure(new Error('Attempted to send a request from a closed client'))

    expect(server.status.state).toBe('idle')
    expect(server.status.error).toContain('closed client')
    expect(server.getAvailableTools()).toEqual({})
  })

  it('ignores a tool call failure that has nothing to do with the connection', async () => {
    stubWorkingPhpSdkFetch()
    const server = new MCPServer({ type: 'http', url: 'https://php-sdk.example.com/mcp' })

    await server.start()
    server.reportToolCallFailure(new Error('Tool "echo" returned invalid arguments'))

    expect(server.status).toEqual({ state: 'running' })
    expect(Object.keys(server.getAvailableTools())).toEqual(['echo'])

    await server.stop()
  })
})
