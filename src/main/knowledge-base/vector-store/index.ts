import { getVectorStore } from '../db'
import { getSettings } from '../../store-node'
import { getLogger } from '../../util'
import { LibsqlKnowledgeBaseVectorStore } from './libsql'
import { QdrantKnowledgeBaseVectorStore } from './qdrant'
import type { KnowledgeBaseVectorStore, KnowledgeBaseVectorStoreProvider } from './types'

export * from './types'

const log = getLogger('knowledge-base:vector-store')

// Cached QDrant client so we do not recreate it on every operation. The cache
// is keyed by URL: changing the URL in the settings creates a fresh client.
let cachedQdrant: { url: string; store: QdrantKnowledgeBaseVectorStore } | null = null

/**
 * Resolve the currently selected vector store provider from the settings.
 */
export function getKnowledgeBaseVectorStoreProvider(): KnowledgeBaseVectorStoreProvider {
  const settings = getSettings()
  return settings.extension?.knowledgeBase?.vectorStore?.provider === 'qdrant' ? 'qdrant' : 'default'
}

/**
 * Resolve the configured QDrant URL from the settings.
 * Returns null when the default (built-in) provider should be used.
 */
function resolveQdrantUrl(): string | null {
  if (getKnowledgeBaseVectorStoreProvider() !== 'qdrant') {
    return null
  }
  const settings = getSettings()
  return (settings.extension?.knowledgeBase?.vectorStore?.qdrantUrl ?? '').trim()
}

/**
 * Return the active knowledge base vector store based on the user's provider
 * selection in Settings / Knowledge Base.
 *
 * - `default`: built-in local LibSQL store (previous behaviour).
 * - `qdrant`: external QDrant server accessed through its REST API.
 *
 * Providers work in parallel and do not share data: documents ingested while
 * one provider is selected are only stored in (and searched from) that
 * provider's storage.
 */
export function getKnowledgeBaseVectorStore(): KnowledgeBaseVectorStore {
  const qdrantUrl = resolveQdrantUrl()
  if (qdrantUrl === null) {
    return new LibsqlKnowledgeBaseVectorStore(getVectorStore())
  }

  if (!qdrantUrl) {
    log.error('[VECTOR_STORE] QDrant provider is selected but no URL is configured')
    throw new Error(
      'QDrant vector store is selected but no server URL is configured. Set it in Settings / Knowledge Base.'
    )
  }

  if (!cachedQdrant || cachedQdrant.url !== qdrantUrl) {
    log.info(`[VECTOR_STORE] Using QDrant vector store at ${qdrantUrl}`)
    cachedQdrant = { url: qdrantUrl, store: new QdrantKnowledgeBaseVectorStore(qdrantUrl) }
  }
  return cachedQdrant.store
}
