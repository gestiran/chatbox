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
