import { describe, expect, it } from 'vitest'
import { toolByName, toolSpecs } from './index'

describe('tool registry', () => {
  it('registers every tool with a callable name and a schema', () => {
    for (const spec of toolSpecs()) {
      expect(spec.name).toMatch(/^[a-z_]+$/)
      expect(spec.description.length).toBeGreaterThan(10)
      expect(spec.parameters.type).toBe('object')
      expect(toolByName(spec.name)).toBeDefined()
    }
    expect(toolByName('nope')).toBeUndefined()
  })
})
