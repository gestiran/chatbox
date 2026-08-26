import { settingsStore } from '@/stores/settingsStore'
import { getLogger } from '@/lib/utils'
import { applyBotConfig, isRemoteBridgeAvailable, subscribeTelegramStatus, subscribeTelegramUpdates } from './bridge'
import { handleTelegramUpdate } from './commands'
import { setRemoteStatus } from './registry'

const log = getLogger('remote-control')

let initialized = false

/**
 * Starts the Remote control feature (desktop only):
 * - mirrors the current `settings.remote` section into the main-process bot
 *   client and keeps it in sync on every settings change,
 * - routes raw bot updates into the command handler,
 * - mirrors polling status into the UI store for the Settings page.
 *
 * All bot replies are composed here in the renderer with i18n, so the feature
 * follows the app language automatically.
 */
export function initRemoteControl(): void {
  if (initialized || !isRemoteBridgeAvailable()) return
  initialized = true

  subscribeTelegramStatus((payload) => {
    setRemoteStatus(payload.status, payload.error)
  })

  subscribeTelegramUpdates((update) => {
    void handleTelegramUpdate(update).catch((error) => {
      log.error('Unhandled remote control update error:', error)
    })
  })

  const applyFromSettings = () => {
    const remote = settingsStore.getState().remote
    void applyBotConfig({
      enabled: Boolean(remote.enabled),
      botToken: remote.botToken?.trim() || undefined,
    })
  }

  applyFromSettings()
  // Re-apply whenever the Remote settings section changes (toggle, token edit).
  settingsStore.subscribe(
    (state) => state.remote,
    () => applyFromSettings()
  )
}
