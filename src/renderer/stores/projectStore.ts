import type { Project, ProjectSettings, Session } from '@shared/types'
import { v4 as uuidv4 } from 'uuid'
import { createStore, useStore } from 'zustand'
import i18n from '@/i18n'
import storage from '@/storage'
import { sortSessionRecords } from '@/storage/SessionMetaStorage'
import { router } from '@/router'
import * as chatStore from '@/stores/chatStore'
import { resolveChatboxLicenseDefaultModel } from '@/stores/defaultChatModel'
import { lastUsedModelStore } from '@/stores/lastUsedModelStore'
import { initEmptyChatSession } from '@/stores/sessionHelpers'
import { switchCurrentSession } from '@/stores/sessionActions'
import { settingsStore } from '@/stores/settingsStore'
import { uiStore } from '@/stores/uiStore'

const STORAGE_KEY = 'projects'
const EXPANDED_PROJECTS_STORAGE_KEY = 'projects-foldout-states'

interface ProjectStoreState {
  projects: Project[]
  /** Explicit foldout states; a project is expanded unless recorded as collapsed here. */
  expandedProjectIds: Record<string, boolean>
}

export const projectStore = createStore<ProjectStoreState>(() => ({
  projects: [],
  expandedProjectIds: {},
}))

export function useProjects(): Project[] {
  return useStore(projectStore, (state) => state.projects)
}

export function useExpandedProjectIds(): Record<string, boolean> {
  return useStore(projectStore, (state) => state.expandedProjectIds)
}

export function isProjectExpanded(state: ProjectStoreState, projectId: string): boolean {
  return state.expandedProjectIds[projectId] !== false
}

export function useProjectExpanded(projectId: string): boolean {
  return useStore(projectStore, (state) => isProjectExpanded(state, projectId))
}

function setProjects(projects: Project[]) {
  projectStore.setState({ projects })
}

async function persistProjects(projects: Project[]) {
  await storage.setItem(STORAGE_KEY, projects)
}

/** Loads persisted projects into the store. Safe to call multiple times. */
export async function loadProjects(): Promise<Project[]> {
  const stored = await storage.getItem<Project[]>(STORAGE_KEY, [])
  const projects = Array.isArray(stored) ? stored : []
  setProjects(projects.sort((a, b) => b.sortOrder - a.sortOrder))
  // Restore the persisted foldout open/closed states so the sidebar looks the
  // same after an app restart.
  const expanded = await storage.getItem<Record<string, boolean>>(EXPANDED_PROJECTS_STORAGE_KEY, {})
  projectStore.setState({
    expandedProjectIds: expanded && typeof expanded === 'object' ? expanded : {},
  })
  return projectStore.getState().projects
}

/**
 * Builds starting parameters from the user's current defaults. Used when the
 * "New Project" button creates a project that is then fine-tuned in the editor.
 */
function buildDefaultProjectSettings(): ProjectSettings {
  const settings = settingsStore.getState()
  const { chat: lastUsedChatModel } = lastUsedModelStore.getState()
  const defaultChatModel =
    settings.defaultChatModel
      ? { provider: settings.defaultChatModel.provider, modelId: settings.defaultChatModel.model }
      : lastUsedChatModel || resolveChatboxLicenseDefaultModel(settings)

  return {
    ...(defaultChatModel ? { provider: defaultChatModel.provider, modelId: defaultChatModel.modelId } : {}),
    systemPrompt: '',
    agentMode: {
      value: settings.defaultChatType === 'work' ? 'on' : 'off',
      locked: false,
      lockReason: null,
    },
    mcpServerIds: settings.mcp.servers.filter((server) => server.enabled).map((server) => server.id),
    mcpBuiltinServerIds: [...settings.mcp.enabledBuiltinServers],
    knowledgeBaseId: null,
    skillNames: [...settings.skills.enabledSkillNames],
    webSearchProvider: settings.extension.webSearch.provider,
    webBrowsingEnabled: false,
    remoteEnabled: false,
    workingDirectories: [],
  }
}

/** Creates a project with the user's base parameters and opens nothing by itself. */
export async function createProject(): Promise<Project> {
  const projects = projectStore.getState().projects
  const maxSortOrder = projects.reduce((max, project) => Math.max(max, project.sortOrder), Date.now() - 1000)
  const project: Project = {
    id: uuidv4(),
    name: i18n.t('New Project'),
    createdAt: Date.now(),
    sortOrder: maxSortOrder + 1000,
    settings: buildDefaultProjectSettings(),
  }
  const next = [project, ...projects]
  setProjects(next)
  await persistProjects(next)
  return project
}

