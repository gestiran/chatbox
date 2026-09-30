import type { SessionSettings } from '@shared/types'
import type { MCPServerConfig } from './types'
import { cloneDeep } from 'lodash'
import { settingsStore } from '@/stores/settingsStore'
import { getBuiltinServerConfig } from './builtin'
import { mcpController } from './controller'

/**
 * Per-chat MCP availability.
 *
 * A chat may pin its own server selection via `SessionSettings.enabledMcpServerIds`
 * / `enabledMcpBuiltinServerIds`. When those are undefined the chat follows the
 * globally enabled servers (settings.mcp). Server processes themselves remain
 * shared and are never stopped by per-chat toggles, so changing the selection of
 * one chat never interrupts a generation running in another chat.
 */

/** Effective allow-list of MCP server ids for a chat's tool building. */
export function getSessionMcpAllowList(sessionSettings?: SessionSettings): string[] {
  const globalMcp = readGlobalMcpSettings()
  const customIds =
    sessionSettings?.enabledMcpServerIds ??
    globalMcp.servers.filter((server) => server.enabled).map((server) => server.id)
  const builtinIds = sessionSettings?.enabledMcpBuiltinServerIds ?? [...globalMcp.enabledBuiltinServers]
  return [...customIds, ...builtinIds]
}

export interface UnavailableMcpServer {
  id: string
  name: string
  /** Last connection error reported by the server, when known. */
  reason?: string
}

/**
 * Lazily starts the shared process backing `id` if it is not running yet.
 * Used when a chat enables a server: enabling only affects that chat's tool
 * list, while the process itself stays available to every chat.
 */
export function startMcpServerProcess(id: string): void {
  const running = mcpController.getServer(id)
  if (running) {
    // Already managed: review the connection instead of assuming it is usable,
    // so re-enabling a server in one chat also revives it after a crash.
    running.ensureReady().catch((error) => {
      console.warn('mcp: failed to review server for chat:', id, error)
    })
    return
  }
  const globalMcp = readGlobalMcpSettings()
  const config = getBuiltinServerConfig(id) ?? globalMcp.servers.find((server) => server.id === id)
  if (!config) {
    return
  }
  // A globally disabled custom server can still be enabled per chat.
  const runnableConfig = config.enabled ? config : { ...cloneDeep(config), enabled: true }
  mcpController.startServer(runnableConfig).catch((error) => {
    console.warn('mcp: failed to start server for chat:', id, error)
  })
}

function resolveMcpServerConfig(id: string): MCPServerConfig | null {
  const globalMcp = readGlobalMcpSettings()
  return getBuiltinServerConfig(id) ?? globalMcp.servers.find((server) => server.id === id) ?? null
}

/**
 * Called right before message generation: makes sure every MCP server active
 * in this chat is reachable.
 *
 * - Servers unknown to the controller are started and awaited (instead of the
 *   usual fire-and-forget) so the outcome is known before the request goes out.
 * - Servers already registered are reviewed through `ensureReady()`: it joins a
 *   start another chat has in flight, probes a connection that still looks
 *   healthy (a stdio process can die without that being noticed) and
 *   reconnects with a bounded number of retries when it is missing or dead.
 *   Nothing here waits indefinitely: every step is time-boxed, and concurrent
 *   chats share one attempt per server instead of each spawning their own.
 *
 * Returns the servers that remained unavailable after the reconnect attempt so
 * the caller can abort the request with an actionable error.
 */
export async function ensureSessionMcpServersAvailable(
  sessionSettings?: SessionSettings
): Promise<UnavailableMcpServer[]> {
  const allowList = getSessionMcpAllowList(sessionSettings)
  const results = await Promise.all(
    allowList.map(async (id): Promise<UnavailableMcpServer | null> => {
      let instance = mcpController.getServer(id)
      if (instance) {
        await instance.ensureReady().catch((error) => {
          console.warn('mcp: reconnect failed for server:', id, error)
        })
      } else {
        const config = resolveMcpServerConfig(id)
        if (!config) {
          return null
        }
        // A globally disabled custom server can still be enabled per chat.
        const runnableConfig = config.enabled ? config : { ...cloneDeep(config), enabled: true }
        await mcpController.startServer(runnableConfig).catch((error) => {
          console.warn('mcp: failed to start server for chat:', id, error)
        })
        instance = mcpController.getServer(id)
      }
      if (instance?.status.state !== 'running') {
        const config = resolveMcpServerConfig(id)
        if (config) {
          return {
            id,
            name: config.name,
            ...(instance?.status.error ? { reason: instance.status.error } : {}),
          }
        }
      }
      return null
    })
  )
  return results.filter((entry): entry is UnavailableMcpServer => entry !== null)
}

/** Tolerates partially initialized settings (e.g. early startup, tests). */
function readGlobalMcpSettings(): { servers: MCPServerConfig[]; enabledBuiltinServers: string[] } {
  const mcp = settingsStore.getState().getSettings()?.mcp
  return {
    servers: mcp?.servers ?? [],
    enabledBuiltinServers: mcp?.enabledBuiltinServers ?? [],
  }
}
