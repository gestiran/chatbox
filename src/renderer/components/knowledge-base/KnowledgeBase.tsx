import { Alert, Button, Flex, Group, Paper, Pill, Stack, Switch, Text, TextInput, Title } from '@mantine/core'
import { AdaptiveSelect } from '@/components/AdaptiveSelect'
import { KNOWLEDGE_BASE_CHUNK_SIZES, KNOWLEDGE_BASE_DEFAULT_CHUNK_SIZE } from '@shared/knowledge-base'
import { SystemProviders } from '@shared/defaults'
import type { KnowledgeBase, ProviderModelInfo } from '@shared/types'
import { parseKnowledgeBaseModelString } from '@shared/utils/knowledge-base-model-parser'
import { IconAlertTriangle, IconInfoCircle, IconPlus, IconRefresh, IconRepeat } from '@tabler/icons-react'
import compact from 'lodash/compact'
import flatten from 'lodash/flatten'
import type React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Modal } from '@/components/layout/Overlay'
import { AppTooltip as Tooltip } from '@/components/ui/tooltip'
import { useProviders } from '@/hooks/useProviders'
import { toastError } from '@/packages/toast'
import platform from '@/platform'
import { useSettingsStore } from '@/stores/settingsStore'
import { trackEvent } from '@/utils/track'
import { ScalableIcon } from '../common/ScalableIcon'
import KnowledgeBaseDocuments from './KnowledgeBaseDocuments'
import {
  KnowledgeBaseFormActions,
  KnowledgeBaseModelSelectors,
  KnowledgeBaseNameInput,
} from './KnowledgeBaseForm'

interface ModelPillProps {
  modelValue: string | null | undefined
  formatModelName: (model: string) => string
  isProviderAvailable: (model: string) => boolean
  type: 'embedding' | 'rerank' | 'vision'
  t: (key: string) => string
  unavailableTooltip?: string
  onUnavailableClick?: () => void
}

const ModelPill: React.FC<ModelPillProps> = ({
  modelValue,
  formatModelName,
  isProviderAvailable,
  type,
  t,
  unavailableTooltip,
  onUnavailableClick,
}) => {
  const isEmbedding = type === 'embedding'
  const hasModel = !!modelValue
  const modelUnavailable = useMemo(
    () => !hasModel || !isProviderAvailable(modelValue),
    [hasModel, isProviderAvailable, modelValue]
  )
  const getColor = () => {
    if (!hasModel) return 'dimmed'
    if (modelUnavailable) return 'red'
    return ''
  }

  const getIcon = () => {
    if (!hasModel || isProviderAvailable(modelValue)) return null
    const icon = (
      <ScalableIcon
        icon={IconAlertTriangle}
        size={12}
        color="red"
        title={unavailableTooltip || t('Provider unavailable')}
      />
    )
    if (onUnavailableClick) {
      return (
        <Tooltip label={unavailableTooltip || t('Provider unavailable')} withArrow multiline maw={200} position="top">
          <span style={{ cursor: 'pointer' }} onClick={onUnavailableClick}>
            {icon}
          </span>
        </Tooltip>
      )
    }
    return icon
  }

  const maxWidth = isEmbedding ? 200 : 150

  const modelText = useMemo(
    () => (hasModel ? formatModelName(modelValue) : t('None')),
    [hasModel, modelValue, formatModelName, t]
  )

  return (
    <Pill style={{ display: 'flex', alignItems: 'center' }}>
      <Flex align="center" gap="xs" maw={maxWidth} h={'100%'}>
        <Text
          c={getColor()}
          size="xs"
          title={modelText}
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}
        >
          {modelText}
        </Text>
        {getIcon()}
      </Flex>
    </Pill>
  )
}

