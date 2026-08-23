import type { KnowledgeBaseVectorStoreProvider } from '../../../shared/types/settings'

export type { KnowledgeBaseVectorStoreProvider }

export interface KbVectorSearchResult {
  id: string
  score: number
  metadata: Record<string, unknown>
}

export interface KbChunkKey {
  fileId: number
  chunkIndex: number
}

export interface KbChunkContent {
  fileId: number | string
  filename?: string
  chunkIndex: number | string
  text?: string
}

/**
 * Provider-agnostic vector store used by the knowledge base for storing,
 * comparing and searching document embeddings.
 *
 * Each provider keeps its own data: documents ingested through one provider
 * are never visible to the other one.
 */
export interface KnowledgeBaseVectorStore {
  readonly provider: KnowledgeBaseVectorStoreProvider

  /** Create the backing index/collection if it does not exist yet. */
  createIndex(indexName: string, dimension: number): Promise<void>

  /** Store vectors together with their metadata payloads. */
  upsert(indexName: string, vectors: number[][], metadata: Record<string, unknown>[]): Promise<void>

  /** Find the most similar vectors for the given query vector. */
  query(indexName: string, queryVector: number[], topK: number): Promise<KbVectorSearchResult[]>

  /** Drop the whole index/collection. Missing indexes are ignored. */
  deleteIndex(indexName: string): Promise<void>

  /** Delete all vectors belonging to a file. Returns how many were removed. */
  deleteVectorsByFileId(indexName: string, fileId: number): Promise<number>

  /** Fetch chunk contents by (fileId, chunkIndex) pairs. */
  fetchChunksByFileAndChunkIndexes(indexName: string, chunks: KbChunkKey[]): Promise<KbChunkContent[]>
}
