import type { ElectronIPC } from '@shared/electron-types'
import type {
  RemoteApplyConfigPayload,
  RemoteSendResult,
  RemoteStatusPayload,
  RemoteTestTokenResult,
  TelegramSendMessageOptions,
  TelegramUpdate,
} from '@shared/types'
import platform from '@/platform'
import { getLogger } from '@/lib/utils'

const log = getLogger('remote-control-bridge')

/**
 * The bot client lives in the Electron main process, so the whole feature is
 * desktop-only. Everything else (authorization, commands, replies) happens in
 * the renderer through this thin bridge.
 */
export function isRemoteBridgeAvailable(): boolean {
  return platform.type === 'desktop' && !!platform.ipc
}

function requireIpc(): ElectronIPC {
  const ipc = platform.ipc
  if (!ipc) {
    throw new Error('remote-control-unavailable')
  }
  return ipc
}

export async function applyBotConfig(payload: RemoteApplyConfigPayload): Promise<void> {
  if (!isRemoteBridgeAvailable()) return
  try {
    await requireIpc().invoke('remote-telegram:apply-config', payload)
  } catch (error) {
    log.error('Failed to apply bot config:', error)
  }
}

export async function testBotToken(token: string): Promise<RemoteTestTokenResult | null> {
  if (!isRemoteBridgeAvailable()) return null
  try {
    return (await requireIpc().invoke('remote-telegram:test', token)) as RemoteTestTokenResult
  } catch (error) {
    log.error('Failed to test bot token:', error)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function sendTelegramMessage(
  chatId: string | number,
  text: string,
  options?: TelegramSendMessageOptions
): Promise<RemoteSendResult> {
  if (!isRemoteBridgeAvailable()) {
    return { ok: false, error: 'remote-control-unavailable' }
  }
  try {
    return (await requireIpc().invoke('remote-telegram:send-message', {
      chatId,
      text,
      options,
    })) as RemoteSendResult
  } catch (error) {
    log.error('Failed to send telegram message:', error)
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function answerCallbackQuery(callbackQueryId: string): Promise<void> {
  if (!isRemoteBridgeAvailable()) return
  try {
    await requireIpc().invoke('remote-telegram:answer-callback', callbackQueryId)
  } catch (error) {
    log.warn('Failed to answer callback query:', error)
  }
}

export function subscribeTelegramUpdates(callback: (update: TelegramUpdate) => void): () => void {
  if (!isRemoteBridgeAvailable()) return () => {}
  return requireIpc().onRemoteTelegramUpdate((update: unknown) => callback(update as TelegramUpdate))
}

export function subscribeTelegramStatus(callback: (status: RemoteStatusPayload) => void): () => void {
  if (!isRemoteBridgeAvailable()) return () => {}
  return requireIpc().onRemoteTelegramStatus((status: unknown) => callback(status as RemoteStatusPayload))
}
