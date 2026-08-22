import { describe, expect, test } from 'vitest'
import { ProjectSchema } from './project'

describe('ProjectSchema', () => {
  test('parses a full project', () => {
    const project = ProjectSchema.parse({
      id: 'p1',
      name: 'My Project',
      createdAt: 1700000000000,
      sortOrder: 1700000000000,
      settings: {
        provider: 'openai',
        modelId: 'gpt-4o',
        systemPrompt: 'You are a pirate.',
        agentMode: { value: 'on', locked: false, lockReason: null },
        mcpServerIds: ['custom-server'],
        mcpBuiltinServerIds: ['filesystem'],
        knowledgeBaseId: 7,
        skillNames: ['pdf'],
        webSearchProvider: 'tavily',
        webBrowsingEnabled: true,
        workingDirectories: ['/tmp/project'],
      },
    })
    expect(project.id).toBe('p1')
    expect(project.settings.modelId).toBe('gpt-4o')
    expect(project.settings.agentMode?.value).toBe('on')
    expect(project.settings.workingDirectories).toEqual(['/tmp/project'])
  })

  test('allows multiple projects with identical names but different ids', () => {
    const base = { name: 'Same Name', createdAt: 1, sortOrder: 1 }
    const first = ProjectSchema.parse({ id: 'a', ...base })
    const second = ProjectSchema.parse({ id: 'b', ...base })
    expect(first.id).not.toBe(second.id)
    expect(first.name).toBe(second.name)
  })

  test('falls back to empty settings on invalid values', () => {
    const project = ProjectSchema.parse({
      id: 'p2',
      name: 'Broken Settings',
      createdAt: 1,
      sortOrder: 2,
      settings: { knowledgeBaseId: 'not-a-number' },
    })
    expect(project.settings).toEqual({})
  })
})
