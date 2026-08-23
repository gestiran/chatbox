import type { KnowledgeBaseSearchResult } from '@shared/types'
import { computeKnowledgeBaseChunkHash } from '@shared/knowledge-base'

/**
 * Per-chat tracking of knowledge-base chunks already sent to the model during
 * the current agent turn (the span between two user messages).
 *
 * Purpose:
 * - never deliver the same chunk twice within one turn, even when a repeated
 *   query matches it above the similarity threshold;
 * - enforce the "chunk limit" setting as a budget for the whole agent turn,
 *   not per single query.
 *
 * State is keyed by chat session id, so parallel chats in different windows do
 * not interfere. `beginTurn()` is called every time the user sends a message in
 * that specific chat and clears only that chat's state.
 */

interface KnowledgeBaseTurnState {
  /** Hashes of chunks already delivered to the model in this turn. */
  sentHashes: Set<string>
  /** How many chunks were delivered in this turn. */
  sentCount: number
  updatedAt: number
}

const MAX_TRACKED_SESSIONS = 200
const STALE_SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

export class KnowledgeBaseTurnTracker {
  private turns = new Map<string, KnowledgeBaseTurnState>()

  /**
   * Start a fresh agent turn for the given chat: clears the duplicate list and
   * restores the full chunk quota. Called when the user sends a message in
   * this chat; other chats keep their state.
   */
  beginTurn(sessionId: string): void {
    if (!sessionId) return
    this.turns.set(sessionId, { sentHashes: new Set(), sentCount: 0, updatedAt: Date.now() })
    this.prune()
  }

  /** Hashes already sent during the current turn (empty when no turn is active). */
  getSentHashes(sessionId: string): string[] {
    const state = this.turns.get(sessionId)
    return state ? [...state.sentHashes] : []
  }

  /** How many more chunks may be sent during the current turn. */
  getRemainingQuota(sessionId: string, maxChunksPerTurn: number): number {
    const state = this.turns.get(sessionId)
    if (!state) return Math.max(0, maxChunksPerTurn)
    return Math.max(0, maxChunksPerTurn - state.sentCount)
  }

  /**
   * From `chunks` (already filtered by similarity), select those not yet sent
   * during this turn, up to the remaining per-turn quota. Selected chunks are
   * recorded as sent. Without a session id the tracker is a no-op passthrough.
   */
  selectNewChunks(
    sessionId: string | undefined,
    chunks: KnowledgeBaseSearchResult[],
    maxChunksPerTurn: number
  ): KnowledgeBaseSearchResult[] {
    if (!sessionId) return chunks.slice(0, Math.max(0, maxChunksPerTurn))

    let state = this.turns.get(sessionId)
    if (!state) {
      state = { sentHashes: new Set(), sentCount: 0, updatedAt: Date.now() }
      this.turns.set(sessionId, state)
      this.prune()
    }

    const selected: KnowledgeBaseSearchResult[] = []
    for (const chunk of chunks) {
      if (state.sentCount >= maxChunksPerTurn) break
      const hash = computeKnowledgeBaseChunkHash(chunk.fileId, chunk.text)
      if (state.sentHashes.has(hash)) continue
      state.sentHashes.add(hash)
      state.sentCount += 1
      selected.push(chunk)
    }
    state.updatedAt = Date.now()
    return selected
  }

  /** Drop stale sessions and cap the map size so long-running apps don't leak. */
  private prune(): void {
    const now = Date.now()
    for (const [sessionId, state] of this.turns) {
      if (now - state.updatedAt > STALE_SESSION_TTL_MS) {
        this.turns.delete(sessionId)
      }
    }
    if (this.turns.size <= MAX_TRACKED_SESSIONS) return
    const oldestFirst = [...this.turns.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    for (const [sessionId] of oldestFirst.slice(0, this.turns.size - MAX_TRACKED_SESSIONS)) {
      this.turns.delete(sessionId)
    }
  }
}

/** Singleton shared by all chat windows. */
export const knowledgeBaseTurnTracker = new KnowledgeBaseTurnTracker()
