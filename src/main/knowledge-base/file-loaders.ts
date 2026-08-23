import { setTimeout } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { MDocument } from '@mastra/rag'
import { embedMany } from 'ai'
import {
  computeKnowledgeBaseChunkHash,
  KNOWLEDGE_BASE_CHUNK_SIZES,
  KNOWLEDGE_BASE_DEFAULT_CHUNK_SIZE,
  KNOWLEDGE_BASE_DEFAULT_MIN_SIMILARITY,
  KNOWLEDGE_BASE_DEFAULT_SEARCH_LIMIT,
  KNOWLEDGE_BASE_MIN_SIMILARITY_MAX,
  KNOWLEDGE_BASE_MIN_SIMILARITY_MIN,
  KNOWLEDGE_BASE_MAX_PARSED_CONTENT_SIZE,
  KNOWLEDGE_BASE_PARSED_CONTENT_TOO_LARGE_ERROR,
  KNOWLEDGE_BASE_SEARCH_LIMIT_MAX,
  KNOWLEDGE_BASE_SEARCH_LIMIT_MIN,
} from '../../shared/knowledge-base'
import { ChatboxAIAPIError } from '../../shared/models/errors'
import { rerank } from '../../shared/models/rerank'
import type { DocumentParserConfig } from '../../shared/types/settings'
import type { DocumentParserConfig } from '../../shared/types/settings'
import type { KnowledgeBaseHashCheckResult, KnowledgeBaseSearchOptions } from '../../shared/types'
import { sentry } from '../adapters/sentry'
import { getLogger } from '../util'
import { checkProcessingTimeouts, getDatabase } from './db'
import { isExpectedKnowledgeBaseRerankError } from './error-reporting'
import { getEmbeddingProvider, getRerankProvider } from './model-providers'
import { getEffectiveParserConfig, type ParserFileMeta, parseFileWithRouter } from './parsers'
import { getKnowledgeBaseVectorStore } from './vector-store'

const log = getLogger('knowledge-base:file-loaders')

/**
 * SHA-256 hash of a file's current on-disk content. Used to detect files that
 * changed since they were indexed into the vector store.
 */
export function computeFileHash(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) {
      return null
    }
    return createHash('sha256').update(readFileSync(filePath)).digest('hex')
  } catch (error: unknown) {
    log.warn(`[FILE] Failed to compute hash for ${filePath}:`, error)
    return null
  }
}

/**
 * Resolve the chunk size configured for a knowledge base. Bases created
 * before the setting existed (or with an out-of-range value) fall back to the
 * default chunk size.
 */
async function resolveChunkSize(kbId: number): Promise<number> {
  const db = getDatabase()
  const rs = await db.execute('SELECT chunk_size FROM knowledge_base WHERE id = ?', [kbId])
  const value = Number(rs.rows[0]?.chunk_size)
  return KNOWLEDGE_BASE_CHUNK_SIZES.includes(value) ? value : KNOWLEDGE_BASE_DEFAULT_CHUNK_SIZE
}

/**
 * Parse error message to extract user-friendly message
 * Handles JSON error responses from Chatbox AI API
 * Uses i18nKey from ChatboxAIAPIError.codeNameMap for known error codes
 */
function parseErrorMessage(errorMessage: string): string {
  // Try to extract error code from JSON error response
  // Format: "Status Code 500, {"error":{"code":"system_error","detail":"Server error...","status":500,"title":"Server Error"}}"
  try {
    // Find JSON part in the message
    const jsonMatch = errorMessage.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const jsonStr = jsonMatch[0]
      const parsed = JSON.parse(jsonStr)
      const errorCode = parsed.error?.code

      // Try to get i18nKey from ChatboxAIAPIError.codeNameMap
      if (errorCode && ChatboxAIAPIError.codeNameMap[errorCode]) {
        return ChatboxAIAPIError.codeNameMap[errorCode].i18nKey
      }

      // Fallback to detail or title
      if (parsed.error?.detail) {
        return parsed.error.detail
      }
      if (parsed.error?.title) {
        return parsed.error.title
      }
    }
  } catch {
    // JSON parsing failed, return original message
  }
  return errorMessage
}

