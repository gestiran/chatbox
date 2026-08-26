// Remote control (Telegram bot) — main-process side.
//
// Implements a minimal Telegram Bot API client (long polling, no external
// dependencies) and exposes IPC handlers used by the renderer:
//
//   renderer -> main : 'remote-telegram:apply-config'  start/stop polling
//                      'remote-telegram:test'           validate a token (getMe)
//                      'remote-telegram:send-message'   deliver a composed reply
//   main -> renderer : 'remote-telegram:update'         raw bot updates
//                      'remote-telegram:status'         polling status changes
//
// The main process is intentionally "dumb": it only transports updates and
// sends texts that the renderer composed (with i18n). Authorization, command
// handling and all user-visible strings live in the renderer.

import { BrowserWindow, ipcMain } from 'electron'
import https from 'node:https'
import log from 'electron-log/main'
import type {
  RemoteApplyConfigPayload,
  RemoteSendResult,
  RemoteStatusPayload,
  RemoteTestTokenResult,
  RemoteTelegramStatus,
  RemoteTelegramUpdate,
} from '../shared/types/remote'

const TELEGRAM_API_HOST = 'api.telegram.org'
const LONG_POLL_TIMEOUT_SECONDS = 50
const REQUEST_TIMEOUT_MS = 65 * 1000
const RETRY_DELAY_MS = 5000

type GetWindow = () => BrowserWindow | null

let currentToken: string | null = null
let pollingActive = false
/** Incremented on every config change; stale loops observe it and exit. */
let pollGeneration = 0
let lastUpdateId = 0
let currentStatus: RemoteTelegramStatus = 'stopped'

function postToWindow(getWindow: GetWindow, channel: string, payload: unknown) {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send(channel, payload)
}

function setStatus(getWindow: GetWindow, status: RemoteTelegramStatus, error?: string) {
  if (currentStatus === status && !error) return
  currentStatus = status
  const payload: RemoteStatusPayload = { status, error }
  log.info(`[remote-telegram] status: ${status}${error ? ` (${error})` : ''}`)
  postToWindow(getWindow, 'remote-telegram:status', payload)
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/**
 * Single JSON call against the Telegram Bot API. Resolves with `result` when
 * `ok` is true, rejects with the API description otherwise.
 */
export function telegramApiCall<T>(
  token: string,
  method: string,
  payload?: Record<string, unknown>,
  timeoutMs = 30000
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const body = payload ? Buffer.from(JSON.stringify(payload), 'utf8') : undefined
    const req = https.request(
      {
        host: TELEGRAM_API_HOST,
        path: `/bot${token}/${method}`,
        method: 'POST',
        headers: body
          ? {
              'content-type': 'application/json',
              'content-length': body.length,
            }
          : undefined,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (data && data.ok) {
              resolve(data.result as T)
            } else {
              reject(new Error(String(data?.description ?? 'Telegram API error')))
            }
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('Telegram API request timed out')))
    req.on('error', reject)
    if (body) {
      req.write(body)
    }
    req.end()
  })
}

async function pollLoop(getWindow: GetWindow, generation: number) {
  while (pollingActive && generation === pollGeneration && currentToken) {
    const token = currentToken
    try {
      const updates = await telegramApiCall<RemoteTelegramUpdate[]>(
        token,
        'getUpdates',
        {
          offset: lastUpdateId > 0 ? lastUpdateId : undefined,
          timeout: LONG_POLL_TIMEOUT_SECONDS,
          allowed_updates: ['message', 'callback_query'],
        },
        REQUEST_TIMEOUT_MS
      )
      if (!pollingActive || generation !== pollGeneration) break
      for (const update of updates ?? []) {
        lastUpdateId = Math.max(lastUpdateId, update.update_id + 1)
        postToWindow(getWindow, 'remote-telegram:update', update)
      }
      setStatus(getWindow, 'polling')
    } catch (error) {
      if (!pollingActive || generation !== pollGeneration) break
      const message = error instanceof Error ? error.message : String(error)
      setStatus(getWindow, 'error', message)
      // 404/401 mean the token is wrong — keep retrying slowly so a fixed
      // token in Settings reconnects without an app restart.
      await delay(RETRY_DELAY_MS)
    }
  }
}

function stopPolling() {
  pollingActive = false
  pollGeneration += 1
}

function startPolling(getWindow: GetWindow, token: string) {
  stopPolling()
  currentToken = token
  lastUpdateId = 0
  pollingActive = true
  const generation = ++pollGeneration
  setStatus(getWindow, 'starting')
  void pollLoop(getWindow, generation)
}

/** Registers all Remote control IPC handlers. Call once from main.ts. */
export function registerRemoteTelegramHandlers(getWindow: GetWindow) {
  ipcMain.handle('remote-telegram:apply-config', (_event, config: RemoteApplyConfigPayload) => {
    try {
      const enabled = Boolean(config?.enabled) && typeof config?.botToken === 'string' && config.botToken.trim() !== ''
      if (enabled && config.botToken) {
        startPolling(getWindow, config.botToken.trim())
      } else {
        stopPolling()
        currentToken = null
        setStatus(getWindow, 'stopped')
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('remote-telegram:test', async (_event, token: string): Promise<RemoteTestTokenResult> => {
    try {
      const me = await telegramApiCall<{ username?: string; first_name?: string }>(token, 'getMe')
      return { ok: true, username: me.username ?? me.first_name }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle(
    'remote-telegram:send-message',
    async (
      _event,
      params: { chatId: string | number; text: string; options?: { reply_markup?: unknown } }
    ): Promise<RemoteSendResult> => {
      if (!currentToken || !pollingActive) {
        return { ok: false, error: 'bot-not-running' }
      }
      try {
        await telegramApiCall(currentToken, 'sendMessage', {
          chat_id: params.chatId,
          text: params.text,
          disable_web_page_preview: true,
          ...(params.options?.reply_markup ? { reply_markup: params.options.reply_markup } : {}),
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  // Acknowledge inline-keyboard presses so Telegram clears the "loading" state.
  ipcMain.handle('remote-telegram:answer-callback', async (_event, callbackQueryId: string) => {
    if (!currentToken || !pollingActive || !callbackQueryId) {
      return { ok: false, error: 'bot-not-running' }
    }
    try {
      await telegramApiCall(currentToken, 'answerCallbackQuery', { callback_query_id: callbackQueryId })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
