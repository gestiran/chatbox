import { getMessageText } from '@shared/utils/message'
import type { Message, Session } from '@shared/types'
import i18n from '@/i18n'
import { getToolName } from '@/packages/tools'

/**
 * Short tool-call label for bot output.
 *
 * Mirrors the format shown in the desktop chat window (`getToolName`):
 * MCP utils render as "MCP · <Server Name> (<tool>)", built-in tools keep
 * their translated name ("Terminal", "Web Search", ...).
 */
export function formatToolCallLabel(toolName: string): string {
  const display = getToolName(toolName)
  return display
}

export function isMcpToolCall(toolName: string): boolean {
  return toolName.startsWith('mcp__')
}

const MAX_TEXT_LENGTH = 1800
const MAX_TOTAL_LENGTH = 3800
const MAX_TOOL_LINES = 20

export function truncate(text: string, maxLength = MAX_TEXT_LENGTH): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxLength) return trimmed
  return `${trimmed.slice(0, maxLength)}…`
}

function collectToolLines(messages: Message[]): string[] {
  const lines: string[] = []
  for (const message of messages) {
    for (const part of message.contentParts ?? []) {
      if (part.type !== 'tool-call') continue
      const label = isMcpToolCall(part.toolName)
        ? `MCP · ${getToolName(part.toolName)}`
        : getToolName(part.toolName)
      lines.push(`🔧 ${label}`)
      if (lines.length >= MAX_TOOL_LINES) {
        return lines
      }
    }
  }
  return lines
}

/** All messages reachable from the current conversation plus saved threads. */
function getAllMessages(session: Session): Message[] {
  let messages: Message[] = []
  if (session.threads) {
    for (const thread of session.threads) {
      messages = messages.concat(thread.messages)
    }
  }
  if (session.messages) {
    messages = messages.concat(session.messages)
  }
  return messages
}

/**
 * Formats the last request of a chat: the latest user message followed by the
 * AI answer, with every tool/MCP call that happened in between listed in the
 * same short form the desktop chat window uses. Returns null when the chat is
 * missing or has no user messages yet — callers reply "No access" instead.
 */
export function formatLastRequest(session: Session): string | null {
  const t = i18n.t.bind(i18n)
  const messages = getAllMessages(session)

  let lastUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      lastUserIndex = index
      break
    }
  }
  if (lastUserIndex < 0) {
    return null
  }

  const userMessage = messages[lastUserIndex]
  const after = messages.slice(lastUserIndex + 1)
  const assistantMessages = after.filter((message) => message.role === 'assistant')

  const sections: string[] = [
    `💬 ${t('Chat')}: ${session.name}`,
    `👤 ${truncate(getMessageText(userMessage, false)) || t('No messages yet.')}`,
  ]

  const toolLines = collectToolLines(after)
  if (toolLines.length > 0) {
    sections.push(...toolLines)
  }

  const answerText = assistantMessages.map((message) => getMessageText(message, true)).join('\n').trim()
  sections.push(`🤖 ${answerText ? truncate(answerText) : t('No messages yet.')}`)

  return sections.join('\n')
}

/** Completion / interruption notification body (project + chat names included). */
export function formatCompletionNotification(options: {
  success: boolean
  projectName?: string
  sessionName: string
  error?: string
}): string {
  const t = i18n.t.bind(i18n)
  const header = options.success ? `✅ ${t('Task completed')}` : `❌ ${t('Task failed')}`
  const lines = [header, `${t('Project')}: ${options.projectName ?? '—'}`, `${t('Chat')}: ${options.sessionName}`]
  if (!options.success && options.error) {
    lines.push(`${t('Error')}: ${truncate(options.error, 300)}`)
  }
  return lines.join('\n')
}
