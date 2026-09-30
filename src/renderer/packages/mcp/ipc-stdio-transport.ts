// 由于stdio transport只能在main进程使用，这里实现一个代理transport，通过ipc控制main进程中的stdio transport

import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

export class IPCStdioTransport implements Transport {
  static async create(serverParams: StdioServerParameters) {
    const ipcTransportId = await window.electronAPI.invoke('mcp:stdio-transport:create', serverParams)
    return new IPCStdioTransport(ipcTransportId)
  }

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  private readonly listenerDisposers: Array<() => void> = []
  private closed = false

  constructor(private readonly ipcTransportId: string) {
    this.addListener('onclose', (stderrMessage: string) => {
      if (stderrMessage) {
        this.onerror?.(new Error(stderrMessage))
      }
      this.onclose?.()
      // The main process dropped its handle: nothing more can arrive for this
      // transport id, so stop holding the renderer side listeners open.
      this.disposeListeners()
    })
    this.addListener('onerror', (error: Error) => {
      this.onerror?.(error)
    })
    this.addListener('onmessage', (message: JSONRPCMessage) => {
      this.onmessage?.(message)
    })
  }

  private addListener<T extends unknown[]>(event: string, callback: (...args: T) => void) {
    const dispose = window.electronAPI.addMcpStdioTransportEventListener(this.ipcTransportId, event, callback)
    if (typeof dispose === 'function') {
      this.listenerDisposers.push(dispose)
    }
  }

  private disposeListeners() {
    while (this.listenerDisposers.length > 0) {
      const dispose = this.listenerDisposers.pop()
      try {
        dispose?.()
      } catch (err) {
        console.warn('mcp:stdio-transport:dispose listener', err)
      }
    }
  }

  async start(): Promise<void> {
    await window.electronAPI.invoke('mcp:stdio-transport:start', this.ipcTransportId)
  }

  async send(message: JSONRPCMessage): Promise<void> {
    await window.electronAPI.invoke('mcp:stdio-transport:send', this.ipcTransportId, message)
  }

  /**
   * Releases the main process handle unconditionally and is safe to call more
   * than once.
   *
   * A plain `close()` is not enough: @ai-sdk/mcp skips it once the client
   * considers itself closed (which the transport close event already did), and
   * the main process removes the handle as soon as the child exits, so a second
   * call would only produce a "Transport not found" error. Either way the
   * renderer side listeners and the spawned process must not survive.
   */
  async forceClose(): Promise<void> {
    if (this.closed) {
      this.disposeListeners()
      return
    }
    this.closed = true
    try {
      await window.electronAPI.invoke('mcp:stdio-transport:close', this.ipcTransportId)
    } catch (err) {
      // Already gone from the main process (the child exited on its own).
      console.warn('mcp:stdio-transport:close', err)
    } finally {
      this.disposeListeners()
    }
  }

  async close(): Promise<void> {
    await this.forceClose()
  }
}
