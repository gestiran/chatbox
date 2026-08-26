import type { Message } from '@shared/types'
import i18n from '@/i18n'
import { getLogger } from '@/lib/utils'
import * as chatStore from '@/stores/chatStore'
import { loadProjects, projectStore } from '@/stores/projectStore'
import { isSuccessfulAssistantReply } from '@/stores/session/message-success'
import { settingsStore } from '@/stores/settingsStore'
import { sendTelegramMessage } from './bridge'
import { formatCompletionNotification } from './format'
import { bindSession, forgetSessionBinding, getSessionBinding } from './registry'

const log = getLogger('remote-control-completion')

/**
 * Sends the localized "work finished / interrupted" notification for a chat
 * with Remote access enabled. The message contains the project name, the chat
 * name and an inline button that reads back the last request (user message +
 * AI answer). No-op when the chat is not remote-enabled or was never addressed
 * through the bot.
 *
 * Called from the generation orchestration `finally` block, so it also fires
 * when the reply ended in an error (interruption).
 */
export async function notifyRemoteCompletion(sessionId: string, finalMessage: Message): Promise<void> {
  try {
    const remote = settingsStore.getState().remote
    if (!remote.enabled) return

    const session = await chatStore.getSession(sessionId)
    if (!session) return
    if (session.settings?.remoteEnabled !== true) return

    const chatId = await getSessionBinding(sessionId)
    if (!chatId) return

    const projectName = session.projectId
      ? ((await loadProjects()).find((project) => project.id === session.projectId)?.name ?? undefined)
      : undefined

    const success = isSuccessfulAssistantReply(finalMessage)
    const text = formatCompletionNotification({
      success,
      projectName,
      sessionName: session.name,
      error: finalMessage.error,
    })

    const result = await sendTelegramMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: i18n.t('Read last request'),
              callback_data: `read:${sessionId}`,
            },
          ],
        ],
      },
    })

    // "chat not found" means the bound Telegram conversation is gone (bot
    // blocked, chat deleted): drop the stale binding so future completions do
    // not keep failing silently.
    if (!result.ok && result.error?.includes('chat not found')) {
      await forgetSessionBinding(sessionId)
    }
  } catch (error) {
    log.error('Failed to send remote completion notification:', error)
  }
}

/** Re-binding helper used right after a remote command touched a chat. */
export async function rememberRemoteTarget(sessionId: string, telegramChatId: string): Promise<void> {
  await bindSession(sessionId, telegramChatId)
}
