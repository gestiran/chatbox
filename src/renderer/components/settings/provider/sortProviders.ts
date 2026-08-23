import { ModelProviderEnum, type ProviderBaseInfo } from '@shared/types'
import { FEATURED_PROVIDER_IDS } from './providerIcons'

/**
 * Sorts providers for the Settings -> Model Provider menu:
 * activated/custom providers first, then featured presets.
 * Chatbox AI is never shown in the menu.
 */
export function sortProvidersForMenu(
  providers: ProviderBaseInfo[],
  activatedProviderIds: Set<string>
): ProviderBaseInfo[] {
  const activated: ProviderBaseInfo[] = []
  const featured: ProviderBaseInfo[] = []

  for (const p of providers) {
    if (p.id === ModelProviderEnum.ChatboxAI) continue

    if (activatedProviderIds.has(p.id) || p.isCustom) {
      activated.push(p)
    } else if (FEATURED_PROVIDER_IDS.includes(p.id)) {
      featured.push(p)
    }
  }

  return [...activated, ...featured]
}