export async function updateProject(id: string, updates: Partial<Omit<Project, 'id'>>): Promise<Project | null> {
  const projects = projectStore.getState().projects
  const index = projects.findIndex((project) => project.id === id)
  if (index < 0) return null
  const updated: Project = { ...projects[index], ...updates, id }
  const next = [...projects]
  next[index] = updated
  setProjects(next)
  await persistProjects(next)
  return updated
}

export async function setProjectExpanded(projectId: string, expanded: boolean) {
  const next = { ...projectStore.getState().expandedProjectIds, [projectId]: expanded }
  projectStore.setState({ expandedProjectIds: next })
  // storage.setItem debounces writes internally, so rapid toggling is fine.
  await storage.setItem(EXPANDED_PROJECTS_STORAGE_KEY, next).catch((error) => {
    console.warn('Failed to persist project foldout state:', error)
  })
}

/** Removes the stored foldout state of a deleted project. */
async function forgetProjectFoldoutState(projectId: string) {
  const { expandedProjectIds } = projectStore.getState()
  if (!(projectId in expandedProjectIds)) return
  const next = { ...expandedProjectIds }
  delete next[projectId]
  projectStore.setState({ expandedProjectIds: next })
  await storage.setItem(EXPANDED_PROJECTS_STORAGE_KEY, next)
}

/** Reorders projects with fractional indexing (newest-first ordering like sessions). */
export async function reorderProjects(activeId: string, overId: string): Promise<void> {
  const projects = [...projectStore.getState().projects].sort((a, b) => b.sortOrder - a.sortOrder)
  const oldIndex = projects.findIndex((project) => project.id === activeId)
  const newIndex = projects.findIndex((project) => project.id === overId)
  if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return

  const reordered = [...projects]
  const [moved] = reordered.splice(oldIndex, 1)
  reordered.splice(newIndex, 0, moved)

  const before = reordered[newIndex - 1]
  const after = reordered[newIndex + 1]
  let newSortOrder: number
  if (!before && !after) {
    newSortOrder = moved.sortOrder
  } else if (!before) {
    newSortOrder = after!.sortOrder + 1000
  } else if (!after) {
    newSortOrder = before.sortOrder - 1000
  } else {
    newSortOrder = (before.sortOrder + after.sortOrder) / 2
  }

  await updateProject(moved.id, { sortOrder: newSortOrder })
}

/**
 * Moves a chat into a project (or out to the root list when projectId is null),
 * optionally placing it next to `beforeId` within the destination scope.
 */
export async function moveSessionIntoProject(
  sessionId: string,
  projectId: string | null,
  beforeId?: string
): Promise<void> {
  const allSessions = await chatStore.listSessionsMeta()
  const siblings = allSessions.filter((session) => (session.projectId ?? null) === projectId && session.id !== sessionId)
  const target = beforeId ? siblings.find((session) => session.id === beforeId) : undefined

  let sortOrder: number
  if (target) {
    const targetIndex = siblings.findIndex((session) => session.id === beforeId)
    const prev = siblings[targetIndex - 1]
    const next = siblings[targetIndex + 1]
    if (!prev && !next) {
      sortOrder = target.sortOrder + 1
    } else if (!prev) {
      sortOrder = next ? (target.sortOrder + next.sortOrder) / 2 : target.sortOrder + 1
    } else if (!next) {
      sortOrder = (prev.sortOrder + target.sortOrder) / 2
    } else {
      sortOrder = (prev.sortOrder + target.sortOrder) / 2
    }
  } else {
    const maxSortOrder = siblings.reduce((max, session) => Math.max(max, session.sortOrder), 0)
    sortOrder = maxSortOrder > 0 ? maxSortOrder + 1000 : Date.now()
  }

  // Persist projectId on the full session record; updateSession propagates the new
  // metadata into the meta storage and the cached session list via getSessionMeta().
  await chatStore.updateSession(sessionId, { projectId: projectId ?? undefined })
  const metaStorage = await chatStore.getMetaStorage()
  await metaStorage.update(sessionId, { projectId: projectId ?? undefined, sortOrder })
  chatStore.updateSessionListData((items) =>
    sortSessionRecords(
      items.map((s) => (s.id === sessionId ? { ...s, projectId: projectId ?? undefined, sortOrder } : s))
    )
  )
}

