import { Box, Flex, Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core'
import { TestId } from '@shared/automation/testids'
import { IconCheck } from '@tabler/icons-react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { zodValidator } from '@tanstack/zod-adapter'
import { type FC, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { BuiltinServersSection } from '@/components/settings/mcp/BuiltinServersSection'
import CustomServersSection from '@/components/settings/mcp/CustomServersSection'
import { parseServerFromJson } from '@/components/settings/mcp/utils'
import type { MCPServerConfig } from '@/packages/mcp/types'
import { useSettingsStore } from '@/stores/settingsStore'
import { decodeBase64 } from '@/utils/base64'

const searchSchema = z.object({
  install: z.string().optional(), // b64 encoded config
})

export const Route = createFileRoute('/settings/mcp')({
  component: RouteComponent,
  validateSearch: zodValidator(searchSchema),
})

export function RouteComponent() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const searchParams = Route.useSearch()
  const [installConfig, setInstallConfig] = useState<MCPServerConfig | undefined>(undefined)

  // Handle install parameter from search params
  useEffect(() => {
    if (searchParams.install) {
      try {
        const config = parseServerFromJson(decodeBase64(searchParams.install))
        setInstallConfig(config)
      } catch (err) {
        console.error(err)
      }
      // Clear search params immediately after reading
      navigate({
        to: '/settings/mcp',
        search: {},
        replace: true,
      })
    }
  }, [searchParams.install, navigate])

  return (
    <Box p="md">
      <Title order={5}>{t('MCP Settings')}</Title>
      <Box className="mt-8">
        <DefaultFilteringSection />
      </Box>
      <Box className="mt-8">
        <BuiltinServersSection />
      </Box>
      <Box className="mt-8">
        <CustomServersSection installConfig={installConfig} />
      </Box>
    </Box>
  )
}

type FilteringValue = 'approve' | 'full-access'

const FilterOptionCard: FC<{
  title: string
  titleColor?: string
  description: string
  descriptionColor?: string
  selected: boolean
  onSelect: () => void
}> = ({ title, titleColor, description, descriptionColor, selected, onSelect }) => (
  <Paper
    component="button"
    type="button"
    shadow="xs"
    radius="lg"
    withBorder
    p="sm"
    style={{ borderColor: selected ? 'var(--chatbox-tint-brand)' : undefined }}
    className="w-full cursor-pointer text-left"
    onClick={onSelect}
  >
    <Flex justify="space-between" align="center" gap="xs">
      <Text size="sm" fw={600} c={titleColor}>
        {title}
      </Text>
      {selected && <IconCheck size={14} color="var(--chatbox-tint-brand)" />}
    </Flex>
    <Text size="xs" mt="sm" c={descriptionColor ?? 'chatbox-tertiary'}>
      {description}
    </Text>
  </Paper>
)

function DefaultFilteringSection() {
  const { t } = useTranslation()
  const defaultFiltering = useSettingsStore((s) => s.mcp.defaultFiltering)
  const setSettings = useSettingsStore((s) => s.setSettings)

  const options: Array<{
    value: FilteringValue
    label: string
    labelColor?: string
    description: string
    descriptionColor?: string
  }> = [
    {
      value: 'approve',
      label: t('Approve'),
      description: t('Ask before running commands or changing files.'),
    },
    {
      value: 'full-access',
      label: t('Full Access'),
      labelColor: 'red',
      description: t('Skip approval prompts for commands and file changes.'),
      descriptionColor: 'red',
    },
  ]

  return (
    <Stack gap="xxs" data-testid={TestId.settings.mcpDefaultFilteringSelector}>
      <Text size="sm" fw={600} mb={4}>
        {t('Default Request Filtering')}
      </Text>
      <Text size="xs" c="chatbox-tertiary" mb={8}>
        {t('Applied to new chats. Individual chats can override this in Work Mode settings.')}
      </Text>
      <SimpleGrid type="container" cols={{ base: 1, '450px': 2 }} spacing="sm">
        {options.map((option) => (
          <FilterOptionCard
            key={option.value}
            title={option.label}
            titleColor={option.labelColor}
            description={option.description}
            descriptionColor={option.descriptionColor}
            selected={defaultFiltering === option.value}
            onSelect={() =>
              setSettings((draft) => {
                draft.mcp.defaultFiltering = option.value
              })
            }
          />
        ))}
      </SimpleGrid>
    </Stack>
  )
}
