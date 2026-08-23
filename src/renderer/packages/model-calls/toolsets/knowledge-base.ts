import { jsonSchema, type ToolSet } from 'ai'
import { KNOWLEDGE_BASE_DEFAULT_SEARCH_LIMIT } from '@shared/knowledge-base'
import type { KnowledgeBaseSearchOptions } from '@shared/types'
import platform from '@/platform'
import { asRecord, contentOrErrorText, stringField, toTextModelOutput } from './model-output'
import { knowledgeBaseTurnTracker } from './knowledge-base-turn-tracker'

/**
 * Identifies the agent turn (the span between two user messages) a query
 * belongs to. Enables per-turn chunk de-duplication and the per-turn chunk
 * quota; state is tracked separately for each chat session.
 */
export interface KnowledgeBaseQueryTurnContext {
  sessionId?: string
  /** Maximum number of chunks the model may receive per agent turn (Settings / Knowledge Base). */
  maxChunksPerTurn?: number
}

/** Message shown when every matching chunk was already delivered in this turn's budget. */
const CHUNK_QUOTA_EXHAUSTED_MESSAGE =
  'The chunk limit for this answer has been reached. No further knowledge base results are available until the user sends a new message.'

function formatSearchResults(output: unknown): string {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return contentOrErrorText(output)
  if (output.length === 0) {
    return 'No relevant information found in the knowledge base.'
  }
  // Plain Markdown output: only the source filename and the chunk text,
  // one block per chunk, without any extra metadata or JSON.
  return output
    .map((item) => {
      const record = asRecord(item)
      if (!record) return String(item)
      const filename = stringField(record, 'filename') ?? stringField(record, 'fileName') ?? 'Unknown file'
      const text = stringField(record, 'text') ?? ''
      return [`\`${filename}\``, '```', text, '```'].join('\n')
    })
    .join('\n\n')
}

export const queryKnowledgeBaseTool = (
  kbId: number,
  searchOptions?: KnowledgeBaseSearchOptions,
  turnContext?: KnowledgeBaseQueryTurnContext
): ToolSet[string] => {
  return {
    description: `Search the knowledge base with a semantic query. Returns relevant document chunks.

Call this when the user's question is related to the attached documents and searching would help you answer more accurately. For greetings, chit-chat, or questions clearly unrelated to the knowledge base, answer directly. For follow-up questions on the same topic, reuse earlier results when they still apply.`,
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query - rephrase the user question for better semantic matching',
        },
      },
      required: ['query'],
      additionalProperties: false,
    }),
    execute: async (input) => {
      const queryInput = input as { query: string }
      const knowledgeBaseController = platform.getKnowledgeBaseController()
      // Search tuning comes from Settings / Knowledge Base.
      const sessionId = turnContext?.sessionId
      const maxChunksPerTurn =
        turnContext?.maxChunksPerTurn ?? searchOptions?.limit ?? KNOWLEDGE_BASE_DEFAULT_SEARCH_LIMIT

      if (!sessionId) {
        return await knowledgeBaseController.search(kbId, queryInput.query, searchOptions)
      }

      // The chunk limit is a budget for the whole agent turn, not per query:
      // ask only for fresh (not yet sent) chunks within the remaining quota.
      const remainingQuota = knowledgeBaseTurnTracker.getRemainingQuota(sessionId, maxChunksPerTurn)
      if (remainingQuota <= 0) {
        return CHUNK_QUOTA_EXHAUSTED_MESSAGE
      }

      const results = await knowledgeBaseController.search(kbId, queryInput.query, {
        minSimilarity: searchOptions?.minSimilarity,
        limit: remainingQuota,
        excludeHashes: knowledgeBaseTurnTracker.getSentHashes(sessionId),
      })
      // Records the selected chunks so repeated queries never resend them.
      return knowledgeBaseTurnTracker.selectNewChunks(sessionId, results, maxChunksPerTurn)
    },
    toModelOutput: toTextModelOutput(formatSearchResults),
  }
}

async function getToolSetDescription(knowledgeBaseId: number, knowledgeBaseName: string) {
  // 预加载文件列表，让模型知道知识库中有什么文件
  const knowledgeBaseController = platform.getKnowledgeBaseController()
  const files = await knowledgeBaseController.listFilesPaginated(knowledgeBaseId, 0, 50)
  const doneFiles = files.filter((f) => f.status === 'done')
  const fileListStr =
    doneFiles.length > 0 ? doneFiles.map((f) => `- "${f.filename}"`).join('\n') : '(No files available yet)'

  return `
## Knowledge Base: "${knowledgeBaseName}"

You have access to a knowledge base containing these documents:

${fileListStr}

### Tools:
- **query_knowledge_base** - Semantic search over the documents. Returns relevant document chunks as Markdown blocks.

### When to search:
- Search when the user's question is related to these documents and searching would help you answer accurately.
- For greetings, small talk, or questions clearly unrelated to the knowledge base, answer directly without searching.
- For follow-ups on the same topic, reuse earlier results; re-search when the topic meaningfully shifts or earlier results don't cover the new question.
`
}

export async function getToolSet(
  knowledgeBaseId: number,
  knowledgeBaseName: string,
  searchOptions?: KnowledgeBaseSearchOptions,
  turnContext?: KnowledgeBaseQueryTurnContext
) {
  return {
    description: await getToolSetDescription(knowledgeBaseId, knowledgeBaseName),
    tools: {
      query_knowledge_base: queryKnowledgeBaseTool(knowledgeBaseId, searchOptions, turnContext),
    },
  }
}
