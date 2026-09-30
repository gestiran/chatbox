import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

export interface TransportConnectionObserver {
  /**
   * The peer closed the connection (the stdio child exited, the HTTP/SSE
   * stream ended). The client is unusable from this moment on.
   */
  onClose: () => void
  /**
   * A transport level error. Not fatal on its own - servers routinely log to
   * stderr - so it is only recorded as context for a later `onClose`.
   */
  onError: (error: Error) => void
}

/**
 * Makes a transport's connection lifecycle observable from the outside.
 *
 * `@ai-sdk/mcp` overwrites `transport.onclose` / `transport.onerror` in its
 * constructor and keeps the resulting "closed" flag private
 * (`DefaultMCPClient.isClosed`). Without this hook a dead server is invisible:
 * the client keeps reporting itself as connected while every request fails
 * with "Attempted to send a request from a closed client", so the server stays
 * a zombie until the app is restarted.
 *
 * The handlers are installed as accessors on the transport instance itself, so
 * the object keeps its identity and every other member (`send`, `close`,
 * `setProtocolVersion`, ...) still reaches the real transport. The observer is
 * notified before the client's own handler runs, which means the reported
 * status is already up to date when pending requests get rejected.
 */
export function observeTransportConnection<T extends Transport>(
  transport: T,
  observer: TransportConnectionObserver
): T {
  let sdkOnclose: (() => void) | undefined
  let sdkOnerror: ((error: Error) => void) | undefined
  let closeReported = false

  Object.defineProperty(transport, 'onclose', {
    configurable: true,
    enumerable: true,
    get() {
      const handler = sdkOnclose
      if (!handler) {
        return undefined
      }
      return () => {
        if (!closeReported) {
          closeReported = true
          observer.onClose()
        }
        handler()
      }
    },
    set(handler?: () => void) {
      sdkOnclose = handler
    },
  })

  Object.defineProperty(transport, 'onerror', {
    configurable: true,
    enumerable: true,
    get() {
      const handler = sdkOnerror
      if (!handler) {
        return undefined
      }
      return (error: Error) => {
        observer.onError(error)
        handler(error)
      }
    },
    set(handler?: (error: Error) => void) {
      sdkOnerror = handler
    },
  })

  return transport
}
