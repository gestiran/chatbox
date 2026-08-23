import { randomUUID } from 'node:crypto'
import { getLogger } from '../../util'
import type { KbChunkContent, KbChunkKey, KbVectorSearchResult, KnowledgeBaseVectorStore } from './types'

const log = getLogger('knowledge-base:vector-store:qdrant')

const REQUEST_TIMEOUT_MS = 30_000

/** Error thrown for non-successful QDrant API responses. */
export class QdrantApiError extends Error {
  readonly statusCode: number

  constructor(message: string, statusCode: number) {
    super(message)
    this.name = 'QdrantApiError'
    this.statusCode = statusCode
  }
}

interface QdrantEnvelope<T> {
  result?: T
  status?: string
}

interface QdrantPoint {
  id: string | number
  payload?: Record<string, unknown> | null
}

interface QdrantScoredPoint extends QdrantPoint {
  score: number
}

/**
 * Vector store implementation backed by an external QDrant server.
 *
 * All communication is done directly against the official QDrant REST API:
 * https://api.qdrant.tech/api-reference
 */
export class QdrantKnowledgeBaseVectorStore implements KnowledgeBaseVectorStore {
  readonly provider = 'qdrant'

  private readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  // ---- Low level API access -------------------------------------------------

  private async request<T>(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<QdrantEnvelope<T>> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to reach QDrant server at ${this.baseUrl}: ${reason}`)
    }

    const rawBody = await response.text()
    let payload: QdrantEnvelope<T> | undefined
    try {
      payload = rawBody ? (JSON.parse(rawBody) as QdrantEnvelope<T>) : undefined
    } catch {
      // Non-JSON body - handled by the status check below.
    }

    if (!response.ok) {
      const detail = payload ? JSON.stringify(payload) : rawBody.slice(0, 500)
      throw new QdrantApiError(
        `QDrant API error (${response.status} ${response.statusText}) on ${method} ${path}: ${detail}`,
        response.status
      )
    }

    return payload ?? {}
  }

  async collectionExists(collectionName: string): Promise<boolean> {
    try {
      await this.request('GET', `/collections/${encodeURIComponent(collectionName)}`)
      return true
    } catch (error) {
      if (error instanceof QdrantApiError && error.statusCode === 404) {
        return false
      }
      throw error
    }
  }

  // ---- KnowledgeBaseVectorStore --------------------------------------------

  async createIndex(indexName: string, dimension: number): Promise<void> {
    // PUT /collections/{collection_name} - create the collection with the
    // vector configuration matching our embedding dimension.
    if (await this.collectionExists(indexName)) {
      log.debug(`[QDRANT] Collection already exists: ${indexName}`)
      return
    }
    await this.request('PUT', `/collections/${encodeURIComponent(indexName)}`, {
      vectors: { size: dimension, distance: 'Cosine' },
    })
    log.info(`[QDRANT] Created collection: ${indexName} (dimension=${dimension})`)
  }

  async upsert(indexName: string, vectors: number[][], metadata: Record<string, unknown>[]): Promise<void> {
    // PUT /collections/{collection_name}/points?wait=true - upload points.
    // Point ids must be unsigned integers or UUIDs, so every chunk gets a
    // fresh UUID and carries its metadata inside the point payload.
    const points = vectors.map((vector, i) => ({
      id: randomUUID(),
      vector,
      payload: metadata[i] ?? {},
    }))
    await this.request('PUT', `/collections/${encodeURIComponent(indexName)}/points?wait=true`, { points })
    log.debug(`[QDRANT] Upserted ${points.length} points into ${indexName}`)
  }

  async query(indexName: string, queryVector: number[], topK: number): Promise<KbVectorSearchResult[]> {
    // POST /collections/{collection_name}/points/query - similarity search.
    const result = await this.request<{ points?: QdrantScoredPoint[] }>(
      'POST',
      `/collections/${encodeURIComponent(indexName)}/points/query`,
      {
        query: queryVector,
        limit: topK,
        with_payload: true,
      }
    )
    return (result.result?.points ?? []).map((point) => ({
      id: String(point.id),
      score: point.score,
      metadata: point.payload ?? {},
    }))
  }

  async deleteIndex(indexName: string): Promise<void> {
    // DELETE /collections/{collection_name}
    if (!(await this.collectionExists(indexName))) {
      log.debug(`[QDRANT] Collection does not exist, nothing to delete: ${indexName}`)
      return
    }
    await this.request('DELETE', `/collections/${encodeURIComponent(indexName)}`)
    log.info(`[QDRANT] Deleted collection: ${indexName}`)
  }

  async deleteVectorsByFileId(indexName: string, fileId: number): Promise<number> {
    const filter = {
      must: [{ key: 'fileId', match: { value: fileId } }],
    }

    // POST /collections/{collection_name}/points/count - count matched points first.
    const countResult = await this.request<{ count?: number }>(
      'POST',
      `/collections/${encodeURIComponent(indexName)}/points/count`,
      { filter, exact: true }
    )
    const count = Number(countResult.result?.count ?? 0)

    if (count > 0) {
      // POST /collections/{collection_name}/points/delete?wait=true - remove by filter.
      await this.request('POST', `/collections/${encodeURIComponent(indexName)}/points/delete?wait=true`, {
        filter,
      })
      log.info(`[QDRANT] Deleted ${count} points of fileId=${fileId} from ${indexName}`)
    }
    return count
  }

  async fetchChunksByFileAndChunkIndexes(indexName: string, chunks: KbChunkKey[]): Promise<KbChunkContent[]> {
    if (!chunks || chunks.length === 0) {
      return []
    }

    // POST /collections/{collection_name}/points/scroll - fetch payloads that
    // match any of the requested (fileId, chunkIndex) pairs.
    const filter = {
      should: chunks.map((chunk) => ({
        must: [
          { key: 'fileId', match: { value: chunk.fileId } },
          { key: 'chunkIndex', match: { value: chunk.chunkIndex } },
        ],
      })),
    }
    const result = await this.request<{ points?: QdrantPoint[] }>(
      'POST',
      `/collections/${encodeURIComponent(indexName)}/points/scroll`,
      {
        filter,
        limit: chunks.length,
        with_payload: true,
      }
    )

    return (result.result?.points ?? []).map((point) => {
      const payload = point.payload ?? {}
      return {
        fileId: payload.fileId as number,
        filename: payload.filename as string | undefined,
        chunkIndex: payload.chunkIndex as number,
        text: payload.text as string | undefined,
      }
    })
  }
}
