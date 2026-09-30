import { ApiError } from '../../../models/errors'
import OpenAICompatible, { type OpenAICompatibleSettings } from '../../../models/openai-compatible'
import type { ModelDependencies } from '../../../types/adapters'
import { isQwenImageModel, normalizeQwenImageSize, QWEN_DEFAULT_IMAGE_SIZE } from '../image-models'

export const QWEN_IMAGE_API_HOST = 'https://token-plan.maas.qwencloudapi.com/api/v1'

const MULTIMODAL_GENERATION_PATH = '/services/aigc/multimodal-generation/generation'

/** Separator between positive and negative prompt in user input (newline + "***" + newline). */
const NEGATIVE_PROMPT_SEPARATOR = '\n***\n'

/**
 * Number of images sent in an image editing request.
 *
 * The Qwen image editing API accepts up to three input images per request
 * (see https://docs.qwencloud.com, Image editing). For now only the single
 * last image of the chat (the one being edited) is sent; the remaining two
 * slots are reserved for user-provided reference images (not wired up yet).
 */
export const QWEN_EDITING_IMAGE_COUNT = 1

/** Generation can legitimately take about a minute; downloads should be quick. */
const GENERATION_TIMEOUT_MS = 5 * 60 * 1000
const DOWNLOAD_TIMEOUT_MS = 30 * 1000

interface Options extends OpenAICompatibleSettings {
  name: string
  /** Base URL of the DashScope-compatible image generation service (base_http_api_url). */
  imageApiHost?: string
}

interface DashScopeImageResponse {
  status_code?: number
  request_id?: string
  code?: string
  message?: string
  output?: {
    choices?: {
      finish_reason?: string
      message?: {
        role?: string
        content?: Array<Record<string, unknown>>
      }
    }[]
  }
}

