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

/**
 * Starts shared processes for any server in the chat's allow-list that is not
 * running yet. Idempotent; failures are logged and never throw.
 */
export function ensureSessionMcpServersRunning(sessionSettings?: SessionSettings): void {
  for (const id of getSessionMcpAllowList(sessionSettings)) {
    startMcpServerProcess(id)
  }
}

/**
 * Lazily starts the shared process backing `id` if it is not running yet.
 * Used when a chat enables a server: enabling only affects that chat's tool
 * list, while the process itself stays available to every chat.
 */
export function startMcpServerProcess(id: string): void {
  if (mcpController.getServer(id)) {
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

/** Tolerates partially initialized settings (e.g. early startup, tests). */
function readGlobalMcpSettings(): { servers: MCPServerConfig[]; enabledBuiltinServers: string[] } {
  const mcp = settingsStore.getState().getSettings()?.mcp
  return {
    servers: mcp?.servers ?? [],
    enabledBuiltinServers: mcp?.enabledBuiltinServers ?? [],
  }
}
