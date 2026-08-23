import { v5 as uuidv5 } from 'uuid'
import { getLogger } from '../../util'
import type { KbChunkContent, KbChunkKey, KbVectorSearchResult, KnowledgeBaseVectorStore } from './types'

const log = getLogger('knowledge-base:vector-store:qdrant')

const REQUEST_TIMEOUT_MS = 30_000
// Short timeout for the connectivity probe: a dead server must be reported to
// the user quickly instead of stalling the request for the full 30 seconds.
const CONNECTION_CHECK_TIMEOUT_MS = 5_000

// Fixed RFC 4122 namespace used to derive deterministic point ids (same
// approach as the QDrant guide: uuidv5 of a stable key, see section "Схема
// метаданных документа").
const POINT_ID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

// Maximum number of pages to walk in scroll pagination as a safety net.
const SCROLL_PAGE_SIZE = 100
const SCROLL_MAX_PAGES = 1000

/**
 * Deterministic point id: the same (fileId, chunkIndex) pair always maps to
 * the same point, so re-uploading a chunk overwrites it instead of creating
 * duplicates (idempotent upserts, as recommended by the QDrant guide).
 */
function pointId(fileId: number, chunkIndex: number): string {
  return uuidv5(`${fileId}:${chunkIndex}`, POINT_ID_NAMESPACE)
}

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

  // ---- Low level API access --------------------------------------------------

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
      // GET /collections/{collection_name}/exists - dedicated existence check,
      // equivalent of client.collectionExists() from the official guide.
      const result = await this.request<{ exists?: boolean }>(
        'GET',
        `/collections/${encodeURIComponent(collectionName)}/exists`
      )
      return Boolean(result.result?.exists)
    } catch (error) {
      if (error instanceof QdrantApiError && error.statusCode === 404) {
        // Fallback for older servers without the /exists endpoint:
        // GET /collections/{collection_name} answers 404 for missing collections.
        try {
          await this.request('GET', `/collections/${encodeURIComponent(collectionName)}`)
          return true
        } catch (fallbackError) {
          if (fallbackError instanceof QdrantApiError && fallbackError.statusCode === 404) {
            return false
          }
          throw fallbackError
        }
      }
      throw error
    }
  }

  // ---- KnowledgeBaseVectorStore --------------------------------------------

  async checkConnection(): Promise<void> {
    let response: Response
    try {
      // GET /healthz - dedicated liveness endpoint. It never touches
      // collections, so it stays cheap even on loaded servers.
      response = await fetch(`${this.baseUrl}/healthz`, {
        method: 'GET',
        signal: AbortSignal.timeout(CONNECTION_CHECK_TIMEOUT_MS),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to reach QDrant server at ${this.baseUrl}: ${reason}`)
    }
    // Older QDrant versions answer 404 for unknown endpoints - receiving any
    // HTTP response at all proves the server is up.
    if (response.ok || response.status === 404) {
      return
    }
    throw new QdrantApiError(
      `QDrant health check failed (${response.status} ${response.statusText})`,
      response.status
    )
  }

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

    // PUT /collections/{collection_name}/index - payload indexes for the fields
    // we filter by (client.createPayloadIndex in the official guide). Creating
    // them before bulk upload keeps filtering fast on large collections.
    const indexFields: Array<{ field_name: string; field_schema: 'integer' | 'keyword' }> = [
      { field_name: 'fileId', field_schema: 'integer' },
      { field_name: 'chunkIndex', field_schema: 'integer' },
      { field_name: 'filename', field_schema: 'keyword' },
    ]
    for (const field of indexFields) {
      try {
        await this.request('PUT', `/collections/${encodeURIComponent(indexName)}/index`, field)
      } catch (error) {
        // A missing payload index only costs performance, never correctness.
        log.warn(`[QDRANT] Failed to create payload index for ${field.field_name} in ${indexName}`, error)
      }
    }

    log.info(`[QDRANT] Created collection: ${indexName} (dimension=${dimension})`)
  }

  async upsert(indexName: string, vectors: number[][], metadata: Record<string, unknown>[]): Promise<void> {
    // PUT /collections/{collection_name}/points?wait=true - upload points.
    // Point ids must be unsigned integers or UUIDs: every chunk gets a
    // deterministic UUIDv5 id derived from (fileId, chunkIndex) and carries its
    // metadata inside the point payload, so retries never create duplicates.
    const points = vectors.map((vector, i) => ({
      id: pointId(Number(metadata[i]?.fileId ?? 0), Number(metadata[i]?.chunkIndex ?? i)),
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

    const filter = {
      should: chunks.map((chunk) => ({
        must: [
          { key: 'fileId', match: { value: chunk.fileId } },
          { key: 'chunkIndex', match: { value: chunk.chunkIndex } },
        ],
      })),
    }
    // POST /collections/{collection_name}/points/scroll - fetch payloads that
    // match any of the requested (fileId, chunkIndex) pairs. Results are
    // paginated with next_page_offset as recommended by the official guide.
    const points: QdrantPoint[] = []
    let offset: string | number | undefined
    let page = 0
    do {
      const response = await this.request<{ points?: QdrantPoint[]; next_page_offset?: string | number | null }>(
        'POST',
        `/collections/${encodeURIComponent(indexName)}/points/scroll`,
        {
          filter,
          limit: SCROLL_PAGE_SIZE,
          with_payload: true,
          with_vector: false,
          ...(offset !== undefined ? { offset } : {}),
        }
      )
      points.push(...(response.result?.points ?? []))
      const nextPage = response.result?.next_page_offset
      offset = nextPage === null || nextPage === undefined ? undefined : nextPage
      page += 1
    } while (offset !== undefined && page < SCROLL_MAX_PAGES)

    return points.map((point) => {
      const payload = point.payload ?? {}
      return {
        fileId: payload.fileId as number,
        filename: payload.filename as string | undefined,
        chunkIndex: payload.chunkIndex as number,
        text: payload.text as string | undefined,
      }
    })
  }

  async fetchFileHash(indexName: string, fileId: number): Promise<string | null> {
    // POST /collections/{collection_name}/points/scroll - read the payload of
    // a single point of this file. Every point of a file carries the same
    // `fileHash` value, so the first hit is enough.
    const response = await this.request<{ points?: QdrantPoint[] }>(
      'POST',
      `/collections/${encodeURIComponent(indexName)}/points/scroll`,
      {
        filter: {
          must: [{ key: 'fileId', match: { value: fileId } }],
        },
        limit: 1,
        with_payload: true,
        with_vector: false,
      }
    )
    const payload = response.result?.points?.[0]?.payload
    return typeof payload?.fileHash === 'string' && payload.fileHash ? payload.fileHash : null
  }
}