// Parse file to MDocument using the parser router
async function parseFileToDocumentWithRouter(
  filePath: string,
  fileMeta: ParserFileMeta,
  kbId: number,
  parserConfig: DocumentParserConfig
): Promise<{ document: MDocument; parserUsed: string }> {
  log.info(`[FILE] Parsing ${fileMeta.filename} with ${parserConfig.type} parser`)

  const result = await parseFileWithRouter(filePath, fileMeta, parserConfig, kbId)

  log.info(`[FILE] Parse completed for ${fileMeta.filename}, parser used: ${result.parserUsed}`)

  const parsedContentByteLength = Buffer.byteLength(result.content, 'utf8')
  if (parsedContentByteLength > KNOWLEDGE_BASE_MAX_PARSED_CONTENT_SIZE) {
    log.info(
      `[FILE] Parsed content too large: filename=${fileMeta.filename}, bytes=${parsedContentByteLength}, limit=${KNOWLEDGE_BASE_MAX_PARSED_CONTENT_SIZE}`
    )
    throw new Error(KNOWLEDGE_BASE_PARSED_CONTENT_TOO_LARGE_ERROR)
  }

  // Convert content to MDocument based on content type
  const document = MDocument.fromText(result.content)
  return { document, parserUsed: result.parserUsed }
}

