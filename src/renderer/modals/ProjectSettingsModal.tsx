import NiceModal, { useModal } from '@ebay/nice-modal-react'
import { ActionIcon, Button, Checkbox, Flex, Input, Stack, Switch, Text, Textarea, UnstyledButton } from '@mantine/core'
import type { AgentModeEntry, KnowledgeBase, Project, ProjectWebSearchProvider } from '@shared/types'
import {
  IconCheck,
  IconFile,
  IconFolderPlus,
  IconTrash,
  IconWand,
} from '@tabler/icons-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ModelSelectorV2 from '@/components/ModelSelectorV2'
import { AdaptiveModal } from '@/components/common/AdaptiveModal'
import { useKnowledgeBases } from '@/hooks/knowledge-base'
import { BUILTIN_MCP_SERVERS } from '@/packages/mcp/builtin'
import { skillsController, subscribeSkillsChanged } from '@/packages/skills/controller'
import { WEB_SEARCH_PROVIDERS } from '@/packages/web-search/constants'
import platform from '@/platform'
import { recentDirectoriesStore, useRecentDirectories } from '@/stores/recentDirectoriesStore'
import { useMcpSettings, useSettingsStore } from '@/stores/settingsStore'
import { updateProject } from '@/stores/projectStore'

const supportsWorkingDirectories = platform.type === 'desktop' && !!platform.openDirectoryDialog

function getDirectoryName(directory: string) {
  return directory.split(/[\\/]/).filter(Boolean).pop() || directory
}

interface ProjectSettingsModalProps {
  project: Project
}

/**
 * PopUp editor for a project's starting parameters. Chats created inside the
 * project inherit these instead of the user's standard settings.
 */
