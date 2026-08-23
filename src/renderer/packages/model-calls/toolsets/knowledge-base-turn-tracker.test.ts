import { describe, expect, test } from 'vitest'
import type { KnowledgeBaseSearchResult } from '@shared/types'
import { KnowledgeBaseTurnTracker } from './knowledge-base-turn-tracker'

function chunk(fileId: number, text: string): KnowledgeBaseSearchResult {
  return {
    id: `${fileId}-${text}`,
    score: 0.9,
    text,
    fileId,
    filename: `file-${fileId}.pdf`,
    mimeType: 'application/pdf',
    chunkIndex: 0,
  }
}

describe('knowledge base turn tracker', () => {
  test('selectNewChunks skips already sent chunks and records new ones', () => {
    const tracker = new KnowledgeBaseTurnTracker()
    tracker.beginTurn('s1')

    expect(tracker.selectNewChunks('s1', [chunk(1, 'a'), chunk(2, 'b')], 4)).toEqual([chunk(1, 'a'), chunk(2, 'b')])

    // The same chunk (same file + text) is not delivered twice...
    const repeatedSameFile = tracker.selectNewChunks('s1', [chunk(1, 'a'), chunk(3, 'c')], 4)
    expect(repeatedSameFile).toEqual([chunk(3, 'c')])

    // ...while identical text from a different file is a different chunk.
    const crossFile = tracker.selectNewChunks('s1', [chunk(99, 'a')], 4)
    expect(crossFile).toEqual([chunk(99, 'a')])
  })

  test('quota is enforced across queries within one turn', () => {
    const tracker = new KnowledgeBaseTurnTracker()
    tracker.beginTurn('s2')

    expect(tracker.getRemainingQuota('s2', 3)).toBe(3)
    tracker.selectNewChunks('s2', [chunk(1, 'a'), chunk(2, 'b')], 3)
    expect(tracker.getRemainingQuota('s2', 3)).toBe(1)

    // Only one more chunk fits into this turn's budget.
    expect(tracker.selectNewChunks('s2', [chunk(3, 'c'), chunk(4, 'd')], 3)).toEqual([chunk(3, 'c')])
    expect(tracker.getRemainingQuota('s2', 3)).toBe(0)
    expect(tracker.selectNewChunks('s2', [chunk(5, 'e')], 3)).toEqual([])
  })

  test('beginTurn clears duplicates and quota for its session only', () => {
    const tracker = new KnowledgeBaseTurnTracker()
    tracker.beginTurn('s3')
    tracker.selectNewChunks('s3', [chunk(1, 'a')], 1)

    // Another session keeps working in parallel with full budget.
    expect(tracker.getRemainingQuota('s4', 1)).toBe(1)
    expect(tracker.selectNewChunks('s4', [chunk(1, 'a')], 1)).toEqual([chunk(1, 'a')])

    // A fresh turn restores the original session.
    tracker.beginTurn('s3')
    expect(tracker.getRemainingQuota('s3', 1)).toBe(1)
    expect(tracker.getSentHashes('s3')).toEqual([])
    expect(tracker.selectNewChunks('s3', [chunk(1, 'a')], 1)).toEqual([chunk(1, 'a')])
  })

  test('unknown sessions and missing session ids degrade gracefully', () => {
    const tracker = new KnowledgeBaseTurnTracker()
    expect(tracker.getRemainingQuota('unknown', 2)).toBe(2)
    expect(tracker.getSentHashes('unknown')).toEqual([])

    // Without a session id there is no cross-query state: passthrough with cap.
    const chunks = [chunk(1, 'a'), chunk(2, 'b')]
    expect(tracker.selectNewChunks(undefined, chunks, 1)).toEqual([chunk(1, 'a')])
    expect(tracker.getSentHashes('')).toEqual([])
  })
})
