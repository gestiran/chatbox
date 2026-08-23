import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo } from 'react'
import { SystemProviders } from '@shared/defaults'
import { sortProvidersForMenu } from '@/components/settings/provider/sortProviders'
import { useProviders } from '@/hooks/useProviders'
import { useIsSmallScreen } from '@/hooks/useScreenChange'
import useVersion from '@/hooks/useVersion'
import { useSettingsStore } from '@/stores/settingsStore'

export const Route = createFileRoute('/settings/provider/')({
  component: RouteComponent,
})

export function RouteComponent() {
  const isSmallScreen = useIsSmallScreen()
  const navigate = useNavigate()
  const customProviders = useSettingsStore((state) => state.customProviders)
  const { isExceeded } = useVersion()
  const { providers: availableProviders } = useProviders()

  // The first item displayed in the provider menu (Chatbox AI excluded)
  const firstVisibleProviderId = useMemo(() => {
    const systemProviders = SystemProviders().filter(
      (p) => !(isExceeded && p.name.toLocaleLowerCase().match(/openai|claude|gemini/i))
    )
    const activatedProviderIds = new Set(availableProviders.map((p) => p.id))
    const sorted = sortProvidersForMenu([...systemProviders, ...(customProviders || [])], activatedProviderIds)
    return sorted[0]?.id
  }, [isExceeded, customProviders, availableProviders])

  useEffect(() => {
    if (!isSmallScreen && firstVisibleProviderId) {
      navigate({
        to: '/settings/provider/$providerId',
        params: { providerId: firstVisibleProviderId },
        replace: true,
      })
    }
  }, [isSmallScreen, firstVisibleProviderId, navigate])

  return null
}
