import type { DragEndEvent } from '@dnd-kit/core'
import {
  closestCenter,
  DndContext,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button, Flex, Text } from '@mantine/core'
import type { Project, SessionMetaRecord } from '@shared/types'
import { areSessionsInSamePinGroup } from '@shared/utils/session-sort'
import { IconArrowsMoveVertical, IconGripVertical, IconLoader2 } from '@tabler/icons-react'
import { useRouterState } from '@tanstack/react-router'
import { type CSSProperties, type MutableRefObject, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso } from 'react-virtuoso'
import { useIsSmallScreen } from '@/hooks/useScreenChange'
import platform from '@/platform'
import { useSessionList } from '@/stores/chatStore'
import {
  isProjectExpandedById,
  loadProjects,
  moveSessionIntoProject,
  reorderProjects,
  reorderSessionsInScope,
  useProjects,
} from '@/stores/projectStore'
import ProjectItem from './ProjectItem'
import SessionItem from './SessionItem'

export interface Props {
  sessionListViewportRef: MutableRefObject<HTMLDivElement | null>
}

/** Sortable-id prefix distinguishing projects from chats in the shared DnD context. */
const PROJECT_ITEM_ID_PREFIX = 'project:'
const projectIdToItemId = (projectId: string) => `${PROJECT_ITEM_ID_PREFIX}${projectId}`
const itemIdToProjectId = (itemId: string) => itemId.slice(PROJECT_ITEM_ID_PREFIX.length)
const isProjectItemId = (itemId: string) => itemId.startsWith(PROJECT_ITEM_ID_PREFIX)

type SessionListItem =
  | { type: 'section'; id: string; label: string }
  | { type: 'session'; id: string; session: SessionMetaRecord; nestedInProject?: boolean }
  | { type: 'project'; id: string; project: Project; chatCount: number; expanded: boolean }

function SessionListLoadingFooter() {
  return (
    <Flex justify="center" py="xs">
      <IconLoader2 size={16} className="animate-spin" style={{ color: 'var(--mantine-color-dimmed)' }} />
    </Flex>
  )
}