const KnowledgeBasePage: React.FC = () => {
  const { t } = useTranslation()
  const extension = useSettingsStore((state) => state.extension)
  const setSettings = useSettingsStore((state) => state.setSettings)
  const [kbList, setKbList] = useState<KnowledgeBase[]>([])
  const [newKbName, setNewKbName] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const customProviders = useSettingsStore((state) => state.customProviders)

  const [newEmbeddingModel, setNewEmbeddingModel] = useState<string | null>(null)
  const [newRerankModel, setNewRerankModel] = useState<string | null>(null)
  const [newVisionModel, setNewVisionModel] = useState<string | null>(null)
  const [newChunkSize, setNewChunkSize] = useState<string>(String(KNOWLEDGE_BASE_DEFAULT_CHUNK_SIZE))
  const [editKb, setEditKb] = useState<(Partial<KnowledgeBase> & { id: number }) | null>(null)
  const [editRerankModel, setEditRerankModel] = useState<string | null>(null)
  const [editVisionModel, setEditVisionModel] = useState<string | null>(null)
  const [deleteConfirmKb, setDeleteConfirmKb] = useState<(Partial<KnowledgeBase> & { id: number }) | null>(null)
  const [isUnsupportedPlatform, setIsUnsupportedPlatform] = useState(false)

  const { providers } = useProviders()

  const getModelList = useCallback(
    (filter: (model: ProviderModelInfo) => boolean) => {
      return compact(
        flatten(
          providers.map((provider) => {
            return provider.models?.filter(filter).map((model) => {
              return {
                label: `${provider.name} | ${model.nickname || model.modelId}`,
                value: `${provider.id}:${model.modelId}`,
              }
            })
          })
        )
      )
    },
    [providers]
  )

  const embeddingModelList = useMemo(() => {
    return getModelList((model) => !!model.type && model.type === 'embedding')
  }, [getModelList])

  const rerankModelList = useMemo(() => {
    return getModelList((model) => model.type === 'rerank')
  }, [getModelList])

  const visionModelList = useMemo(() => {
    return getModelList((model) => !!model.capabilities?.includes('vision'))
  }, [getModelList])

  // Preselect the first available embedding model so that creating a base
  // works right away without manually picking a model.
  useEffect(() => {
    setNewEmbeddingModel((current) => current ?? embeddingModelList[0]?.value ?? null)
  }, [embeddingModelList])

  const knowledgeBaseController = useMemo(() => {
    return platform.getKnowledgeBaseController()
  }, [])

  const getProviderName = useCallback(
    (providerId: string) => {
      if (SystemProviders().some((it) => it.id === providerId)) {
        return SystemProviders().find((it) => it.id === providerId)?.name
      }

      const customProvider = customProviders?.find((it) => it.id === providerId)
      if (customProvider) {
        return customProvider.name
      }

      return providerId
    },
    [customProviders]
  )

  const getModelName = useCallback(
    (providerId: string, modelId: string) => {
      const provider = providers.find((it) => it.id === providerId)
      if (provider) {
        const model = provider.models?.find((it) => it.modelId === modelId)
        if (model) {
          return model.nickname || model.modelId
        }
      }
    },
    [providers]
  )

  const isProviderAvailable = useCallback(
    (modelString: string) => {
      const parsed = parseKnowledgeBaseModelString(modelString)
      if (!parsed) return false
      return providers.some((provider) => provider.id === parsed.providerId)
    },
    [providers]
  )

  function formatModelName(model: string) {
    const parsed = parseKnowledgeBaseModelString(model)
    if (!parsed) return t('Unknown')
    const { providerId, modelId } = parsed
    const providerName = getProviderName(providerId)
    const modelName = getModelName(providerId, modelId) || modelId
    return `${providerName} | ${modelName}`
  }

  const fetchKbList = useCallback(async () => {
    if (isUnsupportedPlatform) return
    try {
      const list = await knowledgeBaseController.list()
      if (list) {
        setKbList(list)
      }
    } catch (error) {
      toastError(t('Failed to fetch knowledge base list, Error: {{error}}', { error: error }))
    }
  }, [knowledgeBaseController, isUnsupportedPlatform, t])

  useEffect(() => {
    void fetchKbList()
  }, [fetchKbList])

  // fileId lists of files whose stored hash is missing or stale, per kb id.
  const [modifiedIdsByKb, setModifiedIdsByKb] = useState<Record<number, number[]>>({})
  const [checkingKbId, setCheckingKbId] = useState<number | null>(null)
  const [updatingKbId, setUpdatingKbId] = useState<number | null>(null)

  const applyHashCheckResults = useCallback((kbId: number, results: { fileId: number; modified: boolean }[]) => {
    setModifiedIdsByKb((prev) => ({
      ...prev,
      [kbId]: results.filter((r) => r.modified).map((r) => r.fileId),
    }))
  }, [])

  // Re-check hashes of every file in the base against the vector store.
  const handleRefreshKb = useCallback(
    async (kb: KnowledgeBase) => {
      if (!kb?.id || checkingKbId !== null) return
      setCheckingKbId(kb.id)
      try {
        const results = await platform.getKnowledgeBaseController().checkFileHashes(kb.id)
        applyHashCheckResults(kb.id, results)
        const modifiedCount = results.filter((r) => r.modified).length
        if (modifiedCount > 0) {
          toast.info(t('{{count}} file(s) changed on disk since indexing', { count: modifiedCount }))
        } else {
          toast.success(t('All files are up to date'))
        }
      } catch (error) {
        toastError(
          t('Failed to check file hashes: {{error}}', { error: (error as Error)?.message || 'Unknown error' })
        )
      } finally {
        setCheckingKbId(null)
      }
    },
    [applyHashCheckResults, checkingKbId, t]
  )

  // Re-index every modified file of the base.
  const handleUpdateKb = useCallback(
    async (kb: KnowledgeBase) => {
      if (!kb?.id || updatingKbId !== null) return
      const fileIds = modifiedIdsByKb[kb.id] ?? []
      if (fileIds.length === 0) return
      setUpdatingKbId(kb.id)
      try {
        await platform.getKnowledgeBaseController().updateFiles(kb.id, fileIds)
        setModifiedIdsByKb((prev) => ({ ...prev, [kb.id]: [] }))
        toast.success(t('Updating {{count}} file(s)...', { count: fileIds.length }))
      } catch (error) {
        toastError(t('Failed to update files: {{error}}', { error: (error as Error)?.message || 'Unknown error' }))
      } finally {
        setUpdatingKbId(null)
      }
    },
    [modifiedIdsByKb, t, updatingKbId]
  )

  // Re-check the hash of a single file. Returns whether it is modified.
  const handleRefreshSingleFile = useCallback(
    async (kbId: number, fileId: number): Promise<boolean> => {
      try {
        const results = await platform.getKnowledgeBaseController().checkFileHashes(kbId, [fileId])
        const result = results[0]
        setModifiedIdsByKb((prev) => {
          const current = new Set(prev[kbId] ?? [])
          if (result?.modified) {
            current.add(fileId)
          } else {
            current.delete(fileId)
          }
          return { ...prev, [kbId]: [...current] }
        })
        return result?.modified ?? false
      } catch (error) {
        toastError(t('Failed to check file hashes: {{error}}', { error: (error as Error)?.message || 'Unknown error' }))
        return false
      }
    },
    [t]
  )

  // Re-index a single modified file.
  const handleUpdateSingleFile = useCallback(async (kbId: number, fileId: number) => {
    try {
      await platform.getKnowledgeBaseController().updateFiles(kbId, [fileId])
      setModifiedIdsByKb((prev) => ({
        ...prev,
        [kbId]: (prev[kbId] ?? []).filter((id) => id !== fileId),
      }))
    } catch (error) {
      toastError(t('Failed to update files: {{error}}', { error: (error as Error)?.message || 'Unknown error' }))
    }
  }, [t])

  // Check platform compatibility
  useEffect(() => {
    const checkPlatform = async () => {
      try {
        const platformName = await platform.getPlatform()
        const arch = await platform.getArch()
        const isWin32Arm64 = platformName === 'win32' && arch === 'arm64'
        setIsUnsupportedPlatform(isWin32Arm64)
      } catch (error) {
        console.error('Failed to check platform compatibility:', error)
      }
    }
    void checkPlatform()
  }, [])

  const createKb = async () => {
    if (!newKbName) return

    if (!newEmbeddingModel) return
    const embeddingModel = newEmbeddingModel
    const rerankModel = newRerankModel || ''
    const visionModel = newVisionModel || ''

    try {
      await knowledgeBaseController.create({
        name: newKbName,
        embeddingModel: embeddingModel,
        rerankModel: rerankModel,
        visionModel: visionModel,
        chunkSize: Number(newChunkSize),
      })

      trackEvent('knowledge_base_created', {
        embedding_model: embeddingModel,
        rerank_model: rerankModel || null,
        vision_model: visionModel || null,
        knowledge_base_name: newKbName,
      })

      // Reset form
      setNewKbName('')
      setNewEmbeddingModel(null)
      setNewRerankModel(null)
      setNewVisionModel(null)
      setShowCreate(false)
      await fetchKbList()
    } catch (e) {
      toastError(t('Failed to create knowledge base, Error: {{error}}', { error: e }))
    }
  }

  const handleEditKb = (kb: KnowledgeBase) => {
    setEditKb(kb)
    setEditRerankModel(kb.rerankModel ? `${kb.rerankModel}` : null)
    setEditVisionModel(kb.visionModel ? `${kb.visionModel}` : null)
  }

  const handleSaveEditKb = async () => {
    if (!editKb) return

    try {
      await knowledgeBaseController.update({
        id: editKb.id,
        name: editKb.name,
        rerankModel: editRerankModel || '',
        visionModel: editVisionModel || '',
      })
      setEditKb(null)
      setEditRerankModel(null)
      setEditVisionModel(null)
      await fetchKbList()
    } catch (e) {
      toastError(t('Failed to update knowledge base, Error: {{error}}', { error: e }))
    }
  }

  const handleDeleteKb = async () => {
    if (!deleteConfirmKb) return
    try {
      await knowledgeBaseController.delete(deleteConfirmKb.id)
      setDeleteConfirmKb(null)
      setEditKb(null) // Close edit modal if it's open
      await fetchKbList()
    } catch (error) {
      console.error('Failed to delete knowledge base:', error)
    }
  }

  // Master switch (this page). When off, every control below stays visible
  // but dimmed and non-interactive.
  const knowledgeBaseEnabled = extension.knowledgeBase.enabled !== false

  return (
    <Stack p="md" gap="xl">
      <Title order={5}>{t('Knowledge Base')}</Title>
      <Switch
        label={t('Enable Knowledge Base')}
        description={t('When disabled, Knowledge Base is hidden and unavailable in all chats.')}
        checked={knowledgeBaseEnabled}
        onChange={(e) =>
          setSettings({
            extension: {
              ...extension,
              knowledgeBase: {
                ...extension.knowledgeBase,
                enabled: e.currentTarget.checked,
              },
            },
          })
        }
      />

      <Stack
        gap="xl"
        aria-disabled={!knowledgeBaseEnabled}
        style={knowledgeBaseEnabled ? undefined : { opacity: 0.5, pointerEvents: 'none' }}
      >
        {/* Knowledge base vectors are stored in an external QDrant server. */}
        <Stack gap="xs">
          <TextInput
            label={t('QDrant URL')}
            description={t(
              'URL of the QDrant database that all requests are sent to. Leave empty to use the local instance at http://127.0.0.1:6333.'
            )}
            placeholder="http://127.0.0.1:6333"
            value={extension.knowledgeBase.vectorStore?.qdrantUrl ?? ''}
            onChange={(e) =>
              setSettings({
                extension: {
                  ...extension,
                  knowledgeBase: {
                    ...extension.knowledgeBase,
                    vectorStore: {
                      qdrantUrl: e.currentTarget.value,
                    },
                  },
                },
              })
            }
            maw={320}
          />
        </Stack>

        <Group justify="space-between" align="center">
          <Button variant="outline" onClick={() => setShowCreate(true)} disabled={isUnsupportedPlatform}>
            <Group gap="xs">
              <ScalableIcon icon={IconPlus} size={16} />
              <Text size="sm" c="chatbox-brand" fw={400}>
                {t('Add')}
              </Text>
            </Group>
          </Button>
        </Group>

        {isUnsupportedPlatform && (
          <Alert
            variant="light"
            color="orange"
            title={t('Platform Not Supported')}
            icon={<ScalableIcon icon={IconInfoCircle} size={16} />}
          >
            <Text size="sm">
              {t(
                'Knowledge Base functionality is not available on Windows ARM64 due to library compatibility issues. This feature is supported on Windows x64, macOS, and Linux.'
              )}
            </Text>
          </Alert>
        )}

        <Modal opened={showCreate} onClose={() => setShowCreate(false)} title={t('Create Knowledge Base')} centered>
          <Stack gap="md">
            <KnowledgeBaseNameInput value={newKbName} onChange={setNewKbName} autoFocus />

            <KnowledgeBaseModelSelectors
              embeddingModelList={embeddingModelList}
              rerankModelList={rerankModelList}
              visionModelList={visionModelList}
              embeddingModel={newEmbeddingModel}
              rerankModel={newRerankModel}
              visionModel={newVisionModel}
              onEmbeddingModelChange={setNewEmbeddingModel}
              onRerankModelChange={setNewRerankModel}
              onVisionModelChange={setNewVisionModel}
            />

            {/* Chunk size is fixed at creation time and cannot be changed later */}
            <AdaptiveSelect
              label={t('Chunk Size')}
              description={t('Maximum size of one text chunk. Cannot be changed after the base is created.')}
              data={KNOWLEDGE_BASE_CHUNK_SIZES.map((size) => ({ value: String(size), label: String(size) }))}
              value={newChunkSize}
              onChange={(value) => value && setNewChunkSize(value)}
              allowDeselect={false}
              maw={320}
            />

            <KnowledgeBaseFormActions
              onCancel={() => setShowCreate(false)}
              onConfirm={createKb}
              confirmText={t('Create')}
              isConfirmDisabled={!newKbName || !newEmbeddingModel}
            />
          </Stack>
        </Modal>
        <Modal opened={!!editKb} onClose={() => setEditKb(null)} title={t('Edit Knowledge Base')} centered>
          <Stack gap="md">
            <KnowledgeBaseNameInput
              value={editKb?.name || ''}
              onChange={(value) => editKb && setEditKb({ ...editKb, name: value })}
              label={t('Name') as string}
            />
            {editKb && (
              <KnowledgeBaseModelSelectors
                embeddingModelList={embeddingModelList}
                rerankModelList={rerankModelList}
                visionModelList={visionModelList}
                embeddingModel={`${editKb.embeddingModel}`}
                rerankModel={editRerankModel}
                visionModel={editVisionModel}
                onRerankModelChange={setEditRerankModel}
                onVisionModelChange={setEditVisionModel}
                isEmbeddingDisabled
              />
            )}
            {editKb && (
              /* Chunk size is read-only after creation */
              <AdaptiveSelect
                label={t('Chunk Size')}
                data={KNOWLEDGE_BASE_CHUNK_SIZES.map((size) => ({ value: String(size), label: String(size) }))}
                value={String(editKb.chunkSize ?? KNOWLEDGE_BASE_DEFAULT_CHUNK_SIZE)}
                disabled
                allowDeselect={false}
                maw={320}
              />
            )}
            <KnowledgeBaseFormActions
              onCancel={() => setEditKb(null)}
              onConfirm={handleSaveEditKb}
              confirmText={t('Save')}
              showDelete
              onDelete={() => setDeleteConfirmKb(editKb)}
            />
          </Stack>
        </Modal>
        {/* Delete Confirmation Modal */}
        <Modal
          opened={!!deleteConfirmKb}
          onClose={() => setDeleteConfirmKb(null)}
          title={t('Delete Knowledge Base')}
          centered
          size="sm"
        >
          <Stack gap="md">
            <Text size="sm">
              {t('Are you sure you want to delete the knowledge base')} "{deleteConfirmKb?.name}"?
            </Text>
            <Text size="sm" c="dimmed">
              {t('This action cannot be undone. All documents and their embeddings will be permanently deleted.')}
            </Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setDeleteConfirmKb(null)}>
                {t('Cancel')}
              </Button>
              <Button color="red" onClick={handleDeleteKb}>
                {t('Delete')}
              </Button>
            </Group>
          </Stack>
        </Modal>
        {!isUnsupportedPlatform && (
          <Stack gap="xl">
            {kbList.length === 0 ? (
              <Paper withBorder p="xl" style={{ textAlign: 'center' }}>
                <Stack gap="md" align="center">
                  <ScalableIcon icon={IconInfoCircle} size={48} color="var(--chatbox-tint-tertiary)" />
                  <Stack gap="xs" align="center">
                    <Text fw={500} size="lg">
                      {t('No Knowledge Base Yet')}
                    </Text>
                    <Text size="sm" c="dimmed" style={{ maxWidth: 400 }}>
                      {t(
                        'Create your first knowledge base to start adding documents and enhance your AI conversations with contextual information.'
                      )}
                    </Text>
                  </Stack>
                  <Button variant="outline" onClick={() => setShowCreate(true)} size="sm">
                    <Group gap="xs">
                      <ScalableIcon icon={IconPlus} size={16} />
                      {t('Create First Knowledge Base')}
                    </Group>
                  </Button>
                </Stack>
              </Paper>
            ) : (
              kbList.map((kb) => (
                <Paper key={kb.id} withBorder p="md">
                  <Stack gap="md">
                    <Stack gap="0">
                      <Group justify="space-between" align="center">
                        <Text fw={600} size="lg">
                          {kb.name}
                        </Text>
                        <Group gap="xs">
                          <Button
                            size="xs"
                            variant="subtle"
                            leftSection={<IconRefresh size={14} />}
                            loading={checkingKbId === kb.id}
                            onClick={() => handleRefreshKb(kb)}
                            title={t('Check all files for changes')}
                          >
                            {t('Refresh')}
                          </Button>
                          <Button
                            size="xs"
                            variant="subtle"
                            leftSection={<IconRepeat size={14} />}
                            disabled={(modifiedIdsByKb[kb.id] ?? []).length === 0 || updatingKbId === kb.id}
                            loading={updatingKbId === kb.id}
                            onClick={() => handleUpdateKb(kb)}
                            title={t('Re-index all modified files')}
                          >
                            {t('Update')}
                          </Button>
                          <Button size="xs" variant="subtle" onClick={() => handleEditKb(kb)}>
                            {t('Edit')}
                          </Button>
                        </Group>
                      </Group>
                      <Group gap="xs" wrap="wrap" align="center">
                        <Text size="xs" c="dimmed">
                          {t('Embedding')}:
                        </Text>
                        <ModelPill
                          modelValue={kb.embeddingModel}
                          formatModelName={formatModelName}
                          isProviderAvailable={isProviderAvailable}
                          type="embedding"
                          t={t}
                        />
                        <Text size="xs" c="dimmed">
                          {t('Rerank')}:
                        </Text>
                        <ModelPill
                          modelValue={kb.rerankModel}
                          formatModelName={formatModelName}
                          isProviderAvailable={isProviderAvailable}
                          type="rerank"
                          t={t}
                        />
                        <Text size="xs" c="dimmed">
                          {t('Vision')}:
                        </Text>
                        <ModelPill
                          modelValue={kb.visionModel}
                          formatModelName={formatModelName}
                          isProviderAvailable={isProviderAvailable}
                          type="vision"
                          t={t}
                        />
                      </Group>
                    </Stack>
                    <KnowledgeBaseDocuments
                      knowledgeBase={kb}
                      modifiedFileIds={modifiedIdsByKb[kb.id] ?? []}
                      onRefreshFile={(fileId) => handleRefreshSingleFile(kb.id, fileId)}
                      onUpdateFile={(fileId) => handleUpdateSingleFile(kb.id, fileId)}
                    />
                  </Stack>
                </Paper>
              ))
            )}
          </Stack>
        )}
      </Stack>
    </Stack>
  )
}

export default KnowledgeBasePage
