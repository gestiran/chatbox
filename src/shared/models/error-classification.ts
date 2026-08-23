import { APICallError } from 'ai'
import {
  AIProviderNoImplementedPaintError,
  ApiError,
  BaseError,
  ChatboxAIAPIError,
  KnowledgeBaseUnavailableError,
  McpUnavailableError,
  NetworkError,
  OCRError,
} from './errors'

/**
 * Errors produced by providers, user configuration, cancellation, or supported
 * fallbacks are user-facing outcomes rather than product defects.
 */
export function isExpectedGenerationError(error: unknown): boolean {
  return (
    error instanceof ApiError ||
    error instanceof NetworkError ||
    error instanceof ChatboxAIAPIError ||
    error instanceof McpUnavailableError ||
    error instanceof KnowledgeBaseUnavailableError ||
    error instanceof AIProviderNoImplementedPaintError ||
    APICallError.isInstance(error) ||
    (error instanceof OCRError && error.cause instanceof BaseError)
  )
}
