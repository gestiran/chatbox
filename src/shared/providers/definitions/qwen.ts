import { ModelProviderEnum, ModelProviderType } from '../../types'
import { defineProvider } from '../registry'
import Qwen, { QWEN_IMAGE_API_HOST } from './models/qwen'

const QWEN_API_HOST = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

export const qwenProvider = defineProvider({
  id: ModelProviderEnum.Qwen,
  name: 'Qwen',
  type: ModelProviderType.OpenAI,
  modelsDevProviderId: 'alibaba',
  curatedModelIds: ['qwen3.7-max', 'qwen3.6-plus', 'qwen3.6-flash', 'qwen3-coder-plus', 'qwen3-vl-plus'],
  urls: {
    website: 'https://chat.qwen.ai',
    docs: 'https://qwenlm.github.io/qwen-code-docs/en/users/overview/',
  },
  defaultSettings: {
    apiHost: QWEN_API_HOST,
    imageApiHost: QWEN_IMAGE_API_HOST,
    models: [
      {
        modelId: 'qwen3.7-max',
        capabilities: ['tool_use'],
      },
      {
        modelId: 'qwen3.6-plus',
        capabilities: ['tool_use'],
      },
      {
        modelId: 'qwen3.6-flash',
        capabilities: ['tool_use'],
      },
      {
        modelId: 'qwen3-coder-plus',
        capabilities: ['tool_use'],
      },
      {
        modelId: 'qwen3-vl-plus',
        capabilities: ['vision', 'tool_use'],
      },
      {
        modelId: 'qwen-image-3.0-pro',
        type: 'image',
      },
    ],
  },
  createModel: (config) => {
    return new Qwen(
      {
        name: 'Qwen',
        apiKey: config.effectiveApiKey,
        apiHost: config.formattedApiHost || QWEN_API_HOST,
        imageApiHost: config.providerSetting.imageApiHost || QWEN_IMAGE_API_HOST,
        model: config.model,
        temperature: config.settings.temperature,
        topP: config.settings.topP,
        maxOutputTokens: config.settings.maxTokens,
        useProxy: config.providerSetting.useProxy || false,
        stream: config.settings.stream,
        listModelsFallback: config.providerSetting.models || qwenProvider.defaultSettings?.models,
      },
      config.dependencies
    )
  },
  getDisplayName: (modelId, providerSettings) => {
    return `Qwen (${providerSettings?.models?.find((m) => m.modelId === modelId)?.nickname || modelId})`
  },
})
