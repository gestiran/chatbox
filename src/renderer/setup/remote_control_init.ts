import { getLogger } from '@/lib/utils'
import { initRemoteControl } from '@/packages/remote-control'

const log = getLogger('remote-control-init')

/**
 * Desktop-only startup wiring for the optional Telegram Remote control.
 * Failures must never block app startup.
 */
export function initRemoteControlSafe(): void {
  try {
    initRemoteControl()
  } catch (error) {
    log.error('Failed to initialize remote control:', error)
  }
}
