import type { LibSQLVector } from '@mastra/libsql'
import { getLogger } from '../../util'
import { getDatabase } from '../db'
import type { KbChunkContent, KbChunkKey, KbVectorSearchResult, KnowledgeBaseVectorStore } from './types'

const log = getLogger('knowledge-base:vector-store:libsql')

/**
 * Default vector store implementation on top of the local LibSQL database
 * (the behaviour used before the QDrant provider was introduced).
 */
export class LibsqlKnowledgeBaseVectorStore implements KnowledgeBaseVectorStore {
  readonly provider = 'default'

  private readonly inner: LibSQLVector

  constructor(inner: LibSQLVector) {
    this.inner = inner
  }

  async createIndex(indexName: string, dimension: number): Promise<void> {
    await this.inner.createIndex({ indexName, dimension })
  }

  async upsert(indexName: string, vectors: number[][], metadata: Record<string, unknown>[]): Promise<void> {
    await this.inner.upsert({ indexName, vectors, metadata })
  }

  async query(indexName: string, queryVector: number[], topK: number): Promise<KbVectorSearchResult[]> {
    const results = await this.inner.query({ indexName, queryVector, topK })
    return results.map((result) => ({
      id: result.id,
      score: result.score,
      metadata: result.metadata ?? {},
    }))
  }

  async deleteIndex(indexName: string): Promise<void> {
    await this.inner.deleteIndex({ indexName })
  }

  async deleteVectorsByFileId(indexName: string, fileId: number): Promise<number> {
    const db = getDatabase()

    const countResult = await db.execute({
      sql: `SELECT COUNT(*) as count FROM ${indexName} WHERE json_extract(metadata, '$.fileId') = ?`,
      args: [fileId],
    })
    const count = Number(countResult.rows[0]?.count || 0)

    if (count > 0) {
      await db.execute({
        sql: `DELETE FROM ${indexName} WHERE json_extract(metadata, '$.fileId') = ?`,
        args: [fileId],
      })
      log.info(`[LIBSQL] Deleted ${count} vectors of fileId=${fileId} from ${indexName}`)
    }
    return count
  }

  async fetchChunksByFileAndChunkIndexes(indexName: string, chunks: KbChunkKey[]): Promise<KbChunkContent[]> {
    if (!chunks || chunks.length === 0) {
      return []
    }

    const db = getDatabase()

    // Build composite IN condition to avoid SQLite's 999 variable limit.
    const valuePlaceholders = chunks.map(() => '(?,?)').join(',')
    const condition = `(json_extract(metadata, '$.fileId'), json_extract(metadata, '$.chunkIndex')) IN (${valuePlaceholders})`
    const args = chunks.flatMap((chunk) => [chunk.fileId, chunk.chunkIndex])

    const queryResult = await db.execute({
      sql: `SELECT metadata FROM ${indexName} WHERE ${condition}`,
      args,
    })

    return queryResult.rows.map((row) => {
      const metadata = JSON.parse(row.metadata as string)
      return {
        fileId: metadata.fileId,
        filename: metadata.filename,
        chunkIndex: metadata.chunkIndex,
        text: metadata.text,
      }
    })
  }
}
