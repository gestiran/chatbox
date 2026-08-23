import NiceModal from '@ebay/nice-modal-react'
import { ActionIcon, Box, Flex, Paper, Text } from '@mantine/core'
import { TestId } from '@shared/automation/testids'
import type { Project } from '@shared/types'
import {
  IconChevronRight,
  IconCirclePlus,
  IconEdit,
  IconFolder,
  IconTrash,
} from '@tabler/icons-react'
import clsx from 'clsx'
import { type MouseEvent, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useIsSmallScreen } from '@/hooks/useScreenChange'
import { AppTooltip as Tooltip } from '@/components/ui/tooltip'
import { useUIStore } from '@/stores/uiStore'
import { ScalableIcon } from '../common/ScalableIcon'
import { showProjectSettings } from '@/modals/ProjectSettingsModal'
import { createProjectChat, deleteProjectWithChats, setProjectExpanded } from '@/stores/projectStore'

export interface Props {
  project: Project
  chatCount: number
  expanded: boolean
  /** True while a chat of this project is open in the main window. */
  active?: boolean
}

/**
 * Foldout header row for a project in the sidebar. Shows the project name with a
 * foldout toggle, a small "+" button that creates a new chat inside the project,
 * and a right-click menu with Edit / Remove actions.
 */
function ProjectItem({ project, chatCount, expanded, active = false }: Props) {
  const { t } = useTranslation()
  const [menuOpened, setMenuOpened] = useState(false)
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const menuRef = useRef<HTMLDivElement>(null)
  const [creatingChat, setCreatingChat] = useState(false)
  const isSmallScreen = useIsSmallScreen()
  const setShowSidebar = useUIStore((s) => s.setShowSidebar)

  useEffect(() => {
    if (!menuOpened) return
    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpened(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpened(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [menuOpened])

  const handleContextMenu = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setMenuPosition({ x: event.clientX, y: event.clientY })
    setMenuOpened(true)
  }

  const handleToggleFoldout = () => {
    void setProjectExpanded(project.id, !expanded)
  }

  const handleCreateChat = async () => {
    if (creatingChat) return
    setCreatingChat(true)
    try {
      // New chats inside the project must inherit its starting parameters.
      void setProjectExpanded(project.id, true)
      await createProjectChat(project)
      if (isSmallScreen) {
        setShowSidebar(false)
      }
    } catch (error) {
      console.error('Failed to create chat in project:', error)
    } finally {
      setCreatingChat(false)
    }
  }

  const handleEdit = () => {
    setMenuOpened(false)
    void showProjectSettings(project)
  }

  const handleRemove = async () => {
    setMenuOpened(false)
    const confirmed = await NiceModal.show<boolean>('confirm', {
      title: t('Delete project?'),
      message:
        chatCount > 0
          ? t('The project "{{name}}" and its {{count}} chat(s) will be permanently deleted.', {
              name: project.name,
              count: chatCount,
            })
          : t('The project "{{name}}" will be permanently deleted.', { name: project.name }),
      confirmText: t('Delete'),
      danger: true,
    })
    if (confirmed === true) {
      try {
        await deleteProjectWithChats(project.id)
      } catch (error) {
        console.error('Failed to delete project:', error)
      }
    }
  }

  return (
    <>
      <Flex
        data-testid={TestId.sidebar.projectItem}
        data-project-id={project.id}
        align="center"
        gap={10}
        mx="xs"
        pl="xs"
        pr="xs"
        py={8}
        h={36}
        className={clsx(
          'cursor-pointer select-none rounded-lg group/project-item',
          active ? 'bg-chatbox-background-brand-secondary' : 'hover:bg-chatbox-background-gray-secondary'
        )}
        onClick={handleToggleFoldout}
        onContextMenu={handleContextMenu}
      >
        <ScalableIcon
          icon={IconChevronRight}
          size={14}
          className={clsx(
            'shrink-0 text-[var(--chatbox-tint-tertiary)] transition-transform',
            expanded ? 'rotate-90' : ''
          )}
        />
        <ScalableIcon
          icon={IconFolder}
          size={18}
          className={clsx('shrink-0', active ? 'text-chatbox-brand' : 'text-[var(--chatbox-tint-secondary)]')}
        />

        <Text
          span
          flex={1}
          lineClamp={1}
          c={active ? 'chatbox-brand' : 'chatbox-primary'}
          fw={500}
          data-testid={TestId.sidebar.projectTitle}
        >
          {project.name}
        </Text>

        {/* Fixed-size trailing slot: the chat counter and the "+" button are
            stacked absolutely so toggling them on hover never changes the row
            height (which used to shift the surrounding list by a few px). */}
        <Box component="span" w={20} h={20} className="relative shrink-0">
          {chatCount > 0 && (
            <Text
              span
              size="xs"
              c="chatbox-disabled"
              className="tabular-nums opacity-60 absolute inset-0 flex items-center justify-center group-hover/project-item:hidden"
            >
              {chatCount}
            </Text>
          )}

          <Tooltip label={t('New Chat')} openDelay={1000} withArrow>
            <ActionIcon
              data-testid={TestId.sidebar.projectAddChat}
              aria-label={t('New Chat')}
              variant="transparent"
              size={20}
              color="chatbox-tertiary"
              loading={creatingChat}
              className="absolute inset-0 hidden group-hover/project-item:flex"
              onPointerDown={(event) => {
                event.stopPropagation()
              }}
              onClick={(event) => {
                event.stopPropagation()
                void handleCreateChat()
              }}
            >
              <ScalableIcon icon={IconCirclePlus} size={16} />
            </ActionIcon>
          </Tooltip>
        </Box>
      </Flex>

      {menuOpened && (
        <Paper
          ref={menuRef}
          shadow="md"
          radius="md"
          p={4}
          miw={150}
          withBorder
          className="fixed z-[300] border border-solid border-chatbox-border-primary bg-chatbox-background-primary"
          style={{
            left: Math.max(4, Math.min(menuPosition.x, window.innerWidth - 170)),
            top: Math.max(4, Math.min(menuPosition.y, window.innerHeight - 120)),
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            data-testid={TestId.sidebar.projectEdit}
            className="flex w-full items-center gap-2 rounded-lg border-0 bg-transparent px-2 py-2 text-left hover:bg-[var(--mantine-color-gray-0)] dark:hover:bg-[var(--mantine-color-dark-5)]"
            onClick={handleEdit}
          >
            <ScalableIcon icon={IconEdit} size={15} />
            <Text span size="sm" c="chatbox-primary">
              {t('Edit')}
            </Text>
          </button>
          <button
            type="button"
            data-testid={TestId.sidebar.projectRemove}
            className="flex w-full items-center gap-2 rounded-lg border-0 bg-transparent px-2 py-2 text-left hover:bg-[var(--mantine-color-gray-0)] dark:hover:bg-[var(--mantine-color-dark-5)]"
            onClick={() => void handleRemove()}
          >
            <ScalableIcon icon={IconTrash} size={15} />
            <Text span size="sm" c="red">
              {t('Remove')}
            </Text>
          </button>
        </Paper>
      )}
    </>
  )
}

export default ProjectItem
