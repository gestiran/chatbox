import { createMCPClient } from '@ai-sdk/mcp'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ToolSet } from 'ai'
import Emittery from 'emittery'
import { isEqual } from 'lodash'
import { IPCStdioTransport } from './ipc-stdio-transport'
import { normalizeServerSegment } from './tool-name'
import { observeTransportConnection, type TransportConnectionObserver } from './transport-observer'
import type { MCPServerConfig, MCPServerStatus } from './types'

type TransportConfig = MCPServerConfig['transport']
type MCPClient = Awaited<ReturnType<typeof createMCPClient>>

/**
 * Hard bound for a single connect attempt (spawn + initialize + tools/list).
 *
 * @ai-sdk/mcp requests have no timeout of their own, so a server that accepts
 * the connection but never answers the handshake would otherwise block forever
 * - and with it the lifecycle queue of that server and every chat waiting on it.
 *
 * Generous enough for a package runner (`npx`/`uvx`) downloading the server on
 * first use; a killed attempt is retried, and the second one usually finds a
 * warm cache.
 */
const CONNECT_ATTEMPT_TIMEOUT_MS = 30_000
/** Attempts per connect: one try plus one retry, so a transient failure recovers. */
const CONNECT_MAX_ATTEMPTS = 2
const CONNECT_RETRY_DELAY_MS = 500
/** Bound for the liveness probe performed before every user message. */
const HEALTH_CHECK_TIMEOUT_MS = 10_000
/** Keeps accumulated stderr from growing the reported error without limit. */
const MAX_TRANSPORT_ERROR_LENGTH = 500

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

/**
 * Like `withTimeout`, but releases the value of an abandoned attempt as soon as
 * it materialises. Abandoning a connect must not leak the process/connection it
 * already created: the promise keeps running in the background after the
 * timeout, so its result is closed when it lands.
 */