const ProjectSettingsModal = NiceModal.create(({ project }: ProjectSettingsModalProps) => {
  const modal = useModal()
  const { t } = useTranslation()

  const [name, setName] = useState(project.name)
  const [systemPrompt, setSystemPrompt] = useState(project.settings.systemPrompt ?? '')
  const [provider, setProvider] = useState<string | undefined>(project.settings.provider)
  const [modelId, setModelId] = useState<string | undefined>(project.settings.modelId)
  const [agentModeValue, setAgentModeValue] = useState<AgentModeEntry['value']>(project.settings.agentMode?.value ?? 'off')
  const [mcpServerIds, setMcpServerIds] = useState<string[]>(project.settings.mcpServerIds ?? [])
  const [mcpBuiltinServerIds, setMcpBuiltinServerIds] = useState<string[]>(project.settings.mcpBuiltinServerIds ?? [])
  const [knowledgeBaseId, setKnowledgeBaseId] = useState<number | null>(project.settings.knowledgeBaseId ?? null)
  const [skillNames, setSkillNames] = useState<string[]>(project.settings.skillNames ?? [])
  const [webSearchProvider, setWebSearchProvider] = useState<ProjectWebSearchProvider | undefined>(
    project.settings.webSearchProvider
  )
  const [webBrowsingEnabled, setWebBrowsingEnabled] = useState<boolean>(project.settings.webBrowsingEnabled ?? false)
  const [workingDirectories, setWorkingDirectories] = useState<string[]>(project.settings.workingDirectories ?? [])

  // NiceModal keeps this modal mounted between shows, and useState initializers
  // only run on the first mount. Without this sync the editor would keep
  // showing (and saving) the previously edited project's values instead of the
  // project that was passed via RMB -> Edit. Every show() call passes a fresh
  // `project` argument object, so this effect re-runs on each open.
  useEffect(() => {
    setName(project.name)
    setSystemPrompt(project.settings.systemPrompt ?? '')
    setProvider(project.settings.provider)
    setModelId(project.settings.modelId)
    setAgentModeValue(project.settings.agentMode?.value ?? 'off')
    setMcpServerIds(project.settings.mcpServerIds ?? [])
    setMcpBuiltinServerIds(project.settings.mcpBuiltinServerIds ?? [])
    setKnowledgeBaseId(project.settings.knowledgeBaseId ?? null)
    setSkillNames(project.settings.skillNames ?? [])
    setWebSearchProvider(project.settings.webSearchProvider)
    setWebBrowsingEnabled(project.settings.webBrowsingEnabled ?? false)
    setWorkingDirectories(project.settings.workingDirectories ?? [])
  }, [project])

  const mcpSettings = useMcpSettings()
  const { data: knowledgeBases } = useKnowledgeBases()
  const recentDirectories = useRecentDirectories()
  // Master switch for the built-in filesystem toolset (Settings / General). When it is off,
  // project-level working directories would have no effect, so the block stays hidden.
  const filesystemToolsEnabled = useSettingsStore((s) => s.enableFilesystemTools !== false)
  // Master switch for Web Search (Settings / Web Search). When it is off, per-project
  // web-search options would have no effect, so the block stays hidden.
  const webSearchEnabled = useSettingsStore((s) => s.extension.webSearch.enabled !== false)

  // Skills list (same source as the input-box panel)
  const [skills, setSkills] = useState<Array<{ name: string; description: string }>>([])
  useEffect(() => {
    let cancelled = false
    skillsController
      .discoverSkills()
      .then((all) => {
        if (!cancelled) {
          setSkills(all.map((s) => ({ name: s.name, description: s.description })))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSkills([])
        }
      })
    return subscribeSkillsChanged(() => {
      skillsController
        .discoverSkills()
        .then((all) => setSkills(all.map((s) => ({ name: s.name, description: s.description }))))
        .catch(() => setSkills([]))
    })
  }, [])

  const toggleMcpServer = useCallback((id: string, enabled: boolean) => {
    setMcpServerIds((prev) => (enabled ? [...new Set([...prev, id])] : prev.filter((item) => item !== id)))
  }, [])

  const toggleBuiltinMcpServer = useCallback((id: string, enabled: boolean) => {
    setMcpBuiltinServerIds((prev) => (enabled ? [...new Set([...prev, id])] : prev.filter((item) => item !== id)))
  }, [])

  const handleAddWorkingDirectory = useCallback(async () => {
    if (!platform.openDirectoryDialog) return
    const result = await platform.openDirectoryDialog()
    if (result.canceled || !result.path) return
    const path = result.path
    recentDirectoriesStore.getState().addDirectory(path)
    setWorkingDirectories((prev) => (prev.includes(path) ? prev : [...prev, path]))
  }, [])

  const onSelectModel = useCallback((p: string, m: string) => {
    setProvider(p)
    setModelId(m)
  }, [])

  const onCancel = () => {
    modal.resolve(null)
    modal.hide()
  }

  const onSave = async () => {
    const settings = {
      ...(provider && modelId ? { provider, modelId } : {}),
      systemPrompt: systemPrompt.trim() ? systemPrompt : undefined,
      agentMode: { value: agentModeValue, locked: false, lockReason: null },
      mcpServerIds,
      mcpBuiltinServerIds,
      knowledgeBaseId,
      knowledgeBaseName: knowledgeBases?.find((kb) => kb.id === knowledgeBaseId)?.name,
      skillNames,
      webSearchProvider,
      webBrowsingEnabled,
      workingDirectories,
    }
    const updated = await updateProject(project.id, { name: name.trim() || project.name, settings })
    modal.resolve(updated)
    modal.hide()
  }

  const availableRecentDirectories = recentDirectories.filter((dir) => !workingDirectories.includes(dir))

  return (
    <AdaptiveModal
      opened={modal.visible}
      onClose={onCancel}
      centered
      size="lg"
      title={t('Project Settings')}
      onFocus={(e) => e.stopPropagation()}
      trapFocus={false}
    >
      <div style={{ maxHeight: '60vh', overflowY: 'auto', overflowX: 'hidden' }}>
        <Stack gap="md">
          <Stack gap="xs">
            <Text fw={700}>{t('Name')}</Text>
            <Input
              placeholder={t('Name')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              classNames={{ input: '!text-chatbox-tint-primary' }}
            />
          </Stack>

          <Textarea
            label={t('Instruction (System Prompt)')}
            description={t('Overrides your default System Prompt for chats created in this project.')}
            placeholder={t('Copilot Prompt Demo') || ''}
            autosize
            minRows={2}
            maxRows={12}
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
            classNames={{ input: '!text-chatbox-tint-primary' }}
          />

          <Stack gap="xs">
            <Text fw={700}>{t('AI Model')}</Text>
            <ModelSelectorV2
              onSelect={onSelectModel}
              selectedProviderId={provider}
              selectedModelId={modelId}
              position="bottom-start"
            >
              <UnstyledButton className="flex w-full items-center gap-1 rounded-lg border border-solid border-chatbox-border-primary px-3 py-2 hover:bg-[var(--chatbox-background-tertiary)]">
                <Text size="sm" truncate>
                  {provider && modelId ? `${provider} / ${modelId}` : t('Default model')}
                </Text>
              </UnstyledButton>
            </ModelSelectorV2>
          </Stack>

          <Stack gap="xs">
            <Text fw={700}>{t('Chat Mode')}</Text>
            <Flex gap={6}>
              <Button
                size="xs"
                flex={1}
                variant={agentModeValue !== 'on' ? 'filled' : 'default'}
                color={agentModeValue !== 'on' ? 'chatbox-brand' : undefined}
                onClick={() => setAgentModeValue('off')}
              >
                {t('Chat Mode')}
              </Button>
              <Button
                size="xs"
                flex={1}
                variant={agentModeValue === 'on' ? 'filled' : 'default'}
                color={agentModeValue === 'on' ? 'chatbox-brand' : undefined}
                onClick={() => setAgentModeValue('on')}
              >
                {t('Work Mode')}
              </Button>
            </Flex>
          </Stack>

          <Stack gap="xs">
            <Text fw={700}>MCP</Text>
            {BUILTIN_MCP_SERVERS.map((server) => (
              <Flex key={server.id} justify="space-between" align="center" px="sm" py={6} className="rounded">
                <Text size="sm">{server.name}</Text>
                <Switch
                  checked={mcpBuiltinServerIds.includes(server.id)}
                  size="xs"
                  onChange={(e) => toggleBuiltinMcpServer(server.id, e.currentTarget.checked)}
                />
              </Flex>
            ))}
            {mcpSettings.servers.map((server) => (
              <Flex key={server.id} justify="space-between" align="center" px="sm" py={6} className="rounded">
                <Text size="sm">{server.name}</Text>
                <Switch
                  checked={mcpServerIds.includes(server.id)}
                  size="xs"
                  onChange={(e) => toggleMcpServer(server.id, e.currentTarget.checked)}
                />
              </Flex>
            ))}
          </Stack>

          <Stack gap="xs">
            <Text fw={700}>{t('Knowledge Base')}</Text>
            {(knowledgeBases ?? []).map((kb: KnowledgeBase) => (
              <UnstyledButton
                key={kb.id}
                onClick={() => setKnowledgeBaseId((prev) => (prev === kb.id ? null : kb.id))}
                className="w-full rounded px-3 py-2 text-left hover:bg-[var(--chatbox-background-tertiary)]"
              >
                <Flex justify="space-between" align="center">
                  <Text size="sm" c={knowledgeBaseId === kb.id ? 'chatbox-brand' : undefined}>
                    {kb.name}
                  </Text>
                  {knowledgeBaseId === kb.id && <IconCheck size={14} color="var(--chatbox-tint-brand)" />}
                </Flex>
              </UnstyledButton>
            ))}
          </Stack>

          <Stack gap="xs">
            <Text fw={700}>Skills</Text>
            {skills.length === 0 && (
              <Text size="sm" c="dimmed">
                {t('No skills available')}
              </Text>
            )}
            {skills.map((skill) => (
              <Checkbox
                key={skill.name}
                label={
                  <Text size="sm" span>
                    /{skill.name}
                  </Text>
                }
                checked={skillNames.includes(skill.name)}
                onChange={(e) =>
                  setSkillNames((prev) =>
                    e.currentTarget.checked ? [...prev, skill.name] : prev.filter((item) => item !== skill.name)
                  )
                }
                px="sm"
                py={4}
              />
            ))}
          </Stack>

          {webSearchEnabled && (
            <Stack gap="xs">
              <Text fw={700}>{t('Web Search')}</Text>
              <Switch
                label={t('Enable Web Search for new chats')}
                checked={webBrowsingEnabled}
                onChange={(e) => setWebBrowsingEnabled(e.currentTarget.checked)}
              />
              {WEB_SEARCH_PROVIDERS.map((option) => (
                <UnstyledButton
                  key={option.value}
                  onClick={() => setWebSearchProvider(option.value)}
                  className="w-full rounded px-3 py-2 text-left hover:bg-[var(--chatbox-background-tertiary)]"
                >
                  <Flex justify="space-between" align="center">
                    <Text size="sm" c={webSearchProvider === option.value ? 'chatbox-brand' : undefined}>
                      {option.label}
                    </Text>
                    {webSearchProvider === option.value && (
                      <IconCheck size={14} color="var(--chatbox-tint-brand)" />
                    )}
                  </Flex>
                </UnstyledButton>
              ))}
            </Stack>
          )}

          {supportsWorkingDirectories && filesystemToolsEnabled && (
            <Stack gap="xs">
              <Text fw={700}>{t('Working Directory')}</Text>
              {workingDirectories.map((dir) => (
                <Flex key={dir} justify="space-between" align="center" px="sm" py={4} gap="xs">
                  <Flex gap="xs" align="center" className="min-w-0">
                    <IconFile size={14} className="text-[var(--chatbox-tint-tertiary)] shrink-0" />
                    <Text size="sm" truncate className="min-w-0">
                      {getDirectoryName(dir)}
                    </Text>
                  </Flex>
                  <ActionIcon
                    variant="subtle"
                    size={20}
                    color="red"
                    aria-label={t('Remove')}
                    onClick={() => setWorkingDirectories((prev) => prev.filter((item) => item !== dir))}
                  >
                    <IconTrash size={14} />
                  </ActionIcon>
                </Flex>
              ))}
              {availableRecentDirectories.length > 0 && (
                <>
                  {availableRecentDirectories.map((dir) => (
                    <UnstyledButton
                      key={dir}
                      className="w-full rounded px-3 py-1.5 text-left hover:bg-[var(--chatbox-background-tertiary)]"
                      onClick={() => setWorkingDirectories((prev) => [...prev, dir])}
                    >
                      <Text size="sm" truncate>
                        {getDirectoryName(dir)}
                      </Text>
                      <Text size="xs" c="dimmed" truncate>
                        {dir}
                      </Text>
                    </UnstyledButton>
                  ))}
                </>
              )}
              <Button size="xs" variant="light" leftSection={<IconFolderPlus size={14} />} onClick={handleAddWorkingDirectory}>
                {t('Add Folder')}
              </Button>
            </Stack>
          )}

          <Stack gap="xs">
            <Flex gap="xs" align="center">
              <IconWand size={14} className="text-[var(--chatbox-tint-tertiary)]" />
              <Text size="xs" c="dimmed">
                {t('New chats in this project start with these parameters instead of your defaults.')}
              </Text>
            </Flex>
          </Stack>
        </Stack>
      </div>

      <AdaptiveModal.Actions>
        <AdaptiveModal.CloseButton onClick={onCancel} />
        <Button onClick={onSave}>{t('Save')}</Button>
      </AdaptiveModal.Actions>
    </AdaptiveModal>
  )
})

export default ProjectSettingsModal

/** Helper kept next to the modal so both "+" flows share one entry point. */
export function showProjectSettings(project: Project) {
  return NiceModal.show('project-settings', { project }) as Promise<Project | null>
}