// Use mastra to parse, chunk, embed, and store files
export async function processFileWithMastra(
  filePath: string,
  fileMeta: { fileId: number; filename: string; mimeType: string },
  kbId: number,
  parserConfig: DocumentParserConfig
) {
  const startTime = Date.now()
  log.debug(
    `[FILE] Starting file processing: ${fileMeta.filename} (id=${fileMeta.fileId}, parser=${parserConfig.type})`
  )

  try {
    const db = getDatabase()

    // Check current processing status and get processed chunk count
    const fileRecord = await db.execute('SELECT chunk_count, total_chunks, status FROM kb_file WHERE id = ?', [
      fileMeta.fileId,
    ])
    const currentChunkCount = (fileRecord.rows[0]?.chunk_count as number) || 0
    const currentTotalChunks = (fileRecord.rows[0]?.total_chunks as number) || 0

    // 1. Parse file using the parser router
    const parseResult = await parseFileToDocumentWithRouter(filePath, fileMeta, kbId, parserConfig)
    const doc = parseResult.document
    const parserUsed = parseResult.parserUsed

    // Update parser_type in database
    await db.execute({
      sql: 'UPDATE kb_file SET parser_type = ? WHERE id = ?',
      args: [parserUsed, fileMeta.fileId],
    })

    // 2. Chunking
    const chunkSize = await resolveChunkSize(kbId)
    const allChunks = await doc.chunk({
      strategy: 'recursive',
      maxSize: chunkSize,
      overlap: Math.min(150, Math.floor(chunkSize / 4)),
    })

    if (!allChunks || allChunks.length === 0) {
      throw new Error('No content extracted from file')
    }

    // Record total chunks if not already recorded
    if (currentTotalChunks === 0 || currentTotalChunks !== allChunks.length) {
      await db.execute({
        sql: 'UPDATE kb_file SET total_chunks = ? WHERE id = ?',
        args: [allChunks.length, fileMeta.fileId],
      })
      log.debug(`[FILE] Recorded total chunks: ${allChunks.length} for file ${fileMeta.fileId}`)
    }

    log.debug(`[FILE] Processing progress: ${currentChunkCount}/${allChunks.length} chunks already processed`)

    // 3. Check if processing is already complete
    if (currentChunkCount >= allChunks.length) {
      log.info(`[FILE] File already fully processed: ${fileMeta.filename} (id=${fileMeta.fileId})`)
      return
    }

    // 4. Get remaining chunks to process
    const remainingChunks = allChunks.slice(currentChunkCount)
    log.debug(`[FILE] Processing remaining ${remainingChunks.length} chunks from index ${currentChunkCount}`)

    // 5. If no remaining chunks, processing is complete
    if (remainingChunks.length === 0) {
      log.info(`[FILE] File processing already complete: ${fileMeta.filename} (id=${fileMeta.fileId})`)
      return
    }

    // Hash of the file content, stored in every point payload so that later
    // "Refresh" checks can detect files modified after indexing.
    const fileHash = computeFileHash(filePath)

    // 6. Process remaining chunks in batches
    const embeddingInstance = await getEmbeddingProvider(kbId)
    const vectorStore = getKnowledgeBaseVectorStore()
    const indexName = `kb_${kbId}`
    const BATCH_SIZE = 50 // Process chunks in batches of 50

    // Ensure vector index exists by getting dimension from first remaining chunk
    const firstEmbedding = await embedMany({
      model: embeddingInstance,
      values: [`filename: ${fileMeta.filename}\nchunk:\n${remainingChunks[0].text}`],
      // Embeddings are billable; network-error retries could double-charge.
      maxRetries: 0,
    })
    await vectorStore.createIndex(indexName, firstEmbedding.embeddings[0].length)

    for (let i = 0; i < remainingChunks.length; i += BATCH_SIZE) {
      // Check if file has been paused before processing each batch
      const statusCheck = await db.execute('SELECT status FROM kb_file WHERE id = ?', [fileMeta.fileId])
      const currentStatus = statusCheck.rows[0]?.status as string
      if (currentStatus === 'paused') {
        log.info(`[FILE] File processing paused by user: ${fileMeta.filename} (id=${fileMeta.fileId})`)
        return
      }

      const batchChunks = remainingChunks.slice(i, i + BATCH_SIZE)
      const batchTexts = batchChunks.map((chunk: any) => `filename: ${fileMeta.filename}\nchunk:\n${chunk.text}`)

      const batchNumber = Math.floor(i / BATCH_SIZE) + 1
      const totalBatches = Math.ceil(remainingChunks.length / BATCH_SIZE)
      log.debug(`[FILE] Processing batch ${batchNumber}/${totalBatches}, chunks: ${batchTexts.length}`)

      // Generate embeddings for this batch
      const embeddingResult = await embedMany({
        model: embeddingInstance,
        values: batchTexts,
        // Embeddings are billable; network-error retries could double-charge.
        maxRetries: 0,
      })

      if (!embeddingResult.embeddings || embeddingResult.embeddings.length !== batchTexts.length) {
        throw new Error(
          `Embedding batch failed: expected ${batchTexts.length}, got ${embeddingResult.embeddings?.length || 0}`
        )
      }

      // Store vectors for this batch
      log.debug(`[FILE] Storing batch ${batchNumber}/${totalBatches} to vector store`)
      await vectorStore.upsert(
        indexName,
        embeddingResult.embeddings,
        batchChunks.map((chunk: any, chunkIndex: number) => ({
          text: chunk.text,
          fileId: fileMeta.fileId,
          filename: fileMeta.filename,
          mimeType: fileMeta.mimeType,
          fileHash,
          chunkIndex: currentChunkCount + i + chunkIndex, // Use absolute chunk index
        }))
      )

      // Update processed chunk count in database
      const newChunkCount = currentChunkCount + i + batchChunks.length
      await db.execute({
        sql: 'UPDATE kb_file SET chunk_count = ? WHERE id = ?',
        args: [newChunkCount, fileMeta.fileId],
      })

      log.debug(`[FILE] Updated chunk count to ${newChunkCount} for file ${fileMeta.fileId}`)

      // Small delay between batches to avoid overwhelming the API
      if (i + BATCH_SIZE < remainingChunks.length) {
        await setTimeout(100) // 100ms delay between batches
      }
    }

    const duration = Date.now() - startTime
    log.info(
      `[FILE] File processed successfully: ${fileMeta.filename} (id=${fileMeta.fileId}), total chunks: ${allChunks.length}, duration: ${duration}ms`
    )
    // Mark as done and clear processing timestamp
    await db.execute({
      sql: 'UPDATE kb_file SET status = ?, processing_started_at = NULL WHERE id = ?',
      args: ['done', fileMeta.fileId],
    })
  } catch (error: unknown) {
    const errMsg =
      error instanceof Error
        ? error.message
        : typeof error === 'object' &&
            error !== null &&
            'message' in error &&
            typeof (error as Record<string, unknown>).message === 'string'
          ? ((error as Record<string, unknown>).message as string)
          : String(error)
    const duration = Date.now() - startTime
    log.error(`[FILE] File processing failed after ${duration}ms: ${fileMeta.filename} (id=${fileMeta.fileId})`, error)

    // Determine the operation type based on error message for better debugging
    let operation = 'file_processing'
    if (errMsg.includes('parse')) {
      operation = 'file_parsing'
    } else if (errMsg.includes('chunk')) {
      operation = 'document_chunking'
    } else if (errMsg.includes('embedding')) {
      operation = 'generate_embeddings'
    } else if (errMsg.includes('store') || errMsg.includes('vector')) {
      operation = 'vector_storage'
    } else if (errMsg.includes('vision') || errMsg.includes('OCR') || errMsg.includes('image')) {
      operation = 'image_ocr_processing'
    }

    // Report processing failures to Sentry with unified context
    sentry.withScope((scope) => {
      scope.setTag('component', 'knowledge-base-file')
      scope.setTag('operation', operation)
      scope.setExtra('fileId', fileMeta.fileId)
      scope.setExtra('filename', fileMeta.filename)
      scope.setExtra('mimeType', fileMeta.mimeType)
      scope.setExtra('kbId', kbId)
      scope.setExtra('duration', duration)
      scope.setExtra('filePath', filePath)
      sentry.captureException(error)
    })

    throw error
  }
}

