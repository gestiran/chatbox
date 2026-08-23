import { Collapse, Stack, Text, UnstyledButton } from '@mantine/core'
import { IconChevronRight } from '@tabler/icons-react'
import clsx from 'clsx'
import { useState, type ReactNode } from 'react'
import { ScalableIcon } from './ScalableIcon'

interface Props {
  /** Section title rendered on the foldout header row. */
  title: ReactNode
  /** Controlled open state. Omit to let the component keep its own state. */
  open?: boolean
  /** Initial open state when uncontrolled. */
  defaultOpen?: boolean
  /** Called with the next open state right after a toggle. */
  onToggle?: (open: boolean) => void
  /** Short hint shown at the trailing edge of the header, e.g. a selection count. */
  summary?: ReactNode
  children: ReactNode
}

/**
 * Collapsible section with a chevron foldout header, matching the sidebar's
 * project foldout look. Used to keep secondary settings blocks compact.
 */
export function Foldout({ title, open, defaultOpen = false, onToggle, summary, children }: Props) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen)
  const isOpen = open ?? internalOpen

  const handleToggle = () => {
    const next = !isOpen
    if (open === undefined) {
      setInternalOpen(next)
    }
    onToggle?.(next)
  }

  return (
    <div>
      <UnstyledButton
        onClick={handleToggle}
        aria-expanded={isOpen}
        className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-left hover:bg-[var(--chatbox-background-tertiary)]"
      >
        <ScalableIcon
          icon={IconChevronRight}
          size={14}
          className={clsx('shrink-0 text-[var(--chatbox-tint-tertiary)] transition-transform', isOpen && 'rotate-90')}
        />
        <Text fw={700} className="min-w-0" truncate>
          {title}
        </Text>
        {summary != null && (
          <Text size="sm" c="dimmed" ml="auto" className="min-w-0 shrink-0" truncate>
            {summary}
          </Text>
        )}
      </UnstyledButton>
      <Collapse in={isOpen}>
        <Stack gap="xs" pl={24} pt={6}>
          {children}
        </Stack>
      </Collapse>
    </div>
  )
}

export default Foldout