export function splitQwenImagePrompt(prompt: string): { positive: string; negative: string } {
  const index = prompt.indexOf(NEGATIVE_PROMPT_SEPARATOR)
  if (index === -1) {
    return { positive: prompt.trim(), negative: '' }
  }
  return {
    positive: prompt.slice(0, index).trim(),
    negative: prompt.slice(index + NEGATIVE_PROMPT_SEPARATOR.length).trim(),
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Runs `run` with an AbortSignal that also fires after `timeoutMs`.
 *
 * Without this a request to an unreachable host (e.g. the OSS host that serves
 * generated images) can stay pending indefinitely: the UI keeps spinning and no
 * error is ever logged. A caller-initiated abort is rethrown untouched, while a
 * timeout becomes a descriptive ApiError.
 */
async function runWithTimeout<T>(
  label: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  run: (timeoutSignal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  let timedOut = false

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = () => controller.abort()

  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) {
    controller.abort()
  }

  try {
    return await run(controller.signal)
  } catch (error) {
    if (signal?.aborted) throw error
    if (timedOut) {
      throw new ApiError(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

export default class Qwen extends OpenAICompatible {
  public name: string
  public options: Options

  constructor(options: Options, dependencies: ModelDependencies) {
    super(options, dependencies)
    this.name = options.name
    this.options = options
  }

  public async paint(
    params: {
      prompt: string
      images?: { imageUrl: string }[]
      num: number
      aspectRatio?: string
    },
    signal?: AbortSignal,
    callback?: (picBase64: string) => void | Promise<void>
  ): Promise<string[]> {
    if (!isQwenImageModel(this.options.model.modelId)) {
      throw new ApiError('This Qwen model does not support image generation')
    }

    // aspectRatio carries the requested resolution for Qwen (e.g. "1024*1024")
    let size = QWEN_DEFAULT_IMAGE_SIZE
    if (params.aspectRatio && params.aspectRatio !== 'auto') {
      const normalized = normalizeQwenImageSize(params.aspectRatio)
      if (!normalized) {
        throw new ApiError(`Invalid image resolution: ${params.aspectRatio}`)
      }
      size = normalized
    }

    const { positive, negative } = splitQwenImagePrompt(params.prompt)
    if (!positive) {
      throw new ApiError('Prompt is required for image generation')
    }

    // Input images (public URLs or base64 data URLs). When at least one image
    // is present, the request becomes an "image editing" call: the model edits
    // the provided images according to the text instruction. Without images it
    // stays a plain "text to image" generation.
    //
    // Only the last image (the most recent one of the chat, appended last by
    // the caller) is sent; the other two API slots are reserved for future
    // user-provided reference images.
    const inputImages = (params.images ?? [])
      .map((image) => image.imageUrl)
      .filter((url): url is string => typeof url === 'string' && url.length > 0)
      .slice(-QWEN_EDITING_IMAGE_COUNT)

    const results: string[] = []
    for (let i = 0; i < params.num; i++) {
      const imageUrls = await this.requestImageGeneration(positive, negative, size, inputImages, signal)
      for (const url of imageUrls) {
        const dataUrl = await this.downloadImageAsDataUrl(url, signal)
        results.push(dataUrl)
        await callback?.(dataUrl)
      }
    }
    return results
  }

  private async requestImageGeneration(
    positivePrompt: string,
    negativePrompt: string,
    size: string,
    inputImages: string[],
    signal?: AbortSignal
  ): Promise<string[]> {
    const apiHost = (this.options.imageApiHost || QWEN_IMAGE_API_HOST).replace(/\/+$/, '')
    const requestUrl = `${apiHost}${MULTIMODAL_GENERATION_PATH}`
    console.debug(
      '[qwen-image] requesting generation:',
      requestUrl,
      'size:',
      size,
      'mode:',
      inputImages.length > 0 ? 'image-editing' : 'text-to-image',
      'input images:',
      inputImages.length
    )

    const res = await runWithTimeout('Qwen image generation request', GENERATION_TIMEOUT_MS, signal, (s) =>
      this.dependencies.request.apiRequest({
        url: requestUrl,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.options.model.modelId,
          input: {
            messages: [
              {
                role: 'user',
                // Image editing format: image parts come first (Image 1..3),
                // followed by the single text instruction.
                content: [...inputImages.map((image) => ({ image })), { text: positivePrompt }],
              },
            ],
          },
          parameters: {
            result_format: 'message',
            watermark: false,
            prompt_extend: true,
            ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
            size,
          },
        }),
        useProxy: this.options.useProxy,
        signal: s,
        retry: 0,
      })
    )

    const json = (await res.json().catch(() => ({}))) as DashScopeImageResponse

    if (!res.ok || (json.status_code !== undefined && json.status_code !== 200) || json.code) {
      const message = json.message || json.code || `HTTP ${res.status}`
      throw new ApiError(message)
    }

    const imageUrls: string[] = []
    for (const choice of json.output?.choices || []) {
      for (const part of choice.message?.content || []) {
        if (typeof part.image === 'string' && part.image) {
          imageUrls.push(part.image)
        }
      }
    }

    if (imageUrls.length === 0) {
      throw new ApiError('No image was returned by the Qwen image generation API')
    }

    console.debug('[qwen-image] generation finished, image urls:', imageUrls.length)
    return imageUrls
  }

  /**
   * Downloads a generated image by its signed OSS URL.
   *
   * The URL is pre-signed by the service and the OSS signature covers the
   * Content-Type header, so any extra header makes OSS answer 403. The download
   * is attempted through several routes: the CORS proxy (first, when the provider
   * has `useProxy` enabled, because a direct connection is then usually blocked
   * too), a bare `fetch` that adds no headers, and the app request pipeline.
   *
   * Every attempt is time-boxed and every failure is collected, so an unreachable
   * host produces a readable error instead of an endless spinner.
   */
  private async downloadImageAsDataUrl(url: string, signal?: AbortSignal): Promise<string> {
    console.debug('[qwen-image] downloading image:', url)

    const proxyAttempt = {
      name: 'app proxy',
      run: (s: AbortSignal) =>
        this.dependencies.request.apiRequest({
          url,
          method: 'GET',
          headers: {},
          useProxy: true,
          signal: s,
          retry: 0,
        }),
    }
    const attempts: { name: string; run: (s: AbortSignal) => Promise<Response> }[] = [
      {
        name: 'direct fetch',
        run: (s) => fetch(url, { method: 'GET', signal: s }),
      },
      {
        name: 'app request pipeline',
        run: (s) => this.dependencies.request.fetchWithOptions(url, { method: 'GET', signal: s }),
      },
    ]
    // When the provider is configured to use the proxy, the OSS host is usually not
    // reachable directly either, so try the proxy route first to fail fast.
    if (this.options.useProxy) {
      attempts.unshift(proxyAttempt)
    }

    const failures: string[] = []
    for (const attempt of attempts) {
      if (signal?.aborted) throw new Error('Aborted')
      try {
        const res = await runWithTimeout(
          `Image download (${attempt.name})`,
          DOWNLOAD_TIMEOUT_MS,
          signal,
          attempt.run
        )
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          failures.push(`${attempt.name}: HTTP ${res.status}${body ? ` ${body.slice(0, 300)}` : ''}`)
          continue
        }
        const buffer = await res.arrayBuffer()
        const contentType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png'
        console.debug('[qwen-image] image downloaded via', attempt.name)
        return `data:${contentType};base64,${arrayBufferToBase64(buffer)}`
      } catch (error) {
        if (signal?.aborted) throw error
        failures.push(`${attempt.name}: ${describeError(error)}`)
        console.debug('[qwen-image] download attempt failed:', failures[failures.length - 1])
      }
    }

    throw new ApiError(`Failed to download the generated image. ${failures.join(' | ')}`)
  }
}
