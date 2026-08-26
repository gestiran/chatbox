/**
 * Remote control via Telegram Bot (optional, desktop only).
 *
 * Public surface:
 * - initRemoteControl()          app-startup wiring (see setup/remote_control_init.ts)
 * - notifyRemoteCompletion()     generation hook for completion notifications
 * - isUserAuthorized()           authorization check reused by the settings UI
 * - bridge / registry helpers    Settings → Remote Access page
 */
export { applyBotConfig, testBotToken } from './bridge'
export { isRemoteBridgeAvailable } from './bridge'
export { handleTelegramUpdate, isUserAuthorized } from './commands'
export { notifyRemoteCompletion } from './completion'
export {
  dismissPendingUser,
  remoteUiStore,
  setBotUsername,
  type RemotePendingUser,
} from './registry'
export { initRemoteControl } from './controller'
