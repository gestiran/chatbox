import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it, vi } from 'vitest'
import { observeTransportConnection } from './transport-observer'

function makeTransport() {
  const sent: JSONRPCMessage[] = []
  const transport: Transport = {
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,
    start: vi.fn(async () => {}),
    send: vi.fn(async (message: JSONRPCMessage) => {
      sent.push(message)
    }),
    close: vi.fn(async () => {}),
  }
  return { transport, sent }
}

describe('observeTransportConnection', () => {
  it('sees the close event that @ai-sdk/mcp overwrites the handler of', () => {
    const { transport } = makeTransport()
    const observer = { onClose: vi.fn(), onError: vi.fn() }
    observeTransportConnection(transport, observer)

    // This is what the client does in its constructor; without the accessors the
    // close event below would be invisible to us and the server would stay a
    // zombie reported as running.
    const clientOnclose = vi.fn()
    const clientOnerror = vi.fn()
    transport.onclose = clientOnclose
    transport.onerror = clientOnerror

    transport.onclose?.()

    expect(observer.onClose).toHaveBeenCalledTimes(1)
    expect(clientOnclose).toHaveBeenCalledTimes(1)
  })

  it('forwards transport errors without treating them as a close', () => {
    const { transport } = makeTransport()
    const observer = { onClose: vi.fn(), onError: vi.fn() }
    observeTransportConnection(transport, observer)

    const clientOnerror = vi.fn()
    transport.onerror = clientOnerror

    const error = new Error('write EPIPE')
    transport.onerror?.(error)

    expect(observer.onError).toHaveBeenCalledWith(error)
    expect(clientOnerror).toHaveBeenCalledWith(error)
    expect(observer.onClose).not.toHaveBeenCalled()
  })

  it('reports the close only once', () => {
    const { transport } = makeTransport()
    const observer = { onClose: vi.fn(), onError: vi.fn() }
    observeTransportConnection(transport, observer)
    transport.onclose = vi.fn()

    transport.onclose?.()
    transport.onclose?.()

    expect(observer.onClose).toHaveBeenCalledTimes(1)
  })

  it('leaves the rest of the transport untouched', async () => {
    const { transport, sent } = makeTransport()
    observeTransportConnection(transport, { onClose: vi.fn(), onError: vi.fn() })

    const message: JSONRPCMessage = { jsonrpc: '2.0', method: 'ping' }
    await transport.start()
    await transport.send(message)
    await transport.close()

    expect(transport.start).toHaveBeenCalledTimes(1)
    expect(transport.close).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([message])
  })
})