/** Reorders two chats that live in the same scope (both root chats or both in one project). */
export async function reorderSessionsInScope(activeId: string, overId: string): Promise<void> {
  const allSessions = await chatStore.listSessionsMeta()
  const active = allSessions.find((session) => session.id === activeId)
  const over = allSessions.find((session) => session.id === overId)
  if (!active || !over) return
  if ((active.projectId ?? null) !== (over.projectId ?? null)) return

  const scope = allSessions
    .filter((session) => (session.projectId ?? null) === (active.projectId ?? null))
    .sort((a, b) => b.sortOrder - a.sortOrder)
  const oldIndex = scope.findIndex((session) => session.id === activeId)
  const newIndex = scope.findIndex((session) => session.id === overId)
  if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return

  const reordered = [...scope]
  const [moved] = reordered.splice(oldIndex, 1)
  reordered.splice(newIndex, 0, moved)

  const before = reordered[newIndex - 1]
  const after = reordered[newIndex + 1]
  let newSortOrder: number
  if (!before && !after) {
    newSortOrder = moved.sortOrder
  } else if (!before) {
    newSortOrder = after!.sortOrder + 1000
  } else if (!after) {
    newSortOrder = before.sortOrder - 1000
  } else {
    newSortOrder = (before.sortOrder + after.sortOrder) / 2
  }

  const starredChanged = Boolean(moved.starred) !== Boolean(over.starred)
  const nextStarred = starredChanged ? over.starred : moved.starred
  if (nextStarred !== moved.starred) {
    await chatStore.updateSession(moved.id, { starred: nextStarred })
  }

  const metaStorage = await chatStore.getMetaStorage()
  await metaStorage.update(moved.id, { sortOrder: newSortOrder, starred: nextStarred })
  chatStore.updateSessionListData((items) =>
    sortSessionRecords(items.map((s) => (s.id === moved.id ? { ...s, sortOrder: newSortOrder, starred: nextStarred } : s)))
  )
}

/** Deletes a project together with every chat nested in it. */
export async function deleteProjectWithChats(projectId: string): Promise<void> {
  const sessions = await chatStore.listAllSessionsMeta()
  const nested = sessions.filter((session) => session.projectId === projectId)
  for (const session of nested) {
    try {
      await chatStore.deleteSession(session.id)
    } catch (error) {
      console.warn('Failed to delete chat while removing project:', session.id, error)
    }
  }
  const projects = projectStore.getState().projects.filter((project) => project.id !== projectId)
  setProjects(projects)
  await persistProjects(projects)
  await forgetProjectFoldoutState(projectId)

  // If the open chat belonged to the deleted project, fall back to the home page.
  const pathname = router.state.location.pathname
  const match = pathname.match(/^\/session\/([^/]+)/)
  if (match && nested.some((session) => session.id === match[1])) {
    router.navigate({ to: '/', replace: true })
  }
}

/**
 * Applies the global-side parts of a project's starting parameters (MCP utils,
 * skills, web-search provider) so a chat created "now" runs with them. MCP is
 * intentionally NOT applied globally anymore: the project's selection is baked
 * into the new chat's own settings (see initEmptyChatSession), keeping chats
 * independent from each other and from the global defaults.
 */
function applyGlobalProjectSettings(project: Project) {
  const { setSettings } = settingsStore.getState()
  const projectSettings = project.settings

  if (projectSettings.skillNames) {
    const skillNames = [...projectSettings.skillNames]
    setSettings((draft) => {
      draft.skills.enabledSkillNames = skillNames
    })
  }
  if (projectSettings.webSearchProvider) {
    const provider = projectSettings.webSearchProvider
    setSettings((draft) => {
      draft.extension.webSearch.provider = provider
    })
  }
}

/**
 * Creates a new chat inside the project. The chat inherits the project's
 * starting parameters instead of the user's standard settings at creation time.
 */
export async function createProjectChat(project: Project): Promise<Session | null> {
  applyGlobalProjectSettings(project)

  const newSession = await chatStore.createSession(initEmptyChatSession(project))

  const ui = uiStore.getState()
  if (project.settings.knowledgeBaseId != null) {
    ui.addSessionKnowledgeBase(newSession.id, {
      id: project.settings.knowledgeBaseId,
      name: project.settings.knowledgeBaseName ?? '',
    })
  }
  if (project.settings.webBrowsingEnabled !== undefined) {
    ui.setSessionWebBrowsing(newSession.id, project.settings.webBrowsingEnabled)
  }

  switchCurrentSession(newSession.id)
  return newSession
}
