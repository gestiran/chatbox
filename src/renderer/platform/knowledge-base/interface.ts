import type {
  FileMeta,
  KnowledgeBase,
  KnowledgeBaseConnectionStatus,
  KnowledgeBaseFile,
  KnowledgeBaseHashCheckResult,
  KnowledgeBaseSearchOptions,
  KnowledgeBaseSearchResult,
} from '@shared/types'

export interface KnowledgeBaseController {
  list(): Promise<KnowledgeBase[]>
  create(createParams: {
    name: string
    embeddingModel: string
    rerankModel: string
    visionModel?: string
    chunkSize?: number
  }): Promise<void>
  delete(id: number): Promise<void>
  listFiles(kbId: number): Promise<KnowledgeBaseFile[]>
  countFiles(kbId: number): Promise<number>
  listFilesPaginated(kbId: number, offset?: number, limit?: number): Promise<KnowledgeBaseFile[]>
  /** Returns the created file id; new files start as "modified" (not indexed). */
  uploadFile(kbId: number, file: FileMeta): Promise<{ id: number } | undefined>
  deleteFile(fileId: number): Promise<void>
  retryFile(fileId: number): Promise<void>
  pauseFile(fileId: number): Promise<void>
  resumeFile(fileId: number): Promise<void>
  search(kbId: number, query: string, options?: KnowledgeBaseSearchOptions): Promise<KnowledgeBaseSearchResult[]>
  /**
   * Check whether the vector-store backend (QDrant) is reachable right now.
   * Never rejects over IPC; inspect the returned `available` flag.
   */
  checkConnection(): Promise<KnowledgeBaseConnectionStatus>
  update(updateParams: { id: number; name?: string; rerankModel?: string; visionModel?: string }): Promise<void>
  getFilesMeta(
    kbId: number,
    fileIds: number[]
  ): Promise<
    {
      id: number
      kbId: number
      filename: string
      mimeType: string
      fileSize: number
      chunkCount: number
      totalChunks: number
      status: string
      createdAt: number
    }[]
  >
  readFileChunks(
    kbId: number,
    chunks: { fileId: number; chunkIndex: number }[]
  ): Promise<{ fileId: number; filename: string; chunkIndex: number; text: string }[]>
  /**
   * Compare on-disk file hashes against the hashes stored in the vector store.
   * When `fileIds` is omitted every file of the base is checked. Files whose
   * stored hash is missing or stale are reported as `modified`.
   */
  checkFileHashes(kbId: number, fileIds?: number[]): Promise<KnowledgeBaseHashCheckResult[]>
  /** Re-index the given (modified) files of a knowledge base. */
  updateFiles(kbId: number, fileIds: number[]): Promise<void>
  /** Open the system file manager at the file's folder (file selected). */
  showItemInFolder(filePath: string): Promise<void>
}
