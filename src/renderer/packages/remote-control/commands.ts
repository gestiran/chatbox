import { createMessage, type Project, type Session, type TelegramUpdate } from '@shared/types'
import i18n from '@/i18n'
import { getLogger } from '@/lib/utils'
import * as chatStore from '@/stores/chatStore'
import { loadProjects, projectStore } from '@/stores/projectStore'
import { submitNewUserMessage } from '@/stores/sessionActions'
import { initEmptyChatSession } from '@/stores/sessionHelpers'
import { settingsStore } from '@/stores/settingsStore'
import {
  answerCallbackQuery,
  isRemoteBridgeAvailable,
  sendTelegramMessage,
} from './bridge'
import { formatLastRequest } from './format'
import {
  bindSession,
  notePendingUser,
} from './registry'

const log = getLogger('remote-control')

/** Telegram conversations never see anything but this when access is denied. */
function noAccessText(): string {
  return i18n.t('No access.')
}

type ReplyFn = (text: string) => Promise<void>

interface RemoteContext {
  /** Telegram chat the command came from (reply target). */
  chatId: string
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

export function isUserAuthorized(userId: string): boolean {
  const allowed = settingsStore.getState().remote.allowedUsers ?? []
  return allowed.some((user) => user.id === userId)
}

function displayName(user: { first_name?: string; last_name?: string; username?: string }): string | undefined {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim()
  return name || user.username
}

/**
 * Every incoming update funnels through here. Unknown accounts are recorded as
 * pending authorization requests for the Settings page and answered with the
 * localized "No access." message.
 */
async function requireAuthorization(
  context: RemoteContext,
  user: { id: number; first_name?: string; last_name?: string; username?: string },
  reply: ReplyFn
): Promise<boolean> {
  const senderId = String(user.id)
  if (isUserAuthorized(senderId)) {
    return true
  }
  notePendingUser({
    id: senderId,
    name: displayName(user),
    username: user.username,
  })
  await reply(noAccessText())
  return false
}

// ---------------------------------------------------------------------------
// Listings (only chats / projects with Remote access enabled are visible)
// ---------------------------------------------------------------------------

async function listRemoteChats(): Promise<Session[]> {
  const metas = await chatStore.listSessionsMeta()
  const entries: Session[] = []
  for (const meta of metas) {
    try {
      const session = await chatStore.getSession(meta.id)
      if (!session) continue
      if (session.type !== 'chat' && session.type !== undefined) continue
      if (session.settings?.remoteEnabled !== true) continue
      entries.push(session)
    } catch (error) {
      log.warn('Failed to load session while listing remote chats:', meta.id, error)
    }
  }
  return entries
}

async function listRemoteProjects(): Promise<Project[]> {
  // loadProjects is safe to call repeatedly and guarantees a fresh store even
  // when the sidebar has not been opened yet in this app run.
  await loadProjects()
  return projectStore.getState().projects.filter((project) => project.settings?.remoteEnabled === true)
}

function projectNameById(projectId?: string): string | undefined {
  if (!projectId) return undefined
  return projectStore.getState().projects.find((project) => project.id === projectId)?.name
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function helpText(): string {
  const t = i18n.t.bind(i18n)
  return [
    t('/chats – list chats with remote access'),
    t('/msg <number> <text> – send a message to a chat'),
    t('/projects – list projects with remote access'),
    t('/new <number> <name> – create a chat in a project'),
    t('/last <number> – read the last request in a chat'),
    t('/id – show your Telegram ID'),
  ].join('\n')
}

function parseCommandNumber(rest: string): { index?: number; tail: string } {
  const match = rest.match(/^\s*(\d+)(?::|\.)?\s*([\s\S]*)$/)
  if (!match) {
    return { tail: rest }
  }
  return { index: Number.parseInt(match[1], 10), tail: match[2] ?? '' }
}

async function handleChats(context: RemoteContext, reply: ReplyFn) {
  const t = i18n.t.bind(i18n)
  const chats = await listRemoteChats()
  if (chats.length === 0) {
    await reply(t('No chats with remote access.'))
    return
  }
  const lines = chats.map((session, index) => {
    const project = projectNameById(session.projectId)
    const suffix = project ? ` · ${project}` : ''
    return `${index + 1}. ${session.name}${suffix}`
  })
  await reply([t('Chats with remote access:'), ...lines].join('\n'))
}

async function handleProjects(_context: RemoteContext, reply: ReplyFn) {
  const t = i18n.t.bind(i18n)
  const projects = await listRemoteProjects()
  if (projects.length === 0) {
    await reply(t('No projects with remote access.'))
    return
  }
  const lines = projects.map((project, index) => `${index + 1}. ${project.name}`)
  await reply([t('Projects with remote access:'), ...lines].join('\n'))
}

async function handleMessageToChat(context: RemoteContext, rest: string, reply: ReplyFn) {
  const t = i18n.t.bind(i18n)
  const { index, tail } = parseCommandNumber(rest)
  const text = tail.trim()
  // Missing/unknown/out-of-range numbers all answer with the same "no access"
  // message required for non-remote chats.
  if (!index || !text) {
    await reply(noAccessText())
    return
  }
  const chats = await listRemoteChats()
  const entry = chats[index - 1]
  if (!entry) {
    await reply(noAccessText())
    return
  }

  const sessionId = entry.id
  await bindSession(sessionId, context.chatId)

  const newUserMsg = createMessage('user', text)
  await submitNewUserMessage(sessionId, { newUserMsg, needGenerating: true })
  await reply(t('Message sent to "{{name}}".', { name: entry.name }))
}

async function handleCreateChat(context: RemoteContext, rest: string, reply: ReplyFn) {
  const t = i18n.t.bind(i18n)
  const { index, tail } = parseCommandNumber(rest)
  if (!index) {
    await reply(noAccessText())
    return
  }
  const projects = await listRemoteProjects()
  const project = projects[index - 1]
  if (!project) {
    await reply(noAccessText())
    return
  }

  const name = tail.trim()
  const created = await chatStore.createSession(initEmptyChatSession(project))
  if (name) {
    await chatStore.updateSession(created.id, { name })
  }
  await bindSession(created.id, context.chatId)
  await reply(t('Created chat "{{name}}".', { name: name || created.name }))
}

async function handleLastRequest(_context: RemoteContext, rest: string, reply: ReplyFn) {
  const t = i18n.t.bind(i18n)
  const { index } = parseCommandNumber(rest)
  if (!index) {
    await reply(noAccessText())
    return
  }
  const chats = await listRemoteChats()
  const entry = chats[index - 1]
  if (!entry) {
    await reply(noAccessText())
    return
  }
  const text = formatLastRequest(entry)
  if (!text) {
    await reply(t('No messages yet.'))
    return
  }
  await reply(text)
}

async function handleCallbackQueryData(context: RemoteContext, data: string, reply: ReplyFn) {
  const prefix = 'read:'
  if (!data.startsWith(prefix)) {
    await reply(noAccessText())
    return
  }
  const sessionId = data.slice(prefix.length)
  const session = sessionId ? await chatStore.getSession(sessionId) : null
  if (!session || session.settings?.remoteEnabled !== true) {
    await reply(noAccessText())
    return
  }
  await bindSession(sessionId, context.chatId)
  const text = formatLastRequest(session) ?? noAccessText()
  await reply(text)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function dispatchAuthorizedUpdate(update: TelegramUpdate, reply: ReplyFn) {
  const t = i18n.t.bind(i18n)
  const message = update.message
  const callback = update.callback_query

  if (callback) {
    const context: RemoteContext = { chatId: String(callback.message?.chat.id ?? '') }
    void answerCallbackQuery(callback.id)
    if (!(await requireAuthorization(context, callback.from, reply))) return
    if (callback.data) {
      await handleCallbackQueryData(context, callback.data, reply)
    }
    return
  }

  if (!message) return
  const context: RemoteContext = { chatId: String(message.chat.id) }
  const from = message.from
  if (!from) return
  if (!(await requireAuthorization(context, from, reply))) return

  const text = (message.text ?? '').trim()
  if (!text.startsWith('/')) {
    // Plain text without a command: nudge towards /help.
    await reply(`${t('Unknown command. Send /help for the list of commands.')}\n\n${helpText()}`)
    return
  }

  const [rawCommand] = text.split(/\s+/)
  const command = rawCommand.split('@')[0].toLowerCase() // strip /cmd@BotName
  const rest = text.slice(rawCommand.length)

  switch (command) {
    case '/start':
    case '/help':
      await reply(helpText())
      break
    case '/id':
      await reply(t('Your Telegram ID: {{id}}', { id: String(from.id) }))
      break
    case '/chats':
      await handleChats(context, reply)
      break
    case '/projects':
      await handleProjects(context, reply)
      break
    case '/msg':
      await handleMessageToChat(context, rest, reply)
      break
    case '/new':
      await handleCreateChat(context, rest, reply)
      break
    case '/last':
      await handleLastRequest(context, rest, reply)
      break
    default:
      await reply(`${t('Unknown command. Send /help for the list of commands.')}\n\n${helpText()}`)
  }
}

/** Handles one raw update coming from the main-process bot client. */
export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  if (!isRemoteBridgeAvailable()) return

  const settings = settingsStore.getState().remote
  if (!settings.enabled) return

  const telegramChatId =
    update.message?.chat.id !== undefined
      ? String(update.message.chat.id)
      : update.callback_query?.message?.chat.id !== undefined
        ? String(update.callback_query.message.chat.id)
        : null
  if (!telegramChatId) return

  const reply: ReplyFn = async (text) => {
    const result = await sendTelegramMessage(telegramChatId, text)
    if (!result.ok && result.error && result.error !== 'bot-not-running') {
      log.warn(`Failed to deliver bot reply to ${telegramChatId}:`, result.error)
    }
  }

  try {
    await dispatchAuthorizedUpdate(update, reply)
  } catch (error) {
    log.error('Failed to handle remote update:', error)
    try {
      await reply(noAccessText())
    } catch {
      /* ignore secondary failures */
    }
  }
}
