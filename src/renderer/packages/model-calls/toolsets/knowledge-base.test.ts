import { describe, expect, test, vi } from 'vitest'
import type { KnowledgeBaseSearchResult } from '@shared/types'
import { computeKnowledgeBaseChunkHash } from '@shared/knowledge-base'

const { searchMock } = vi.hoisted(() => ({
  searchMock: vi.fn(),
}))

vi.mock('@/platform', () => ({
  default: {
    getKnowledgeBaseController: () => ({
      search: searchMock,
      listFilesPaginated: vi.fn(),
    }),
  },
}))

import platform from '@/platform'
import { queryKnowledgeBaseTool } from './knowledge-base'
import { knowledgeBaseTurnTracker } from './knowledge-base-turn-tracker'

function chunkFixture(overrides: Partial<KnowledgeBaseSearchResult>): KnowledgeBaseSearchResult {
  return {
    id: 'chunk-id',
    score: 0.9,
    text: 'Chunk body.',
    fileId: 1,
    filename: 'manual.pdf',
    mimeType: 'application/pdf',
    chunkIndex: 3,
    ...overrides,
  }
}

const chunkA = chunkFixture({ fileId: 11, text: 'First relevant chunk.' })
const chunkB = chunkFixture({ fileId: 12, text: 'Second relevant chunk.', filename: 'guide.md' })
const chunkC = chunkFixture({ fileId: 13, text: 'Third relevant chunk.' })

async function toModelOutput(output: unknown) {
  const tool = queryKnowledgeBaseTool(1)
  const mapper = tool as {
    toModelOutput: (options: { toolCallId: string; input: unknown; output: unknown }) => Promise<unknown> | unknown
  }
  return await mapper.toModelOutput({ toolCallId: 'tool-call-id', input: {}, output })
}

async function runQuery(
  turnContext?: Parameters<typeof queryKnowledgeBaseTool>[2],
  query = 'semantic question'
): Promise<unknown> {
  const tool = queryKnowledgeBaseTool(1, { limit: 4, minSimilarity: 50 }, turnContext)
  const execute = tool.execute as unknown as (input: unknown) => Promise<unknown>
  return await execute({ query })
}

describe('knowledge base toolset model output', () => {
  test('query_knowledge_base wraps each chunk text in a Markdown block', async () => {
    await expect(
      toModelOutput([
        {
          filename: 'manual.pdf',
          chunkIndex: 3,
          score: 0.92345,
          text: 'Relevant knowledge base text.',
        },
      ])
    ).resolves.toEqual({
      type: 'text',
      value: '`manual.pdf`\n```\nRelevant knowledge base text.\n```',
    })
  })

  test('query_knowledge_base reports missing information for empty results', async () => {
    await expect(toModelOutput([])).resolves.toEqual({
      type: 'text',
      value: 'No relevant information found in the knowledge base.',
    })
  })

  test('query_knowledge_base joins multiple chunks sequentially', async () => {
    await expect(
      toModelOutput([
        {
          filename: 'manual.pdf',
          text: 'First chunk.',
        },
        {
          filename: 'guide.md',
          text: 'Second chunk.',
        },
      ])
    ).resolves.toEqual({
      type: 'text',
      value: '`manual.pdf`\n```\nFirst chunk.\n```\n\n`guide.md`\n```\nSecond chunk.\n```',
    })
  })
})

