import type { Message } from '@shared/types'
import i18n from '@/i18n'
import { getLogger } from '@/lib/utils'
import { router } from '@/router'
import * as chatStore from '../chatStore'
import { settingsStore } from '../settingsStore'
import { isSuccessfulAssistantReply } from './message-success'

const log = getLogger('chat-completion-notification')

/**
 * Show an OS-level notification announcing that a chat finished its work.
 *
 * The notification is named "Completed" and its body is the title of the
 * completed chat. Clicking it focuses the app and opens the chat.
 *
 * No-op when the user disabled `notifyOnChatCompletion` in Chat Settings,
 * when the reply did not complete successfully, or when the Notification API
 * is unavailable / permission was not granted.
 */
export async function notifyChatCompletion(sessionId: string, message: Message): Promise<void> {
  try {
    const settings = settingsStore.getState().getSettings()
    if (!settings.notifyOnChatCompletion) return
    if (!isSuccessfulAssistantReply(message)) return
    if (typeof Notification === 'undefined') return

    // Electron grants notification permission by default; browsers may still
    // need an explicit request before the first notification can be shown.
    let permission = Notification.permission
    if (permission === 'default') {
      permission = await Notification.requestPermission()
    }
    if (permission !== 'granted') return

    const session = await chatStore.getSession(sessionId)
    const chatTitle = session?.name.trim()
    if (!chatTitle) return

    const notification = new Notification(i18n.t('Completed'), { body: chatTitle })
    notification.onclick = () => {
      window.focus()
      router.navigate({
        to: '/session/$sessionId',
        params: { sessionId },
      })
    }
  } catch (error) {
    log.error('Failed to show chat completion notification:', error)
  }
}
