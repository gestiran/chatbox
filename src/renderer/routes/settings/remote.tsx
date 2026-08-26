import { ActionIcon, Badge, Box, Button, Flex, Input, Paper, Stack, Switch, Text, Title } from '@mantine/core'
import { IconCheck, IconInfoCircle, IconTrash } from '@tabler/icons-react'
import { createFileRoute } from '@tanstack/react-router'
import { type FC, type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from 'zustand'
import { ScalableIcon } from '@/components/common/ScalableIcon'
import { TestId } from '@shared/automation/testids'
import {
  dismissPendingUser,
  isRemoteBridgeAvailable,
  remoteUiStore,
  setBotUsername,
  testBotToken,
} from '@/packages/remote-control'
import { settingsStore, useSettingsStore } from '@/stores/settingsStore'

export const Route = createFileRoute('/settings/remote')({
  component: RouteComponent,
})

function useRemoteUiStore<U>(selector: (state: ReturnType<typeof remoteUiStore.getState>) => U): U {
  return useStore(remoteUiStore, selector)
}

export function RouteComponent() {
  const { t } = useTranslation()

  // The bot client runs in the Electron main process — nothing to configure on
  // other platforms.
  if (!isRemoteBridgeAvailable()) {
    return (
      <Box p="md">
        <Title order={5}>{t('Remote Access')}</Title>
        <Text size="sm" c="chatbox-tertiary" mt="sm">
          {t('Remote Access is available in the desktop app only.')}
        </Text>
      </Box>
    )
  }

  return (
    <Box p="md">
      <Title order={5}>{t('Remote Access')}</Title>
      <Text size="xs" c="chatbox-tertiary" mt={4}>
        {t(
          'Control your chats remotely through a Telegram bot. The bot only answers accounts you explicitly approve.'
        )}
      </Text>
      <Box className="mt-8">
        <MasterSwitchSection />
      </Box>
      <Box className="mt-8">
        <BotTokenSection />
      </Box>
      <Box className="mt-8">
        <PendingUsersSection />
      </Box>
      <Box className="mt-8">
        <AllowedUsersSection />
      </Box>
    </Box>
  )
}

function MasterSwitchSection() {
  const { t } = useTranslation()
  const enabled = useSettingsStore((s) => s.remote.enabled)
  const token = useSettingsStore((s) => s.remote.botToken)
  const status = useRemoteUiStore((s) => s.status)
  const statusError = useRemoteUiStore((s) => s.statusError)
  const setSettings = useSettingsStore((s) => s.setSettings)

  const hasToken = Boolean(token && token.trim())

  return (
    <Stack gap="xs">
      <Flex align="center" justify="space-between">
        <Text size="sm" fw={600}>
          {t('Enable Remote Access')}
        </Text>
        <Switch
          data-testid={TestId.settings.remoteAccessEnableSwitch}
          checked={enabled}
          disabled={!hasToken}
          onChange={(event) =>
            setSettings((draft) => {
              draft.remote.enabled = event.currentTarget.checked
            })
          }
        />
      </Flex>
      <Text size="xs" c={status === 'error' ? 'red' : 'chatbox-tertiary'}>
        {!hasToken
          ? t('Add a bot token first.')
          : status === 'polling'
            ? t('Bot is running and listening for messages.')
            : status === 'error'
              ? `${t('Bot connection error. Check the token and your network connection.')}${statusError ? ` (${statusError})` : ''}`
              : t('Bot is not running.')}
      </Text>
    </Stack>
  )
}

function BotTokenSection() {
  const { t } = useTranslation()
  const token = useSettingsStore((s) => s.remote.botToken)
  const botUsername = useRemoteUiStore((s) => s.botUsername)

  const [draftToken, setDraftToken] = useState(token ?? '')
  const [checking, setChecking] = useState(false)
  const [testError, setTestError] = useState<string | undefined>(undefined)

  const saveAndCheck = async () => {
    const trimmed = draftToken.trim()
    if (!trimmed) return
    setChecking(true)
    setTestError(undefined)
    const result = await testBotToken(trimmed)
    setChecking(false)
    if (result?.ok) {
      setBotUsername(result.username)
      settingsStore.getState().setSettings((draft) => {
        draft.remote.botToken = trimmed
      })
    } else {
      setBotUsername(undefined)
      setTestError(result?.error || t('Connection failed'))
    }
  }

  return (
    <Stack gap="xs">
      <Text size="sm" fw={600}>
        {t('Bot Token')}
      </Text>
      <Text size="xs" c="chatbox-tertiary">
        {t('Create a bot with @BotFather on Telegram and paste its token here.')}
      </Text>
      <Flex gap="xs" align="center">
        <Input
          style={{ flex: 1 }}
          type="password"
          placeholder="123456:ABC-DEF..."
          value={draftToken}
          onChange={(event) => setDraftToken(event.target.value)}
          classNames={{ input: '!text-chatbox-tint-primary' }}
        />
        <Button variant="light" loading={checking} disabled={!draftToken.trim()} onClick={() => void saveAndCheck()}>
          {t('Check Connection')}
        </Button>
      </Flex>
      {botUsername ? (
        <Flex gap={4} align="center">
          <IconCheck size={14} color="var(--chatbox-tint-brand)" />
          <Text size="xs" c="chatbox-brand">
            {t('Connected as @{{name}}', { name: botUsername })}
          </Text>
        </Flex>
      ) : testError ? (
        <Text size="xs" c="red">
          {testError}
        </Text>
      ) : null}
    </Stack>
  )
}

const UserCard: FC<{
  title: string
  subtitle?: string
  action: ReactNode
}> = ({ title, subtitle, action }) => (
  <Paper withBorder radius="md" px="sm" py="xs">
    <Flex justify="space-between" align="center" gap="xs">
      <Box className="min-w-0">
        <Text size="sm" truncate>
          {title}
        </Text>
        {subtitle && (
          <Text size="xs" c="chatbox-tertiary" truncate>
            {subtitle}
          </Text>
        )}
      </Box>
      {action}
    </Flex>
  </Paper>
)

function PendingUsersSection() {
  const { t } = useTranslation()
  const pendingUsers = useRemoteUiStore((s) => s.pendingUsers)

  if (pendingUsers.length === 0) {
    return null
  }

  const allow = (userId: string) => {
    const pending = pendingUsers.find((user) => user.id === userId)
    if (!pending) return
    settingsStore.getState().setSettings((draft) => {
      draft.remote.allowedUsers = [
        ...(draft.remote.allowedUsers ?? []).filter((user) => user.id !== userId),
        { id: userId, name: pending.name ?? pending.username, addedAt: Date.now() },
      ]
    })
    dismissPendingUser(userId)
  }

  return (
    <Stack gap="xs">
      <Flex align="center" gap="xs">
        <Text size="sm" fw={600}>
          {t('Pending Authorization Requests')}
        </Text>
        <Badge color="orange" size="xs">
          {pendingUsers.length}
        </Badge>
      </Flex>
      {pendingUsers.map((user) => (
        <UserCard
          key={user.id}
          title={user.name ?? user.username ?? user.id}
          subtitle={`${t('User ID')}: ${user.id}`}
          action={
            <Flex gap={4}>
              <Button size="compact-xs" variant="light" onClick={() => allow(user.id)}>
                {t('Allow')}
              </Button>
              <ActionIcon
                variant="subtle"
                color="red"
                aria-label={t('Deny')}
                onClick={() => dismissPendingUser(user.id)}
              >
                <IconTrash size={14} />
              </ActionIcon>
            </Flex>
          }
        />
      ))}
    </Stack>
  )
}

function AllowedUsersSection() {
  const { t } = useTranslation()
  const allowedUsers = useSettingsStore((s) => s.remote.allowedUsers) ?? []
  const setSettings = useSettingsStore((s) => s.setSettings)

  const [userIdInput, setUserIdInput] = useState('')
  const [userNameInput, setUserNameInput] = useState('')

  const addUser = () => {
    const id = userIdInput.trim()
    if (!id || allowedUsers.some((user) => user.id === id)) return
    setSettings((draft) => {
      draft.remote.allowedUsers = [
        ...allowedUsers,
        { id, name: userNameInput.trim() || undefined, addedAt: Date.now() },
      ]
    })
    setUserIdInput('')
    setUserNameInput('')
  }

  return (
    <Stack gap="xs">
      <Text size="sm" fw={600}>
        {t('Allowed Users')}
      </Text>
      <Flex align="center" gap="xs">
        <ScalableIcon icon={IconInfoCircle} size={16} className="text-chatbox-tint-tertiary" />
        <Text size="xs" c="chatbox-tertiary">
          {t('Anyone else who writes to the bot receives "No access". Send /id to the bot to get your ID.')}
        </Text>
      </Flex>
      <Flex gap="xs" align="center">
        <Input
          style={{ flex: 1 }}
          placeholder={t('User ID')}
          value={userIdInput}
          onChange={(event) => setUserIdInput(event.target.value)}
          classNames={{ input: '!text-chatbox-tint-primary' }}
        />
        <Input
          style={{ flex: 1 }}
          placeholder={t('Name')}
          value={userNameInput}
          onChange={(event) => setUserNameInput(event.target.value)}
          classNames={{ input: '!text-chatbox-tint-primary' }}
        />
        <Button variant="light" disabled={!userIdInput.trim()} onClick={addUser}>
          {t('Add User')}
        </Button>
      </Flex>
      {allowedUsers.map((user) => (
        <UserCard
          key={user.id}
          title={user.name ?? user.id}
          subtitle={`${t('User ID')}: ${user.id}`}
          action={
            <ActionIcon
              variant="subtle"
              color="red"
              aria-label={t('Remove')}
              onClick={() =>
                setSettings((draft) => {
                  draft.remote.allowedUsers = (draft.remote.allowedUsers ?? []).filter(
                    (candidate) => candidate.id !== user.id
                  )
                })
              }
            >
              <IconTrash size={14} />
            </ActionIcon>
          }
        />
      ))}
    </Stack>
  )
}
