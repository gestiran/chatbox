export const KNOWLEDGE_BASE_MAX_FILE_SIZE = 50 * 1024 * 1024
export const KNOWLEDGE_BASE_MAX_FILE_SIZE_LABEL = '50 MB'
export const KNOWLEDGE_BASE_MAX_PARSED_CONTENT_SIZE = 20 * 1024 * 1024
export const KNOWLEDGE_BASE_MAX_PARSED_CONTENT_SIZE_LABEL = '20 MB'
export const KNOWLEDGE_BASE_PARSED_CONTENT_TOO_LARGE_ERROR = 'knowledge_base_parsed_content_too_large'

// Allowed chunk sizes (in characters) for knowledge base documents.
// The value is chosen when the base is created and cannot be changed later.
export const KNOWLEDGE_BASE_CHUNK_SIZES = [512, 1024, 2048, 4096]
export const KNOWLEDGE_BASE_DEFAULT_CHUNK_SIZE = 1024

// Search tuning for model queries against a knowledge base
// (Settings / Knowledge Base).
export const KNOWLEDGE_BASE_SEARCH_LIMIT_MIN = 1
export const KNOWLEDGE_BASE_SEARCH_LIMIT_MAX = 128
export const KNOWLEDGE_BASE_DEFAULT_SEARCH_LIMIT = 4

export const KNOWLEDGE_BASE_MIN_SIMILARITY_MIN = 1
export const KNOWLEDGE_BASE_MIN_SIMILARITY_MAX = 99
export const KNOWLEDGE_BASE_DEFAULT_MIN_SIMILARITY = 50

/**
 * Stable identifier of a chunk's content, used to avoid sending the same
 * chunk to the model twice within one agent turn (between two user messages).
 *
 * Implemented as a dependency-free cyrb53-style string hash so that both the
 * Electron main process and the renderer compute identical values without
 * native crypto dependencies.
 */
export function computeKnowledgeBaseChunkHash(fileId: number | string | undefined, text: unknown): string {
  const str = `${String(fileId ?? '')}\u0000${typeof text === 'string' ? text.trim() : String(text ?? '')}`
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}