async function processPendingFiles() {
  try {
    // First check for timed out processing files
    await checkProcessingTimeouts()

    const db = getDatabase()
    // Query pending files with their KB's parser config
    const rs = await db.execute(
      `
      SELECT f.*, kb.document_parser as kb_document_parser
      FROM kb_file f
      JOIN knowledge_base kb ON f.kb_id = kb.id
      WHERE f.status = ?
    `,
      ['pending']
    )

    if (rs.rows.length === 0) {
      return
    }

    log.debug(`[FILE] Processing ${rs.rows.length} pending files`)

    for (const file of rs.rows) {
      // Parse KB parser config
      let kbParserConfig: DocumentParserConfig | undefined
      if (file.kb_document_parser) {
        try {
          kbParserConfig = JSON.parse(file.kb_document_parser as string)
        } catch {
          log.warn(`[FILE] Failed to parse KB document_parser config for file ${file.id}`)
        }
      }

      // Get effective parser config (legacy configs pointing to cloud parsers
      // are handled by the parser router falling back to the local parser).
      const effectiveParserConfig: DocumentParserConfig = getEffectiveParserConfig(kbParserConfig)

      try {
        log.debug(
          `[FILE] Processing file: ${file.filename} (id=${file.id}, parser=${effectiveParserConfig.type})`
        )

        // Mark as processing, record the processing start time and parser_type.
        // We set parser_type here at the start so that if parsing fails, the error message will correctly show which parser was used
        await db.execute({
          sql: 'UPDATE kb_file SET status = ?, processing_started_at = CURRENT_TIMESTAMP, parser_type = ? WHERE id = ?',
          args: ['processing', effectiveParserConfig.type, file.id],
        })

        // Use mastra to parse, chunk, embed, and store (supports resuming from chunk_count)
        await processFileWithMastra(
          file.filepath as string,
          { fileId: file.id as number, filename: file.filename as string, mimeType: file.mime_type as string },
          file.kb_id as number,
          effectiveParserConfig
        )
      } catch (err: any) {
        log.error(`[FILE] File processing failed: ${file.filename} (id=${file.id})`, err)
        // Mark as failed - parse error message to extract user-friendly message
        const rawErrorMessage = err instanceof Error ? err.message : String(err)
        const errorMessage = parseErrorMessage(rawErrorMessage)
        await db.execute({
          sql: 'UPDATE kb_file SET status = ?, error = ?, processing_started_at = NULL WHERE id = ?',
          args: ['failed', errorMessage, file.id],
        })

        // Report individual file processing failures
        sentry.withScope((scope) => {
          scope.setTag('component', 'knowledge-base-file')
          scope.setTag('operation', 'individual_file_processing')
          scope.setExtra('fileId', file.id)
          scope.setExtra('filename', file.filename)
          scope.setExtra('kbId', file.kb_id)
          scope.setExtra('parserType', effectiveParserConfig.type)
          sentry.captureException(err)
        })
      }
    }
  } catch (error: unknown) {
    log.error('[FILE] Failed to process pending files:', error)
    sentry.withScope((scope) => {
      scope.setTag('component', 'knowledge-base-file')
      scope.setTag('operation', 'process_pending_files')
      sentry.captureException(error)
    })
  }
}

