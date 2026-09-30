export type ImageModelFamily = 'gemini' | 'openai'

const RATIO_OPTIONS: Record<ImageModelFamily | 'default', string[]> = {
  openai: ['auto', '1:1', '3:2', '2:3'],
  gemini: ['auto', '1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '21:9'],
  default: ['auto', '1:1', '3:2', '2:3'],
}

export function getImageModelFamily(modelId: string): ImageModelFamily | 'default' {
  if (modelId.includes('gemini') && modelId.includes('image')) return 'gemini'
  if (modelId.startsWith('gpt-image')) return 'openai'
  return 'default'
}

export function isGeminiImageModel(modelId: string): boolean {
  return getImageModelFamily(modelId) === 'gemini'
}

export function getRatioOptionsForModel(modelId: string): string[] {
  return RATIO_OPTIONS[getImageModelFamily(modelId)] ?? RATIO_OPTIONS.default
}

// ===== Qwen image generation =====

export const QWEN_IMAGE_SIZE_MIN = 512
export const QWEN_IMAGE_SIZE_MAX = 2048
export const QWEN_DEFAULT_IMAGE_SIZE = '2048*2048'

export function isQwenImageModel(modelId: string): boolean {
  return modelId.startsWith('qwen-image')
}

/**
 * Validates and normalizes a Qwen image size like "1024*1024" (also accepts "x"/"×" separators).
 * Each side must be within [QWEN_IMAGE_SIZE_MIN, QWEN_IMAGE_SIZE_MAX].
 * Returns the normalized "W*H" string, or null when the input is invalid.
 */
export function normalizeQwenImageSize(size?: string | null): string | null {
  if (!size) return null
  const match = /^\s*(\d+)\s*[*x×]\s*(\d+)\s*$/i.exec(size)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (
    width < QWEN_IMAGE_SIZE_MIN ||
    width > QWEN_IMAGE_SIZE_MAX ||
    height < QWEN_IMAGE_SIZE_MIN ||
    height > QWEN_IMAGE_SIZE_MAX
  ) {
    return null
  }
  return `${width}*${height}`
}
