import { z } from 'zod'
import { AgentModeEntrySchema } from './settings'

/**
 * Web search provider values available for a project.
 * Mirrors `WEB_SEARCH_PROVIDERS` in renderer/packages/web-search/constants.ts
 * (kept as a plain union here so shared code stays renderer-agnostic).
 */
export const ProjectWebSearchProviderSchema = z.enum(['build-in', 'bing', 'tavily', 'bocha', 'querit'])
export type ProjectWebSearchProvider = z.infer<typeof ProjectWebSearchProviderSchema>

/**
 * Starting parameters inherited by chats created inside a project.
 * Each field overrides the corresponding user default at chat-creation time;
 * omitted fields keep following the user's global settings.
 */
export const ProjectSettingsSchema = z.object({
  // AI model selection (same list as the input-box model selector)
  provider: z.string().optional().catch(undefined),
  modelId: z.string().optional().catch(undefined),
  // Overrides the user's standard System Prompt for chats created in this project
  systemPrompt: z.string().optional().catch(undefined),
  // Chat Mode ('off') or Work Mode ('on'); 'auto' keeps smart switching enabled
  agentMode: AgentModeEntrySchema.optional().catch(undefined),
  // Active MCP utilities (custom server ids / builtin server ids)
  mcpServerIds: z.array(z.string()).optional().catch(undefined),
  mcpBuiltinServerIds: z.array(z.string()).optional().catch(undefined),
  // Work Mode request filtering inherited by new project chats
  mcpFullAccess: z.boolean().optional().catch(undefined),
  // Active Knowledge Base documentation
  knowledgeBaseId: z.number().nullable().optional().catch(undefined),
  knowledgeBaseName: z.string().optional().catch(undefined),
  // Active skills
  skillNames: z.array(z.string()).optional().catch(undefined),
  // Web search type + on/off state for new project chats
  webSearchProvider: ProjectWebSearchProviderSchema.optional().catch(undefined),
  webBrowsingEnabled: z.boolean().optional().catch(undefined),
  // Working directories granted to the agent sandbox for new project chats
  workingDirectories: z.array(z.string()).optional().catch(undefined),
  // Remote access (Telegram bot) inherited by new chats created in this project.
  // Default false; persists with the project between sessions.
  remoteEnabled: z.boolean().optional().catch(undefined),
})

export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>

export const ProjectSchema = z.object({
  /** Stable unique id so projects with identical names can coexist. */
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  sortOrder: z.number(),
  settings: ProjectSettingsSchema.catch({}),
})

export type Project = z.infer<typeof ProjectSchema>
