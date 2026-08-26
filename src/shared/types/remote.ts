import { z } from 'zod'

/**
 * Telegram Bot API payloads used by the optional Remote control feature.
 *
 * The bot client lives in the Electron main process (long polling against
 * api.telegram.org); every bot reply is composed in the renderer with i18n so
 * the whole feature stays localized. These shared interfaces are the contract
 * between both processes.
 */

export interface TelegramUser {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}

export interface TelegramChat {
  id: number
  type: string
  title?: string
  first_name?: string
  last_name?: string
  username?: string
}

export interface TelegramMessage {
  message_id: number
  from?: TelegramUser
  chat: TelegramChat
  date: number
  text?: string
}

export interface TelegramCallbackQuery {
  id: string
  from: TelegramUser
  data?: string
  message?: TelegramMessage
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

export interface TelegramInlineKeyboardButton {
  text: string
  callback_data?: string
}

export interface TelegramSendMessageOptions {
  reply_markup?: {
    inline_keyboard: TelegramInlineKeyboardButton[][]
  }
}

/** Connection state of the main-process polling loop, mirrored to the UI. */
export type RemoteTelegramStatus = 'stopped' | 'starting' | 'polling' | 'error'

export const RemoteTelegramUserSchema = z.object({
  /** Telegram numeric user id, kept as a string for stable storage keys. */
  id: z.string(),
  name: z.string().optional().catch(undefined),
  addedAt: z.number().optional().catch(undefined),
})
export type RemoteTelegramUser = z.infer<typeof RemoteTelegramUserSchema>

/**
 * Settings → Remote Access section (analogous to `mcp` / `skills`).
 * The token is only read by the main-process bot client; all bot commands are
 * answered exclusively by users listed in `allowedUsers`.
 */
export const RemoteSettingsSchema = z.object({
  // Master switch (Settings / Remote Access). When off no polling happens.
  enabled: z.boolean().default(false).catch(false),
  // Token issued by @BotFather.
  botToken: z.string().optional().catch(''),
  // Telegram accounts allowed to talk to the bot; everyone else gets "No access".
  allowedUsers: z.array(RemoteTelegramUserSchema).default([]).catch([]),
})

export type RemoteSettings = z.infer<typeof RemoteSettingsSchema>

/** Payloads exchanged over IPC between renderer and the main-process bot. */
export interface RemoteApplyConfigPayload {
  enabled: boolean
  botToken?: string
}

export interface RemoteTestTokenResult {
  ok: boolean
  username?: string
  error?: string
}

export interface RemoteSendResult {
  ok: boolean
  error?: string
}

export interface RemoteStatusPayload {
  status: RemoteTelegramStatus
  error?: string
}