export default function SessionList(props: Props) {
  const { t } = useTranslation()
  const { sessionMetaList: sortedSessions, fetchNextPage, hasNextPage, isFetchingNextPage } = useSessionList()
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const [isReordering, setIsReordering] = useState(false)
  const isSmallScreen = useIsSmallScreen()

  const projects = useProjects()
  useEffect(() => {
    loadProjects().catch((error) => {
      console.warn('Failed to load projects:', error)
    })
  }, [])

  const touchSensor = useSensor(TouchSensor, {
    activationConstraint: {
      delay: 150,
      tolerance: 8,
    },
  })
  const mouseSensor = useSensor(MouseSensor, {
    activationConstraint: {
      distance: 10,
    },
  })
  const keyboardSensor = useSensor(KeyboardSensor, {
    coordinateGetter: sortableKeyboardCoordinates,
  })
  const sensors = useSensors(...(!isSmallScreen || isReordering ? [touchSensor] : []), mouseSensor, keyboardSensor)

  const onDragStart = (event: DragStartEvent) => {
    setActiveDragId(String(event.active.id))
  }
  const onDragEnd = async (event: DragEndEvent) => {
    setActiveDragId(null)
    if (!event.over || !sortedSessions) {
      return
    }
    const activeId = String(event.active.id)
    const overId = String(event.over.id)
    if (activeId === overId) {
      return
    }

    // Project rows reorder among themselves.
    if (isProjectItemId(activeId)) {
      if (!isProjectItemId(overId)) {
        return
      }
      await reorderProjects(itemIdToProjectId(activeId), itemIdToProjectId(overId))
      return
    }

    const activeSession = sortedSessions.find((s) => s.id === activeId)
    const overSession = !isProjectItemId(overId) ? sortedSessions.find((s) => s.id === overId) : undefined

    // Dropping a chat onto a project header moves it into that project.
    if (isProjectItemId(overId)) {
      await moveSessionIntoProject(activeId, itemIdToProjectId(overId))
      return
    }
    if (!overSession) {
      return
    }

    const activeProjectId = activeSession?.projectId ?? null
    const overProjectId = overSession.projectId ?? null
    if (activeProjectId !== overProjectId) {
      // Cross-scope drop: join the target scope next to the hovered chat.
      await moveSessionIntoProject(activeId, overProjectId, overId)
      return
    }

    // Root-level reorder keeps the pin-group rule; chats inside a project sort freely.
    if (!activeProjectId && !areSessionsInSamePinGroup(activeSession, overSession)) {
      return
    }
    await reorderSessionsInScope(activeId, overId)
  }
  const onDragCancel = () => {
    setActiveDragId(null)
  }

  const { rootSessions, sessionsByProjectId } = useMemo(() => {
    const byProject = new Map<string, SessionMetaRecord[]>()
    const root: SessionMetaRecord[] = []
    for (const session of sortedSessions ?? []) {
      if (session.projectId) {
        const list = byProject.get(session.projectId) ?? []
        list.push(session)
        byProject.set(session.projectId, list)
      } else {
        root.push(session)
      }
    }
    return { rootSessions: root, sessionsByProjectId: byProject }
  }, [sortedSessions])

  const displayItems = useMemo<SessionListItem[]>(() => {
    const items: SessionListItem[] = []

    // Projects are always rendered above every chat in the list.
    for (const project of projects) {
      const projectChats = sessionsByProjectId.get(project.id) ?? []
      const expanded = isProjectExpandedById(project.id)
      items.push({
        type: 'project',
        id: projectIdToItemId(project.id),
        project,
        chatCount: projectChats.length,
        expanded,
      })
      if (expanded) {
        items.push(
          ...projectChats.map((session) => ({
            type: 'session' as const,
            id: session.id,
            session,
            nestedInProject: true,
          }))
        )
      }
    }

    const pinnedSessions = rootSessions.filter((session) => session.starred)
    const otherSessions = rootSessions.filter((session) => !session.starred)
    if (pinnedSessions.length > 0) {
      items.push({ type: 'section', id: 'section:pinned', label: t('Pinned') })
      items.push(...pinnedSessions.map((session) => ({ type: 'session' as const, id: session.id, session })))
      if (otherSessions.length > 0) {
        items.push({ type: 'section', id: 'section:chats', label: t('Chats') })
      }
    }
    items.push(...otherSessions.map((session) => ({ type: 'session' as const, id: session.id, session })))

    return items
  }, [rootSessions, projects, sessionsByProjectId, t])

  const sortableItemIds = useMemo(
    () =>
      displayItems
        .filter((item): item is Exclude<SessionListItem, { type: 'section' }> => item.type !== 'section')
        .map((item) => item.id),
    [displayItems]
  )

  const activeDragItem = useMemo(() => {
    if (!activeDragId) return undefined
    return displayItems.find((item) => item.type !== 'section' && item.id === activeDragId)
  }, [activeDragId, displayItems])

  const routerState = useRouterState()
  const onEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage()
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])
  const virtuosoComponents = useMemo(
    () =>
      hasNextPage
        ? {
            Footer: SessionListLoadingFooter,
          }
        : {},
    [hasNextPage]
  )

  return (
    <DndContext
      modifiers={[restrictToVerticalAxis]}
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      {(Boolean(sortedSessions) || projects.length > 0) && (
        <SortableContext items={sortableItemIds} strategy={verticalListSortingStrategy}>
          {isSmallScreen && isReordering && (
            <Flex
              align="center"
              justify="space-between"
              mx="xs"
              mb={2}
              px="xs"
              py={6}
              className="rounded-sm bg-chatbox-background-gray-secondary"
            >
              <Flex align="center" gap={6}>
                <IconArrowsMoveVertical size={16} className="text-chatbox-tertiary" />
                <Text size="sm" fw={500} c="chatbox-secondary">
                  {t('Adjust order')}
                </Text>
              </Flex>
              <Button variant="subtle" size="compact-sm" onClick={() => setIsReordering(false)}>
                {t('Done')}
              </Button>
            </Flex>
          )}
          <Virtuoso
            style={{
              flex: 1,
              ...(platform.type === 'web'
                ? {
                    userSelect: 'none',
                    WebkitUserSelect: 'none',
                    WebkitTouchCallout: 'none',
                  }
                : {}),
            }}
            data={displayItems}
            computeItemKey={(_index, item) => item.id}
            scrollerRef={(ref) => {
              if (ref instanceof HTMLDivElement) {
                props.sessionListViewportRef.current = ref
              }
            }}
            endReached={onEndReached}
            components={virtuosoComponents}
            itemContent={(_index, item) => {
              if (item.type === 'section') {
                return (
                  <Text px="md" pt="sm" pb={4} size="xs" fw={600} c="chatbox-tertiary">
                    {item.label}
                  </Text>
                )
              }

              if (item.type === 'project') {
                return (
                  <SortableItem
                    id={item.id}
                    disabled={Boolean(isSmallScreen && !isReordering)}
                    showDragHandle={Boolean(isSmallScreen && isReordering)}
                    dragHandleLabel={t('Adjust order') || undefined}
                  >
                    <ProjectItem project={item.project} chatCount={item.chatCount} expanded={item.expanded} />
                  </SortableItem>
                )
              }

              return (
                <SortableItem
                  id={item.session.id}
                  disabled={Boolean(isSmallScreen && !isReordering)}
                  showDragHandle={Boolean(isSmallScreen && isReordering)}
                  dragHandleLabel={t('Adjust order') || undefined}
                >
                  <div className={item.nestedInProject ? 'ps-xl' : undefined}>
                    <SessionItem
                      selected={routerState.location.pathname === `/session/${item.session.id}`}
                      session={item.session}
                      isReordering={Boolean(isSmallScreen && isReordering)}
                      onStartReordering={() => setIsReordering(true)}
                    />
                  </div>
                </SortableItem>
              )
            }}
          />
          <DragOverlay dropAnimation={null}>
            {activeDragItem?.type === 'session' ? (
              <div className="pointer-events-none">
                <div className={activeDragItem.nestedInProject ? 'ps-xl' : undefined}>
                  <SessionItem
                    selected={routerState.location.pathname === `/session/${activeDragItem.session.id}`}
                    session={activeDragItem.session}
                    isReordering={Boolean(isSmallScreen && isReordering)}
                  />
                </div>
              </div>
            ) : activeDragItem?.type === 'project' ? (
              <div className="pointer-events-none">
                <ProjectItem project={activeDragItem.project} chatCount={activeDragItem.chatCount} expanded={false} />
              </div>
            ) : null}
          </DragOverlay>
        </SortableContext>
      )}
    </DndContext>
  )
}

function SortableItem(props: {
  id: string
  children?: React.ReactNode
  disabled?: boolean
  showDragHandle?: boolean
  dragHandleLabel?: string
}) {
  const { id, children, disabled = false, showDragHandle = false, dragHandleLabel } = props
  const { attributes, isDragging, listeners, setActivatorNodeRef, setNodeRef, transform, transition } = useSortable({
    id,
    disabled,
  })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : undefined,
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className="relative pb-1"
      {...(!disabled && !showDragHandle ? attributes : {})}
      {...(!disabled && !showDragHandle ? listeners : {})}
    >
      {children}
      {showDragHandle && (
        <button
          ref={setActivatorNodeRef}
          type="button"
          aria-label={dragHandleLabel}
          className="absolute right-3 top-1/2 flex size-8 -translate-y-1/2 touch-none items-center justify-center rounded-sm border-0 bg-transparent text-chatbox-tertiary active:cursor-grabbing"
          onClick={(event) => event.stopPropagation()}
          {...attributes}
          {...listeners}
        >
          <IconGripVertical size={18} />
        </button>
      )}
    </div>
  )
}
