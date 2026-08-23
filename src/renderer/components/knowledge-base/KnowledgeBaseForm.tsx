import { Button, Group, Input, Select } from '@mantine/core'
import { IconTrash } from '@tabler/icons-react'
import type React from 'react'
import { useTranslation } from 'react-i18next'

interface ModelSelectorsProps {
  embeddingModelList: Array<{ label: string; value: string }>
  rerankModelList: Array<{ label: string; value: string }>
  visionModelList: Array<{ label: string; value: string }>
  embeddingModel?: string | null
  rerankModel?: string | null
  visionModel?: string | null
  onEmbeddingModelChange?: (value: string | null) => void
  onRerankModelChange?: (value: string | null) => void
  onVisionModelChange?: (value: string | null) => void
  isEmbeddingDisabled?: boolean
  showEmbeddingModel?: boolean
  /** Rendered right after the Embedding Model select (e.g. chunk size). */
  afterEmbeddingSlot?: React.ReactNode
}

export const KnowledgeBaseModelSelectors: React.FC<ModelSelectorsProps> = ({
  embeddingModelList,
  rerankModelList,
  visionModelList,
  embeddingModel,
  rerankModel,
  visionModel,
  onEmbeddingModelChange,
  onRerankModelChange,
  onVisionModelChange,
  isEmbeddingDisabled = false,
  showEmbeddingModel = true,
  afterEmbeddingSlot,
}) => {
  const { t } = useTranslation()

  return (
    <>
      {showEmbeddingModel && (
        <Select
          label={t('Embedding Model')}
          description={t('Used to extract text feature vectors, add in Settings - Provider - Model List')}
          data={embeddingModelList}
          value={embeddingModel}
          onChange={onEmbeddingModelChange}
          required={!isEmbeddingDisabled}
          disabled={isEmbeddingDisabled}
          searchable
          comboboxProps={{ withinPortal: false }}
          allowDeselect={false}
        />
      )}
      {afterEmbeddingSlot}
      <Select
        label={t('Rerank Model (optional)')}
        description={t('Used to get more accurate search results')}
        data={rerankModelList}
        value={rerankModel}
        onChange={onRerankModelChange}
        clearable
        searchable
        comboboxProps={{ withinPortal: false, position: 'bottom' }}
      />
      <Select
        label={t('Vision Model (optional)')}
        description={t('Used to preprocess image files, requires models with vision capabilities enabled')}
        data={visionModelList}
        value={visionModel}
        onChange={onVisionModelChange}
        clearable
        searchable
        comboboxProps={{ withinPortal: false, position: 'bottom' }}
      />
    </>
  )
}

interface KnowledgeBaseFormActionsProps {
  onCancel: () => void
  onConfirm: () => void
  confirmText: string
  isConfirmDisabled?: boolean
  showDelete?: boolean
  onDelete?: () => void
}

export const KnowledgeBaseFormActions: React.FC<KnowledgeBaseFormActionsProps> = ({
  onCancel,
  onConfirm,
  confirmText,
  isConfirmDisabled = false,
  showDelete = false,
  onDelete,
}) => {
  const { t } = useTranslation()

  if (showDelete && onDelete) {
    return (
      <Group justify="space-between">
        <Button variant="outline" color="red" leftSection={<IconTrash size={16} />} onClick={onDelete}>
          {t('Delete')}
        </Button>
        <Group>
          <Button variant="default" onClick={onCancel}>
            {t('Cancel')}
          </Button>
          <Button onClick={onConfirm} disabled={isConfirmDisabled}>
            {confirmText}
          </Button>
        </Group>
      </Group>
    )
  }

  return (
    <Group justify="flex-end">
      <Button variant="default" onClick={onCancel}>
        {t('Cancel')}
      </Button>
      <Button onClick={onConfirm} disabled={isConfirmDisabled}>
        {confirmText}
      </Button>
    </Group>
  )
}

interface KnowledgeBaseNameInputProps {
  value: string
  onChange: (value: string) => void
  label?: string
  placeholder?: string
  autoFocus?: boolean
}

export const KnowledgeBaseNameInput: React.FC<KnowledgeBaseNameInputProps> = ({
  value,
  onChange,
  label,
  placeholder,
  autoFocus = false,
}) => {
  const { t } = useTranslation()

  return (
    <Input.Wrapper label={label}>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder || t('New knowledge base name')}
        autoFocus={autoFocus}
      />
    </Input.Wrapper>
  )
}
