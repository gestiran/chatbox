import { createMCPClient } from '@ai-sdk/mcp'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ToolSet } from 'ai'
import Emittery from 'emittery'
import { isEqual } from 'lodash'
import { IPCStdioTransport } from './ipc-stdio-transport'
import { normalizeServerSegment } from './tool-name'
import type { MCPServerConfig, MCPServerStatus } from './types'

type TransportConfig = MCPServerConfig['transport']
type MCPClient = Awaited<ReturnType<typeof createMCPClient>>

async function createClient(transportConfig: TransportConfig, name = 'chatbox-mcp-client'): Promise<MCPClient> {
  if (transportConfig.type === 'stdio') {
    const transport = await IPCStdioTransport.create(transportConfig)
    let errorMessage = ''
    try {
      return await createMCPClient({
        name,
        transport,
        onUncaughtError(error: unknown) {
          console.error('mcp:client:onUncaughtError', error)
          errorMessage += (error as Error).message
        },
      })
    } catch (err) {
      transport.close().catch(console.error)
      let message = (err as Error).message
      if (errorMessage && !message.includes(errorMessage)) {
        message += `\n${errorMessage}`
      }
      throw new Error(message, { cause: err })
    }
  }
  if (transportConfig.type === 'http') {
    try {
      const transport = new StreamableHTTPClientTransport(new URL(transportConfig.url), {
        requestInit: { headers: transportConfig.headers },
      })
      return await createMCPClient({
        name,
        transport,
        onUncaughtError(error: unknown) {
          console.error('mcp:client:onUncaughtError', error)
        },
      })
    } catch (err) {
      console.error('Streamable HTTP connection failed', err)
      try {
        return await createMCPClient({
          name,
          transport: {
            type: 'sse',
            url: transportConfig.url,
            headers: transportConfig.headers,
          },
          onUncaughtError(error: unknown) {
            console.error('mcp:client:onUncaughtError', error)
          },
        })
      } catch (fallbackError) {
        const streamableMessage = err instanceof Error ? err.message : String(err)
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        throw new Error(
          `Streamable HTTP connection failed: ${streamableMessage}\nLegacy SSE fallback failed: ${fallbackMessage}`,
          { cause: err }
        )
      }
    }
  }
  throw new Error('Unknown transport type')
}

export class MCPServer extends Emittery<{ status: MCPServerStatus }> {
  private _status: MCPServerStatus = { state: 'idle' }
  private client?: MCPClient
  private tools?: ToolSet
  // Serializes lifecycle operations so concurrent triggers (e.g. two chats
  // sending messages at once) cannot interleave start/stop/reconnect steps.
  private lifecycleQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly transportConfig: TransportConfig) {
    super()
  }

  get status() {
    return this._status
  }

  set status(status: MCPServerStatus) {
    this._status = status
    this.emit('status', status)
  }

  private runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(operation)
    // Keep the queue chain alive regardless of operation failures.
    this.lifecycleQueue = result.catch(() => undefined)
    return result
  }

  async start() {
    return this.runSerialized(() => {
      if (this.status.state !== 'idle') {
        return Promise.resolve()
      }
      return this.connect()
    })
  }

  /**
   * Drops any existing client and performs a fresh connection attempt whatever
   * the current status is. Used to recover servers that failed to start or
   * whose process died, e.g. right before sending a chat message.
   */
  async reconnect(): Promise<void> {
    return this.runSerialized(async () => {
      const staleClient = this.client
      this.client = undefined
      this.tools = undefined
      if (staleClient) {
        try {
          await staleClient.close()
        } catch (err) {
          console.error('mcp:client:close', err)
        }
      }
      this.status = { state: 'idle' }
      await this.connect()
    })
  }

  private async connect(): Promise<void> {
    this.status = { state: 'starting' }
    try {
      this.client = await createClient(this.transportConfig)
      // @ai-sdk/mcp can resolve a newer @ai-sdk/provider-utils patch than `ai`.
      // The returned tools share the same runtime schema contract, but TypeScript
      // treats the two package instances' schema symbols as distinct.
      this.tools = (await this.client.tools()) as unknown as ToolSet
    } catch (err) {
      console.error('mcp:client:start', err)
      this.status = { state: 'idle', error: (err as Error).message }
      return
    }
    this.status = { state: 'running' }
  }

  async stop() {
    return this.runSerialized(async () => {
      if (this.status.state !== 'running') {
        return
      }
      this.status = { state: 'stopping' }
      await this.client?.close()
      this.tools = undefined
      this.status = { state: 'idle' }
    })
  }

  getAvailableTools(): ToolSet {
    if (!this.client || this.status.state !== 'running') {
      return {}
    }
    return this.tools || {}
  }
}