async function withTimeoutAndCleanup<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  cleanup: (value: T) => Promise<void>
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          reject(new Error(message))
        }, ms)
      }),
    ])
  } catch (err) {
    if (timedOut) {
      promise.then(
        (value) => void cleanup(value),
        () => undefined
      )
    }
    throw err
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

interface CreatedClient {
  client: MCPClient
  /**
   * Releases the underlying connection even when the client already considers
   * itself closed: `DefaultMCPClient.close()` returns early in that case and
   * would leave a spawned child process alive.
   */
  forceClose: () => Promise<void>
}

async function closeConnection(connection: CreatedClient): Promise<void> {
  try {
    await connection.client.close()
  } catch (err) {
    console.error('mcp:client:close', err)
  }
  try {
    await connection.forceClose()
  } catch (err) {
    console.error('mcp:client:forceClose', err)
  }
}

async function createClient(
  transportConfig: TransportConfig,
  observer: TransportConnectionObserver,
  name = 'chatbox-mcp-client'
): Promise<CreatedClient> {
  if (transportConfig.type === 'stdio') {
    const transport = await IPCStdioTransport.create(transportConfig)
    observeTransportConnection(transport, observer)
    let uncaughtErrorMessage = ''
    try {
      const client = await createMCPClient({
        name,
        transport,
        onUncaughtError(error: unknown) {
          console.error('mcp:client:onUncaughtError', error)
          uncaughtErrorMessage += errorMessage(error)
        },
      })
      return { client, forceClose: () => transport.forceClose() }
    } catch (err) {
      await transport.forceClose().catch((closeError) => console.error('mcp:client:forceClose', closeError))
      let message = errorMessage(err)
      if (uncaughtErrorMessage && !message.includes(uncaughtErrorMessage)) {
        message += `\n${uncaughtErrorMessage}`
      }
      throw new Error(message, { cause: err })
    }
  }
  if (transportConfig.type === 'http') {
    const transport = new StreamableHTTPClientTransport(new URL(transportConfig.url), {
      requestInit: { headers: transportConfig.headers },
    })
    observeTransportConnection(transport, observer)
    const onUncaughtError = (error: unknown) => {
      console.error('mcp:client:onUncaughtError', error)
    }
    let streamableError: unknown
    try {
      const client = await createMCPClient({ name, transport, onUncaughtError })
      return { client, forceClose: () => transport.close() }
    } catch (err) {
      console.error('Streamable HTTP connection failed', err)
      streamableError = err
      await transport.close().catch((closeError) => console.error('mcp:client:close', closeError))
    }
    try {
      // The legacy SSE transport is created from a config object inside the SDK,
      // so its connection events cannot be observed; the health check covers it.
      const client = await createMCPClient({
        name,
        transport: {
          type: 'sse',
          url: transportConfig.url,
          headers: transportConfig.headers,
        },
        onUncaughtError,
      })
      return { client, forceClose: () => client.close() }
    } catch (fallbackError) {
      const streamableMessage = errorMessage(streamableError)
      const fallbackMessage = errorMessage(fallbackError)
      throw new Error(
        `Streamable HTTP connection failed: ${streamableMessage}\nLegacy SSE fallback failed: ${fallbackMessage}`,
        { cause: streamableError }
      )
    }
  }
  throw new Error('Unknown transport type')
}

export class MCPServer extends Emittery<{ status: MCPServerStatus }> {
  private _status: MCPServerStatus = { state: 'idle' }
  private connection?: CreatedClient
  private tools?: ToolSet
  // Serializes lifecycle operations so concurrent triggers (e.g. two chats
  // sending messages at once) cannot interleave start/stop/reconnect steps.
  private lifecycleQueue: Promise<unknown> = Promise.resolve()
  // In-flight operations by kind, so concurrent callers (several chats sending
  // at once) share one attempt instead of each spawning their own.
  private inflight = new Map<string, Promise<void>>()
  // Bumped on every teardown: a connect attempt that outlives a stop/reconnect
  // releases its own connection instead of resurrecting the server.
  private generation = 0
  private disposed = false
  private lastTransportError?: string

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

  /** True once the server was stopped on purpose (disabled, removed, reconfigured). */
  get isDisposed() {
    return this.disposed
  }

  private runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(operation)
    // Keep the queue chain alive regardless of operation failures.
    this.lifecycleQueue = result.catch(() => undefined)
    return result
  }

  private dedupe(key: string, factory: () => Promise<void>): Promise<void> {
    const existing = this.inflight.get(key)
    if (existing) {
      return existing
    }
    const promise = factory().finally(() => {
      if (this.inflight.get(key) === promise) {
        this.inflight.delete(key)
      }
    })
    this.inflight.set(key, promise)
    return promise
  }

  async start(): Promise<void> {
    if (this.disposed) {
      return
    }
    // Queued and deduplicated: several chats sending at once either join the
    // same attempt or wait for it, instead of one of them seeing a half-started
    // server and reporting it unavailable.
    return this.dedupe('start', () =>
      this.runSerialized(async () => {
        if (this.disposed || this.status.state !== 'idle') {
          return
        }
        await this.connectWithRetry()
      })
    )
  }

  /**
   * Drops any existing client and performs a fresh connection attempt whatever
   * the current status is. Used to recover servers that failed to start or
   * whose process died, e.g. right before sending a chat message.
   */
  async reconnect(): Promise<void> {
    if (this.disposed) {
      return
    }
    return this.dedupe('reconnect', () =>
      this.runSerialized(async () => {
        await this.reconnectLocked()
      })
    )
  }

  /** Reconnect body, for callers that already hold the lifecycle queue. */
  private async reconnectLocked(): Promise<void> {
    if (this.disposed) {
      return
    }
    await this.teardown()
    await this.connectWithRetry()
  }

  /**
   * Makes this server usable right now, with a bounded amount of work:
   *
   * - joins a start/reconnect another chat already has in flight,
   * - probes a connection that looks healthy and refreshes its tool list,
   * - reconnects (one retry per attempt) when the probe fails or nothing is
   *   connected.
   *
   * This is the per-user-message review: a stdio server whose process died
   * keeps reporting `running` unless the transport close event reached us, and
   * even then the cached tools stay stale. Probing catches both, and every step
   * is time-boxed so a wedged server can never block the message.
   *
   * Never throws; the outcome is reported through `status`.
   */
  async ensureReady(): Promise<void> {
    if (this.disposed) {
      return
    }
    return this.dedupe('ensure', () =>
      this.runSerialized(async () => {
        if (this.disposed) {
          return
        }
        if (this.status.state === 'running' && this.connection) {
          const generation = this.generation
          try {
            await this.refreshTools(HEALTH_CHECK_TIMEOUT_MS)
            return
          } catch (err) {
            // Ignore the failure when a teardown happened underneath the probe.
            if (generation === this.generation) {
              this.reportConnectionLost(err)
              // The queue is held here, so the dead client is dropped inline:
              // queueing it would let it run after the reconnect below and kill
              // the connection that reconnect just made.
              await this.teardown()
            }
          }
        }
        await this.reconnectLocked()
      })
    )
  }

  /**
   * Re-reads the tool list over the live connection. Doubles as the liveness
   * probe: a dead or wedged server fails here instead of failing later inside a
   * tool call, and the abort bound keeps it from waiting forever.
   */
  private async refreshTools(timeoutMs: number): Promise<void> {
    const connection = this.connection
    if (!connection) {
      throw new Error('Not connected')
    }
    const generation = this.generation
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const definitions = await connection.client.listTools({ options: { signal: controller.signal } })
      if (generation !== this.generation) {
        // A teardown happened while the probe was running; its result belongs to
        // a connection that no longer exists.
        return
      }
      // @ai-sdk/mcp can resolve a newer @ai-sdk/provider-utils patch than `ai`.
      // The returned tools share the same runtime schema contract, but TypeScript
      // treats the two package instances' schema symbols as distinct.
      this.tools = connection.client.toolsFromDefinitions(definitions) as unknown as ToolSet
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(`MCP server did not respond within ${Math.round(timeoutMs / 1000)}s`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  /** Publishes that the live connection is gone; the reason ends up in the UI. */
  private reportConnectionLost(err: unknown): void {
    if (this.disposed) {
      return
    }
    const reason = this.lastTransportError ?? errorMessage(err)
    console.warn('mcp: connection lost:', reason)
    this.status = { state: 'idle', error: reason }
  }

  /**
   * `reportConnectionLost` plus dropping the dead client, so the next user
   * message reconnects instead of reusing a zombie whose every tool call fails
   * with "Attempted to send a request from a closed client". For callers
   * outside the lifecycle queue (transport events, failed tool calls).
   */
  private markConnectionLost(err: unknown): void {
    if (this.disposed) {
      return
    }
    const generation = this.generation
    this.reportConnectionLost(err)
    void this.runSerialized(async () => {
      // Only drop the connection that was actually lost. This runs after
      // whatever currently holds the queue, which may already have reconnected:
      // tearing that fresh connection down would create a new zombie.
      if (generation === this.generation) {
        await this.teardown()
      }
    })
  }

  /**
   * Reports a tool call that failed mid-chat.
   *
   * When the failure means the connection is gone - rather than the tool itself
   * failing - the server stops reporting itself as running and drops the client,
   * so the next user message reconnects it instead of reusing a zombie. A
   * server that is not running is left alone, so an unrelated failure cannot
   * overwrite a connect that is in progress.
   */
  reportToolCallFailure(err: unknown): void {
    if (this.status.state !== 'running' || !isDeadConnectionError(err)) {
      return
    }
    this.markConnectionLost(err)
  }

  /**
   * Connection events of one specific attempt.
   *
   * The generation guard matters: `stop()`/`reconnect()` close the transport
   * themselves, and that close must not be mistaken for a lost connection -
   * it would queue a teardown that kills the connection created right after.
   */
  private createConnectionObserver(generation: number): TransportConnectionObserver {
    return {
      onClose: () => {
        if (this.disposed || generation !== this.generation) {
          return
        }
        this.markConnectionLost(new Error('Connection closed by the MCP server'))
      },
      onError: (error: Error) => {
        if (generation !== this.generation) {
          return
        }
        // Not fatal by itself (servers log to stderr), kept as the reason shown
        // when the connection does close.
        const message = errorMessage(error).trim()
        if (message) {
          this.lastTransportError = message.slice(-MAX_TRANSPORT_ERROR_LENGTH)
        }
      },
    }
  }

  private async connectWithRetry(): Promise<void> {
    let lastError = 'Unknown connection error'
    for (let attempt = 1; attempt <= CONNECT_MAX_ATTEMPTS; attempt += 1) {
      if (this.disposed) {
        return
      }
      this.status = { state: 'starting' }
      const generation = ++this.generation
      this.lastTransportError = undefined
      const timeoutMessage = `Connection attempt timed out after ${Math.round(CONNECT_ATTEMPT_TIMEOUT_MS / 1000)}s`
      try {
        const connection = await withTimeoutAndCleanup(
          createClient(this.transportConfig, this.createConnectionObserver(generation)),
          CONNECT_ATTEMPT_TIMEOUT_MS,
          timeoutMessage,
          closeConnection
        )
        if (this.disposed || generation !== this.generation) {
          // Stopped or superseded while the handshake was running: release the
          // connection right away instead of reading tools nobody will use.
          await closeConnection(connection)
          if (this.disposed) {
            return
          }
          // The connection was torn down underneath this attempt (the transport
          // closed during the handshake): retry from a clean slate instead of
          // leaving the status stuck at 'starting'.
          throw new Error('Connection was closed during startup')
        }
        let tools: ToolSet
        try {
          tools = (await withTimeout(
            Promise.resolve(connection.client.tools()),
            CONNECT_ATTEMPT_TIMEOUT_MS,
            timeoutMessage
          )) as unknown as ToolSet
        } catch (err) {
          // Never keep a connected client whose tools could not be read.
          await closeConnection(connection)
          throw err
        }
        if (this.disposed || generation !== this.generation) {
          await closeConnection(connection)
          if (this.disposed) {
            return
          }
          throw new Error('Connection was closed during startup')
        }
        this.connection = connection
        this.tools = tools
        this.status = { state: 'running' }
        return
      } catch (err) {
        lastError = errorMessage(err)
        console.error(`mcp:client:start attempt ${attempt}/${CONNECT_MAX_ATTEMPTS}`, err)
        if (!this.disposed && generation === this.generation) {
          this.status = { state: 'idle', error: lastError }
        }
      }
      if (attempt < CONNECT_MAX_ATTEMPTS && !this.disposed) {
        await delay(CONNECT_RETRY_DELAY_MS)
      }
    }
    if (!this.disposed && this.status.state !== 'idle') {
      this.status = { state: 'idle', error: lastError }
    }
  }

  private async teardown(): Promise<void> {
    this.generation += 1
    const connection = this.connection
    this.connection = undefined
    this.tools = undefined
    if (connection) {
      await closeConnection(connection)
    }
  }

  async stop(): Promise<void> {
    // Marked disposed even when nothing is connected: an attempt that is still
    // in flight must not resurrect the server afterwards, and releases its own
    // connection through the generation check in connectWithRetry().
    this.disposed = true
    const connection = this.connection
    if (!connection) {
      // Nothing to tear down. Deliberately not queued behind the lifecycle: a
      // connect attempt may still be running (a slow handshake must not make
      // disabling a server wait for it) - bumping the generation makes that
      // attempt release its own connection and stay quiet about the status.
      this.generation += 1
      if (this.status.state !== 'idle') {
        this.status = { state: 'idle' }
      }
      return
    }
    return this.runSerialized(async () => {
      if (!this.connection) {
        return
      }
      this.status = { state: 'stopping' }
      await this.teardown()
      this.status = { state: 'idle' }
    })
  }

  getAvailableTools(): ToolSet {
    if (!this.connection || this.status.state !== 'running') {
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
              // A tool call that fails because the connection died mid-chat is
              // reported to the model below, but the server must also stop
              // claiming to be healthy, otherwise it stays a zombie until the
              // app is restarted. The next user message reconnects it.
              instance.reportToolCallFailure(err)
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

/**
 * Recognises the errors @ai-sdk/mcp produces once its transport is gone, so a
 * failed tool call can flip the server back to "not connected" instead of
 * leaving it reported as running.
 */
function isDeadConnectionError(err: unknown): boolean {
  const message = errorMessage(err)
  return (
    message.includes('closed client') ||
    message.includes('Connection closed') ||
    message.includes('Not connected') ||
    (message.includes('Transport') && message.includes('not found'))
  )
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
