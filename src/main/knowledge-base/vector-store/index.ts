import { getSettings } from '../../store-node'
import { getLogger } from '../../util'
import { QdrantKnowledgeBaseVectorStore } from './qdrant'
import type { KnowledgeBaseVectorStore } from './types'

export * from './types'

const log = getLogger('knowledge-base:vector-store')

// Local QDrant used when no explicit URL is configured.
export const DEFAULT_QDRANT_URL = 'http://127.0.0.1:6333'

// Cached QDrant client so we do not recreate it on every operation. The cache
// is keyed by URL: changing the URL in the settings creates a fresh client.
let cachedQdrant: { url: string; store: QdrantKnowledgeBaseVectorStore } | null = null

/**
 * Resolve the QDrant URL from the settings.
 *
 * - Empty/missing value falls back to the local instance at 127.0.0.1:6333.
 * - A bare host:port without a scheme gets 'http://' prepended (fetch requires
 *   an absolute URL).
 */
export function resolveQdrantUrl(): string {
  const settings = getSettings()
  const rawUrl = (settings.extension?.knowledgeBase?.vectorStore?.qdrantUrl ?? '').trim()
  if (!rawUrl) {
    return DEFAULT_QDRANT_URL
  }
  return /^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`
}

/**
 * Return the knowledge base vector store: an external QDrant server accessed
 * through its official REST API. This is the only supported storage backend.
 */
export function getKnowledgeBaseVectorStore(): KnowledgeBaseVectorStore {
  const qdrantUrl = resolveQdrantUrl()
  if (!cachedQdrant || cachedQdrant.url !== qdrantUrl) {
    log.info(`[VECTOR_STORE] Using QDrant vector store at ${qdrantUrl}`)
    cachedQdrant = { url: qdrantUrl, store: new QdrantKnowledgeBaseVectorStore(qdrantUrl) }
  }
  return cachedQdrant.store
}