// 根据用户配置管理MCP服务器的实际运行
export const mcpController = {
  servers: new Map<string, { instance: MCPServer; config: MCPServerConfig }>(),
  _statusSubscribers: new Map<string, Set<(status: MCPServerStatus) => void>>(),

  bootstrap(serverConfigs: MCPServerConfig[]) {
    for (const serverConfig of serverConfigs) {
      if (serverConfig.enabled) {
        void this.startServer(serverConfig)
      }
    }
  },

  async startServer(serverConfig: MCPServerConfig) {
    if (!serverConfig.enabled) {
      return
    }

    const existing = this.servers.get(serverConfig.id)
    if (existing) {
      // Already managed (possibly started by another chat or during bootstrap).
      // Reuse the instance instead of replacing it, otherwise concurrent
      // senders would spawn duplicate processes/clients for the same server;
      // start() is a no-op while it is already starting or running.
      await existing.instance.start()
      return
    }

    const server = new MCPServer(serverConfig.transport)
    this.servers.set(serverConfig.id, { instance: server, config: serverConfig })

    // 如果有订阅者，重新连接他们
    const subscribers = this._statusSubscribers.get(serverConfig.id)
    if (subscribers) {
      subscribers.forEach((subscriber) => {
        server.on('status', subscriber)
      })
    }

    await server.start()
  },

  async stopServer(id: string) {
    const server = this.servers.get(id)
    this.servers.delete(id)
    await server?.instance.stop()
    server?.instance.clearListeners()
  },

  async updateServer(serverConfig: MCPServerConfig) {
    if (!serverConfig.enabled) {
      await this.stopServer(serverConfig.id)
      return
    }
    const server = this.servers.get(serverConfig.id)
    if (!server) {
      await this.startServer(serverConfig)
      return
    }
    if (isEqual(server.config.transport, serverConfig.transport)) {
      server.config = serverConfig
    } else {
      await this.stopServer(serverConfig.id)
      await this.startServer(serverConfig)
    }
  },

  getServer(id: string): MCPServer | undefined {
    const server = this.servers.get(id)
    return server?.instance
  },

  subscribeToServerStatus(id: string, callback: (status: MCPServerStatus) => void) {
    let subscribers = this._statusSubscribers.get(id)
    if (!subscribers) {
      subscribers = new Set()
      this._statusSubscribers.set(id, subscribers)
    }
    subscribers.add(callback)

    const server = this.getServer(id)
    if (server) {
      server.on('status', callback)
      callback(server.status)
    }

    return () => {
      server?.off('status', callback)
      subscribers.delete(callback)
    }
  },

  /**
   * Collects tools from running servers. Pass `enabledServerIds` to restrict
   * the result to a specific chat's server selection (per-chat MCP
   * availability); omit it to get tools from every running server.
   */
  getAvailableTools(filter?: { enabledServerIds?: string[] }): ToolSet {
    const toolSet: ToolSet = {}
    const allowedServerIds = filter?.enabledServerIds
    for (const { instance, config } of this.servers.values()) {
      if (allowedServerIds && !allowedServerIds.includes(config.id)) {
        continue
      }
      const mcpTools = instance.getAvailableTools()
      for (const [toolName, tool] of Object.entries(mcpTools)) {
        const rawExecute = tool.execute?.bind(tool)
        toolSet[normalizeToolName(config.name, toolName)] = {
          ...tool,
          execute: async (args, options) => {
            try {
              return await rawExecute?.(args, options)
            } catch (err) {
              // 返回而非抛出，否则会导致流程中断。
              // 必须返回可 JSON 序列化的结构：直接返回原始 Error/MCPClientError 会把脏数据写进对话历史，
              // 下次组装 ModelMessage[] 时 AI SDK 本地校验会抛 AI_InvalidPromptError，导致请求发不出去。
              return {
                isError: true,
                content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
              }
            }
          },
        }
      }
    }
    return toolSet
  },
}

function normalizeToolName(serverName: string, toolName: string) {
  // Always encode the server segment so the UI can render the call as
  // "<Server Name> (<tool>)" — even when the configured name contains
  // characters the tool-key charset cannot hold.
  const segment = normalizeServerSegment(serverName)
  if (segment) {
    return `mcp__${segment}__${toolName}`
  }
  return `mcp__${toolName}`
}
