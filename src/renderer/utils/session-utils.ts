import type { Message, Session, SessionMeta, SessionMetaRecord } from '@shared/types'
import { mapValues } from 'lodash'
import { finalizeStaleGeneratingMessage, migrateMessage } from '../../shared/utils/message'

// Also finalizes messages a crash/reload left flagged `generating` — otherwise
// they spin forever in the UI and are silently dropped from every model context.
function loadMessage(message: Parameters<typeof migrateMessage>[0]) {
  return finalizeStaleGeneratingMessage(migrateMessage(message))
}

// The "Forked from conversation" marker was a UI-only assistant message that
// sat at the end of a duplicated session. It leaked into model context and
// corrupted the last-turn grouping (the reported "empty branch" / "message sent
// ignoring the last turn" bugs). The feature is removed, so strip any marker a
// session still carries on load; it is a pure removal that never re-points
// compaction boundaries (a marker was never a boundary message).
function withoutForkMarkers(messages: Message[] | undefined): Message[] {
  return (messages ?? []).filter((message) => !message.isForkMarker).map((message) => loadMessage(message))
}

export function migrateSession(session: Session): Session {
  return {
    ...session,
    settings: {
      // temperature未设置的时候使用默认值undefined，这样才能覆盖全局设置
      temperature: undefined,
      ...session.settings,
    },
    messages: withoutForkMarkers(session.messages),
    threads: session.threads?.map((t) => ({
      ...t,
      messages: withoutForkMarkers(t.messages),
    })),
    messageForksHash: mapValues(session.messageForksHash || {}, (forks) => ({
      ...forks,
      lists:
        forks.lists?.map((list) => ({
          ...list,
          messages: withoutForkMarkers(list.messages),
        })) || [],
    })),
  }
}

// Single source shared with the native mobile shell.
import { sortSessions } from '@shared/utils/session-sort'

export { sortSessions }

export function createSessionMetaRecordsFromLegacyList(sessions: SessionMeta[], now = Date.now()): SessionMetaRecord[] {
  const sortedVisibleSessions = sortSessions(sessions)
  const sortOrderById = new Map(sortedVisibleSessions.map((session, i) => [session.id, now - i * 1000]))
  const hiddenSortOrderStart = now - sortedVisibleSessions.length * 1000

  return sessions.map((session, i) => ({
    ...session,
    sortOrder: sortOrderById.get(session.id) ?? hiddenSortOrderStart - i * 1000,
    createdAt: now - i * 1000,
  }))
}
