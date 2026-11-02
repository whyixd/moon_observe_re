import { describe, expect, it } from 'vitest'
import {
  createDefaultEffectPreset,
  createEffectContext,
  getEffectCompletion,
  sampleEffect,
  type EffectId,
} from '../src/effects'

function brightness(id: EffectId, frame: number, index: number, count = 101): number {
  const preset = createDefaultEffectPreset(id)
  preset.color = { mode: 'solid', color: { r: 1, g: 1, b: 1 } }
  return sampleEffect(preset, createEffectContext(frame, 40, index, count)).r
}

describe('phase-free effects', () => {
  it('fills, shrinks, expands and shrinks the reverse tide, then wraps seamlessly', () => {
    // 0.25 Hz at 40 FPS: each move lasts round(160 / 3) = 53 frames, then holds 20; four 73-frame stages. Index 50 is the center.
    const strip = (frame: number) => Array.from({ length: 101 }, (_, index) => brightness('reverse-tide', frame, index))
    expect(Math.max(...strip(0))).toBe(0)
    expect(brightness('reverse-tide', 27, 95)).toBe(1)
    expect(brightness('reverse-tide', 27, 50)).toBe(0)
    for (const frame of [53, 72]) expect(Math.min(...strip(frame))).toBe(1)
    expect(brightness('reverse-tide', 100, 50)).toBe(1)
    expect(brightness('reverse-tide', 100, 95)).toBe(0)
    for (const frame of [126, 145]) expect(Math.max(...strip(frame))).toBe(0)
    expect(brightness('reverse-tide', 173, 50)).toBe(1)
    expect(brightness('reverse-tide', 173, 95)).toBe(0)
    for (const frame of [199, 218]) expect(Math.min(...strip(frame))).toBe(1)
    expect(brightness('reverse-tide', 246, 50)).toBe(1)
    expect(brightness('reverse-tide', 246, 95)).toBe(0)
    for (const frame of [272, 291]) expect(Math.max(...strip(frame))).toBe(0)
    expect(getEffectCompletion(createDefaultEffectPreset('reverse-tide'), 40, 9)?.frames).toBe(292)
    // 一輪結尾與下一輪開頭相同 / The cycle's last frame matches the next cycle's start.
    expect(strip(292)).toEqual(strip(0))
    expect(strip(292 + 27)).toEqual(strip(27))
  })

  it('keeps reverse-tide cycles whole frames and seamless for any parameters', () => {
    for (const [speedHz, holdSeconds] of [[0.3, 0.7], [0.05, 0], [1, 3], [0.35, 1.3]]) {
      const preset = createDefaultEffectPreset('reverse-tide')
      preset.parameters = { speedHz, holdSeconds }
      preset.color = { mode: 'solid', color: { r: 1, g: 1, b: 1 } }
      const cycle = getEffectCompletion(preset, 40, 9)!.frames
      expect(Number.isInteger(cycle)).toBe(true)
      const at = (frame: number) => Array.from({ length: 101 }, (_, index) =>
        sampleEffect(preset, createEffectContext(frame, 40, index, 101)).r)
      // 有停留時結尾全暗；無停留時最後一步只差一影格的移動量。
      // With a hold the cycle ends dark; without one the last step is a single frame of motion.
      if (holdSeconds > 0) expect(Math.max(...at(cycle - 1))).toBe(0)
      else expect(Math.max(...at(cycle - 1).map((value, index) => Math.abs(value - at(cycle)[index])))).toBeLessThan(0.1)
      expect(at(cycle)).toEqual(at(0))
    }
  })

  it('uses broad radial bands rather than single-pixel rings', () => {
    const lit = Array.from({ length: 156 }, (_, index) => brightness('wide-rings', 0, index, 156))
      .filter((value) => value > 0.5)
    expect(lit.length).toBeGreaterThan(50)
    expect(brightness('wide-rings', 0, 77)).not.toBe(brightness('wide-rings', 100, 77))
  })

  it('keeps the comet tail behind the head', () => {
    expect(brightness('comet-tail', 40, 25)).toBe(1)
    expect(brightness('comet-tail', 40, 15)).toBeGreaterThan(0)
    expect(brightness('comet-tail', 40, 15)).toBeLessThan(1)
    expect(brightness('comet-tail', 40, 35)).toBe(0)
  })

  it('repeats stardust deterministically while varying time and unit', () => {
    const preset = createDefaultEffectPreset('stardust-cloud')
    const frame = (time: number, unit: number) => Array.from({ length: 156 }, (_, index) =>
      sampleEffect(preset, createEffectContext(time, 40, index, 156, unit, 9)).r,
    )
    expect(frame(0, 0)).toEqual(frame(0, 0))
    expect(frame(0, 0)).not.toEqual(frame(80, 0))
    expect(frame(0, 0)).not.toEqual(frame(0, 1))
    expect(Math.max(...frame(0, 0))).toBeGreaterThan(0.5)
  })

  it('breathes in brightness and advances its gradient', () => {
    expect(brightness('color-breathing', 0, 50)).toBeCloseTo(1)
    expect(brightness('color-breathing', 100, 50)).toBeCloseTo(0.25)
    expect(brightness('color-breathing', 200, 50)).toBeCloseTo(1)
    const preset = createDefaultEffectPreset('color-breathing')
    const at = (frame: number) => sampleEffect(preset, createEffectContext(frame, 40, 50, 101))
    expect(at(0)).not.toEqual(at(200))
  })

  it('varies sector radius by controller frame', () => {
    expect(brightness('sector-smear', 0, 90)).toBe(0)
    expect(brightness('sector-smear', 2, 90)).toBe(1)
    expect(brightness('sector-smear', 8, 90)).toBe(0)
  })

  it('cycles five different radial shapes over twenty frames', () => {
    const at = (frame: number, index: number) => brightness('twenty-beat', frame, index)
    expect(at(0, 55)).toBe(1)
    expect(at(0, 90)).toBe(0)
    expect(at(4, 70)).toBe(1)
    expect(at(8, 90)).toBe(1)
    expect(at(12, 55)).toBe(0.7)
    expect(at(20, 55)).toBe(at(0, 55))
  })

  it('exposes repeat boundaries only for deterministic cycles', () => {
    for (const id of ['reverse-tide', 'wide-rings', 'comet-tail', 'sector-smear', 'twenty-beat'] as const) {
      expect(getEffectCompletion(createDefaultEffectPreset(id), 40, 9)?.frames).toBeGreaterThan(0)
    }
    expect(getEffectCompletion(createDefaultEffectPreset('stardust-cloud'), 40, 9)).toBeNull()
    expect(getEffectCompletion(createDefaultEffectPreset('color-breathing'), 40, 9)).toBeNull()
    expect(getEffectCompletion(createDefaultEffectPreset('sector-smear'), 40, 9)?.frames).toBe(8)
    expect(getEffectCompletion(createDefaultEffectPreset('twenty-beat'), 40, 9)?.frames).toBe(20)
  })

  it('keeps the whole strip lit under a moving sine swell', () => {
    const strip = Array.from({ length: 156 }, (_, index) => brightness('sine-swell', 0, index, 156))
    expect(Math.min(...strip)).toBeCloseTo(0.4, 2)
    expect(Math.max(...strip)).toBe(1)
    // 0.3 Hz at 40 FPS: the crest moves a quarter strip in 1/(4 * 0.3) s.
    expect(brightness('sine-swell', 0, 0, 101)).toBe(1)
    expect(brightness('sine-swell', Math.round(40 / 1.2), 25, 101)).toBeCloseTo(1, 2)
    expect(getEffectCompletion(createDefaultEffectPreset('sine-swell'), 40, 9)?.frames).toBe(134)
  })
})
