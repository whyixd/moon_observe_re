import { describe, expect, it } from 'vitest'
import {
  createDefaultEffectPreset,
  getEffectCompletion,
  getVariableParameters,
  presetForUnit,
  type EffectPreset,
} from '../src/effects'
import { unitPalettePosition } from '../src/effects/randomFill'
import { unitVariationPosition } from '../src/effects/unitVariation'
import { compileSequence } from '../src/simulation/sequence'

function varied(preset: EffectPreset, parameter: string, from: number, to: number, distribution: 'linear' | 'skip' | 'random' = 'linear'): EffectPreset {
  return { ...preset, unitVariation: { parameter, from, to, distribution } }
}

const valuesOf = (preset: EffectPreset, key: string) =>
  Array.from({ length: 9 }, (_, index) => presetForUnit(preset, index, 9).parameters[key])

describe('各燈台不同數值', () => {
  it('spreads values in unit order and strips the variation from each unit preset', () => {
    const preset = varied(createDefaultEffectPreset('sine-swell'), 'speedHz', 0.2, 1)
    expect(valuesOf(preset, 'speedHz')).toEqual([0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1])
    expect(presetForUnit(preset, 3, 9).unitVariation).toBeUndefined()
    expect(presetForUnit(preset, 3, 9)).toBe(presetForUnit(preset, 3, 9))
    expect(presetForUnit(preset, 3, 9).parameters.depth).toBe(preset.parameters.depth)
  })

  it('skips along the range like random-fill colors', () => {
    const preset = varied(createDefaultEffectPreset('wide-rings'), 'ringCount', 1, 6, 'skip')
    expect(Array.from({ length: 9 }, (_, index) => unitVariationPosition('skip', index, 9)))
      .toEqual(Array.from({ length: 9 }, (_, index) => unitPalettePosition(index, 9)))
    expect(valuesOf(preset, 'ringCount').every(Number.isInteger)).toBe(true)
  })

  it('gives fixed random values within the range', () => {
    const positions = Array.from({ length: 9 }, (_, index) => unitVariationPosition('random', index, 9))
    expect(positions).toEqual(Array.from({ length: 9 }, (_, index) => unitVariationPosition('random', index, 9)))
    expect(positions.every((position) => position >= 0 && position < 1)).toBe(true)
    expect(new Set(positions).size).toBe(9)
  })

  it('snaps to the parameter step and stays within its range', () => {
    const preset = varied(createDefaultEffectPreset('comet-tail'), 'tailLength', 0.05, 0.8)
    for (const value of valuesOf(preset, 'tailLength')) {
      expect(value).toBeGreaterThanOrEqual(0.05)
      expect(value).toBeLessThanOrEqual(0.8)
      expect(Math.abs(value * 100 - Math.round(value * 100))).toBeLessThan(1e-6)
    }
  })

  it('keeps one value for a single unit and leaves shared-schedule parameters fixed', () => {
    const preset = varied(createDefaultEffectPreset('sine-swell'), 'speedHz', 0.2, 1)
    expect(presetForUnit(preset, 0, 1).parameters.speedHz).toBe(0.2)
    expect(getVariableParameters('sequential-center-fill')).toEqual([])
    expect(getVariableParameters('random-leds').map((parameter) => parameter.key)).not.toContain('durationMode')
  })

  it('counts repetitions by the longest unit cycle', () => {
    const preset = varied(createDefaultEffectPreset('sine-swell'), 'speedHz', 0.2, 1)
    expect(getEffectCompletion(preset, 40, 9)!.frames).toBe(200)
    expect(getEffectCompletion(presetForUnit(preset, 8, 9), 40, 9)!.frames).toBe(40)
    const sequence = compileSequence([
      { id: 1, preset, playback: { kind: 'count', count: 2 }, transition: { kind: 'cut', seconds: 0 } },
    ], 40, 9)
    expect(sequence.totalFrames).toBe(400)
  })
})
