import { settingsStore } from '@/stores/settingsStore'
import { BUILTIN_MCP_SERVERS } from './builtin'

// Tool keys for MCP tools are built by `normalizeToolName` in `./controller.ts`:
// `mcp__<server>__<tool>` where <server> is the configured name lower-cased with
// whitespace collapsed to `_`, or just `mcp__<tool>` when the configured name
// contains characters outside [A-Za-z0-9_-]. The helpers below reverse that
// mapping so the UI can show the server name exactly as configured in Settings → MCP.
const MCP_TOOL_PREFIX = 'mcp__'

export type ParsedMcpToolName = {
  /** Server name as configured in Settings → MCP, when it could be resolved. */
  serverName?: string
  /** Tool name without the `mcp__<server>__` prefix. */
  toolName: string
}

function normalizeServerSegment(serverName: string): string {
  return serverName.replace(/\s+/g, '_').toLowerCase()
}

/** All server names known to Settings → MCP: user-configured ones plus built-ins. */
function getConfiguredServerNames(): string[] {
  const names: string[] = []
  for (const server of settingsStore.getState().mcp.servers) {
    if (server.name) {
      names.push(server.name)
    }
  }
  for (const builtin of BUILTIN_MCP_SERVERS) {
    names.push(builtin.name)
  }
  return names
}

export function parseMcpToolName(
  rawToolName: string,
  serverNames: string[] = getConfiguredServerNames()
): ParsedMcpToolName | null {
  if (!rawToolName.startsWith(MCP_TOOL_PREFIX)) {
    return null
  }
  const remainder = rawToolName.slice(MCP_TOOL_PREFIX.length)
  // Match against configured servers first and prefer the longest match, so one
  // name being a prefix of another ("arxiv" vs "arxiv2") resolves unambiguously.
  let bestMatch: ParsedMcpToolName | undefined
  for (const serverName of serverNames) {
    const segment = normalizeServerSegment(serverName)
    if (!segment || !remainder.startsWith(`${segment}__`)) {
      continue
    }
    const candidate: ParsedMcpToolName = { serverName, toolName: remainder.slice(segment.length + 2) }
    if (!bestMatch || candidate.toolName.length < bestMatch.toolName.length) {
      bestMatch = candidate
    }
  }
  if (bestMatch) {
    return bestMatch
  }
  const separatorIndex = remainder.indexOf('__')
  if (separatorIndex !== -1) {
    // The server is no longer in Settings (renamed/removed): keep its encoded segment.
    return { serverName: remainder.slice(0, separatorIndex), toolName: remainder.slice(separatorIndex + 2) }
  }
  // No server segment was encoded in the key; only the tool name survives.
  return { toolName: remainder }
}

/** UI title of an MCP tool call: "<Server Name> (<tool>)". Returns null for non-MCP tools. */
export function getMcpToolTitle(rawToolName: string): string | null {
  const parsed = parseMcpToolName(rawToolName)
  if (!parsed) {
    return null
  }
  return parsed.serverName ? `${parsed.serverName} (${parsed.toolName})` : parsed.toolName
}