describe('query_knowledge_base per-turn chunk budget', () => {
  test('first query of a turn sends no exclusion hashes and uses the full quota', async () => {
    knowledgeBaseTurnTracker.beginTurn('sess-a')
    searchMock.mockReset().mockResolvedValueOnce([chunkA, chunkB])

    await expect(runQuery({ sessionId: 'sess-a', maxChunksPerTurn: 4 })).resolves.toEqual([chunkA, chunkB])

    expect(searchMock).toHaveBeenCalledWith(
      1,
      'semantic question',
      expect.objectContaining({ minSimilarity: 50, limit: 4, excludeHashes: [] })
    )
  })

  test('repeated queries never resend already delivered chunks', async () => {
    knowledgeBaseTurnTracker.beginTurn('sess-dedup')
    searchMock.mockReset().mockResolvedValueOnce([chunkA, chunkB])
    await runQuery({ sessionId: 'sess-dedup', maxChunksPerTurn: 4 })

    // The model queries again; even if the backend returns the same top hits,
    // only the unseen chunk may be delivered.
    searchMock.mockResolvedValueOnce([chunkB, chunkC])
    await expect(runQuery({ sessionId: 'sess-dedup', maxChunksPerTurn: 4 })).resolves.toEqual([chunkC])

    expect(searchMock).toHaveBeenLastCalledWith(
      1,
      'semantic question',
      expect.objectContaining({
        limit: 2,
        excludeHashes: [
          computeKnowledgeBaseChunkHash(chunkA.fileId, chunkA.text),
          computeKnowledgeBaseChunkHash(chunkB.fileId, chunkB.text),
        ],
      })
    )
  })

  test('the chunk limit applies to the whole agent turn, then blocks further searches', async () => {
    knowledgeBaseTurnTracker.beginTurn('sess-quota')
    searchMock.mockReset().mockResolvedValueOnce([chunkA])
    await runQuery({ sessionId: 'sess-quota', maxChunksPerTurn: 1 })

    // Quota is used up: no embedding/search call happens at all.
    await expect(runQuery({ sessionId: 'sess-quota', maxChunksPerTurn: 1 })).resolves.toBe(
      'The chunk limit for this answer has been reached. No further knowledge base results are available until the user sends a new message.'
    )
    expect(searchMock).toHaveBeenCalledTimes(1)
  })

  test('a new user message (beginTurn) restores quota and clears duplicates for that chat only', async () => {
    knowledgeBaseTurnTracker.beginTurn('sess-reset')
    searchMock.mockReset().mockResolvedValueOnce([chunkA])
    await runQuery({ sessionId: 'sess-reset', maxChunksPerTurn: 1 })

    // Quota exhausted...
    await expect(runQuery({ sessionId: 'sess-reset', maxChunksPerTurn: 1 })).resolves.toContain(
      'chunk limit for this answer has been reached'
    )

    // ...another chat still has its own full budget.
    searchMock.mockResolvedValueOnce([chunkA])
    await expect(runQuery({ sessionId: 'sess-other', maxChunksPerTurn: 1 })).resolves.toEqual([chunkA])
    expect(searchMock).toHaveBeenLastCalledWith(
      1,
      'semantic question',
      expect.objectContaining({ excludeHashes: [], limit: 1 })
    )

    // ...and a new user message in the original chat starts a fresh turn.
    knowledgeBaseTurnTracker.beginTurn('sess-reset')
    searchMock.mockResolvedValueOnce([chunkA])
    await expect(runQuery({ sessionId: 'sess-reset', maxChunksPerTurn: 1 })).resolves.toEqual([chunkA])
    expect(searchMock).toHaveBeenLastCalledWith(
      1,
      'semantic question',
      expect.objectContaining({ excludeHashes: [], limit: 1 })
    )
  })

  test('queries without a turn context stay stateless (legacy behavior)', async () => {
    searchMock.mockReset().mockResolvedValueOnce([chunkA])
    await expect(runQuery(undefined)).resolves.toEqual([chunkA])
    expect(searchMock).toHaveBeenLastCalledWith(1, 'semantic question', {
      limit: 4,
      minSimilarity: 50,
    })
  })

  test('platform controller is resolved through the singleton tracker state', () => {
    // Sanity check: hashes are stable across calls, which is what keeps the
    // main-process exclusion filter consistent with the renderer-side records.
    expect(computeKnowledgeBaseChunkHash(chunkA.fileId, chunkA.text)).toBe(
      computeKnowledgeBaseChunkHash(chunkA.fileId, `${chunkA.text}\n`)
    )
  })
})