// Periodic polling
export async function startWorkerLoop() {
  log.info('[FILE] Starting worker loop')

  while (true) {
    try {
      await processPendingFiles()
    } catch (e: unknown) {
      log.error('[FILE] Worker loop error:', e)
      sentry.withScope((scope) => {
        scope.setTag('component', 'knowledge-base-file')
        scope.setTag('operation', 'worker_loop')
        sentry.captureException(e)
      })

      // Wait before retrying to prevent rapid error loops
      await setTimeout(10000) // 10 seconds
    }
    await setTimeout(3000) // Poll every 3 seconds
  }
}

/** Clamp a numeric option into the inclusive [min, max] integer range. */
function clampSearchOption(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * Search interface, embeddingProvider parameter is required.
 *
 * Options come from Settings / Knowledge Base and the calling chat session:
 * - `limit`: maximum number of chunks returned (1-128).
 * - `minSimilarity`: minimum similarity in percent (1-99). It is applied to
 *   the final per-chunk score (rerank relevance when a rerank model is
 *   configured, cosine similarity otherwise).
 * - `excludeHashes`: hashes of chunks already sent to the model earlier in the
 *   same agent turn. They are dropped BEFORE the limit is applied so repeated
 *   queries can surface deeper unique chunks instead of the same top hits.
 */
export async function searchKnowledgeBase(kbId: number, query: string, options: KnowledgeBaseSearchOptions = {}) {
  const limit = clampSearchOption(
    options.limit ?? KNOWLEDGE_BASE_DEFAULT_SEARCH_LIMIT,
    KNOWLEDGE_BASE_SEARCH_LIMIT_MIN,
    KNOWLEDGE_BASE_SEARCH_LIMIT_MAX
  )
  const minScore =
    clampSearchOption(
      options.minSimilarity ?? KNOWLEDGE_BASE_DEFAULT_MIN_SIMILARITY,
      KNOWLEDGE_BASE_MIN_SIMILARITY_MIN,
      KNOWLEDGE_BASE_MIN_SIMILARITY_MAX
    ) / 100
  const excludedHashes = new Set(options.excludeHashes ?? [])

  interface KbScoredChunk {
    score: number
    fileId: unknown
    text: unknown
  }

  try {
    log.debug(`[FILE] Searching knowledge base: kbId=${kbId}, query=${query}, limit=${limit}, minScore=${minScore}`)
    const embeddingInstance = await getEmbeddingProvider(kbId)
    const embedding = await embedMany({
      model: embeddingInstance,
      values: [query],
      // Embeddings are billable; network-error retries could double-charge.
      maxRetries: 0,
    })
    const vectorStore = getKnowledgeBaseVectorStore()
    const indexName = `kb_${kbId}`
    // Fetch a wider candidate pool so reranking can pick the best hits before
    // the configured limit and similarity threshold are applied.
    const candidatePool = Math.min(Math.max(limit * 4, 20), 512)
    const results = await vectorStore.query(indexName, embedding.embeddings[0], candidatePool)

    const applyLimitAndThreshold = <T extends KbScoredChunk>(chunks: T[]): T[] =>
      chunks
        .filter(
          (chunk) =>
            !excludedHashes.has(
              computeKnowledgeBaseChunkHash(chunk.fileId as number | string | undefined, chunk.text)
            )
        )
        .filter((chunk) => chunk.score >= minScore)
        .slice(0, limit)

    try {
      const rerankInstance = await getRerankProvider(kbId)
      if (rerankInstance) {
        const rerankedResults = await rerank(results, query, rerankInstance, {
          topK: limit,
        })
        return applyLimitAndThreshold(
          rerankedResults.map((r) => ({
            id: r.result.id,
            score: r.result.score,
            fileId: r.result.metadata['fileId'],
            text: r.result.metadata['text'],
            ...r.result.metadata,
          }))
        )
      }
      return applyLimitAndThreshold(
        results.map((r) => ({
          id: r.id,
          score: r.score,
          fileId: r.metadata['fileId'],
          text: r.metadata['text'],
          ...r.metadata,
        }))
      )
    } catch (e) {
      const expectedRerankError = isExpectedKnowledgeBaseRerankError(e)
      const logMessage = `[FILE] Failed to rerank: kbId=${kbId}, queryLength=${query.length}`

      if (expectedRerankError) {
        log.warn(logMessage, e)
      } else {
        log.error(logMessage, e)
        sentry.withScope((scope) => {
          scope.setTag('component', 'knowledge-base-file')
          scope.setTag('operation', 'rerank')
          scope.setExtra('kbId', kbId)
          scope.setExtra('queryLength', query.length)
          sentry.captureException(e)
        })
      }
      return applyLimitAndThreshold(
        results.map((r) => ({
          id: r.id,
          score: r.score,
          fileId: r.metadata['fileId'],
          text: r.metadata['text'],
          ...r.metadata,
        }))
      )
    }
  } catch (e) {
    log.error(`[FILE] Failed to search: kbId=${kbId}, queryLength=${query.length}`, e)

    sentry.withScope((scope) => {
      scope.setTag('component', 'knowledge-base-file')
      scope.setTag('operation', 'search_knowledge_base')
      scope.setExtra('kbId', kbId)
      scope.setExtra('queryLength', query.length)
      sentry.captureException(e)
    })

    throw new Error(`Failed to search knowledge base (id: ${kbId}). Please try again later.`)
  }
}

// Read chunks from the active vector store
export async function readChunks(kbId: number, chunks: { fileId: number; chunkIndex: number }[]) {
  try {
    log.debug(`[FILE] Reading chunks: kbId=${kbId}, chunks=${chunks.length}`)

    if (!chunks || chunks.length === 0) {
      return []
    }

    const results: any[] = []

    const indexName = `kb_${kbId}`
    const vectorStore = getKnowledgeBaseVectorStore()

    log.debug(`[FILE] Fetching ${chunks.length} chunks from ${vectorStore.provider} vector store`)
    const foundChunks = await vectorStore.fetchChunksByFileAndChunkIndexes(indexName, chunks)

    log.debug(`[FILE] Fetched ${foundChunks.length} chunks from ${vectorStore.provider} vector store`)

    // Maintain the order of the requested chunks
    for (const chunk of chunks) {
      const found = foundChunks.find(
        (fc: any) => Number(fc.fileId) === Number(chunk.fileId) && Number(fc.chunkIndex) === Number(chunk.chunkIndex)
      )
      if (found) {
        results.push(found)
      }
    }

    return results
  } catch (sqlErr: any) {
    log.error(`[FILE] Single SQL query failed:`, sqlErr)
    sentry.withScope((scope) => {
      scope.setTag('component', 'knowledge-base-file')
      scope.setTag('operation', 'read_chunks')
      scope.setExtra('kbId', kbId)
      scope.setExtra('chunkCount', chunks.length)
      sentry.captureException(sqlErr)
    })
    throw sqlErr
  }
}

/**
 * Compare each file's current on-disk sha-256 hash against the `fileHash`
 * stored in the vector store payload. A file is reported as modified when its
 * stored hash is missing or differs from the current disk content.
 *
 * When `fileIds` is omitted, every file of the knowledge base is checked.
 */
export async function checkKnowledgeBaseFilesHashes(
  kbId: number,
  fileIds?: number[]
): Promise<KnowledgeBaseHashCheckResult[]> {
  const db = getDatabase()
  const vectorStore = getKnowledgeBaseVectorStore()
  const indexName = `kb_${kbId}`

  const args: (number | string)[] = [kbId]
  let sql = 'SELECT id, filepath FROM kb_file WHERE kb_id = ?'
  if (fileIds && fileIds.length > 0) {
    sql += ` AND id IN (${fileIds.map(() => '?').join(', ')})`
    args.push(...fileIds)
  }

  const rs = await db.execute({ sql, args })
  const results: KnowledgeBaseHashCheckResult[] = []

  for (const row of rs.rows) {
    const fileId = row.id as number
    const filePath = row.filepath as string
    const diskHash = computeFileHash(filePath)

    let storedHash: string | null = null
    try {
      storedHash = await vectorStore.fetchFileHash(indexName, fileId)
    } catch (error: unknown) {
      // Collection may not exist yet (nothing indexed so far).
      log.debug(`[FILE] No stored hash for fileId=${fileId} in ${indexName}:`, error)
    }

    results.push({
      fileId,
      diskHash,
      storedHash,
      modified: diskHash !== null && diskHash !== storedHash,
    })
  }

  return results
}

/**
 * Queue modified files for re-indexing: their vectors are dropped and the
 * files are reset to the regular processing pipeline. The worker then parses,
 * chunks and embeds them again, storing the fresh file hash in the payloads.
 * Returns how many files were actually queued.
 */
export async function queueKnowledgeBaseFilesUpdate(kbId: number, fileIds: number[]): Promise<number> {
  if (!fileIds || fileIds.length === 0) {
    return 0
  }

  const db = getDatabase()
  const vectorStore = getKnowledgeBaseVectorStore()
  const indexName = `kb_${kbId}`
  let queued = 0

  for (const fileId of fileIds) {
    const rs = await db.execute('SELECT id FROM kb_file WHERE id = ? AND kb_id = ?', [fileId, kbId])
    if (!rs.rows[0]) {
      log.warn(`[FILE] Update skipped - file not found: kbId=${kbId}, fileId=${fileId}`)
      continue
    }

    try {
      await vectorStore.deleteVectorsByFileId(indexName, fileId)
    } catch (error: unknown) {
      // Nothing indexed yet for this base/file - safe to proceed.
      log.debug(`[FILE] No vectors to delete for fileId=${fileId} in ${indexName}:`, error)
    }

    await db.execute({
      sql: `UPDATE kb_file SET chunk_count = 0, total_chunks = 0, status = ?, error = NULL, processing_started_at = NULL WHERE id = ?`,
      args: ['pending', fileId],
    })
    queued += 1
    log.info(`[FILE] Queued file for update: kbId=${kbId}, fileId=${fileId}`)
  }

  return queued
}
