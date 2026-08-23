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
 * Vector store used by the knowledge base for storing, comparing and
 * searching document embeddings (QDrant via its REST API).
 */
export interface KnowledgeBaseVectorStore {
  readonly provider: 'qdrant'

  /** Create the backing index/collection if it does not exist yet. */
  createIndex(indexName: string, dimension: number): Promise<void>

  /** Store vectors together with their metadata payloads. */
  upsert(indexName: string, vectors: number[][], metadata: Record<string, unknown>[]): Promise<void>

  /** Find the most similar vectors for the given query vector. */
  query(indexName: string, queryVector: number[], topK: number): Promise<KbVectorSearchResult[]>

  /**
   * Verify that the backend server is currently reachable. Resolves silently
   * when it answers; rejects with the failure reason when the connection
   * fails. Used to abort chat requests early instead of failing mid-search.
   */
  checkConnection(): Promise<void>

  /** Drop the whole index/collection. Missing indexes are ignored. */
  deleteIndex(indexName: string): Promise<void>

  /** Delete all vectors belonging to a file. Returns how many were removed. */
  deleteVectorsByFileId(indexName: string, fileId: number): Promise<number>

  /** Fetch chunk contents by (fileId, chunkIndex) pairs. */
  fetchChunksByFileAndChunkIndexes(indexName: string, chunks: KbChunkKey[]): Promise<KbChunkContent[]>

  /**
   * Read the content hash (`fileHash` payload field) recorded for a file.
   * Returns null when the file has no points or the hash is not stored.
   */
  fetchFileHash(indexName: string, fileId: number): Promise<string | null>
}
