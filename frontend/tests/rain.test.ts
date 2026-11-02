import { describe, expect, it } from 'vitest'
import { createDefaultEffectPreset, createEffectContext, sampleEffect, type EffectId } from '../src/effects'
import { RAIN_LINES } from '../src/effects/rain'

const LEDS = 156
const energy = (color: { r: number; g: number; b: number }) => Math.max(color.r, color.g, color.b)
const sample = (effectId: EffectId, frame: number, ledIndex: number, raining: boolean, parameters = {}) => {
  const preset = createDefaultEffectPreset(effectId)
  return energy(sampleEffect(
    { ...preset, parameters: { ...preset.parameters, ...parameters } },
    createEffectContext(frame, 40, ledIndex, LEDS, 0, 9),
    frame,
    raining,
  ))
}
const litIndices = (effectId: EffectId, frame: number, parameters = {}) =>
  Array.from({ length: LEDS }, (_, index) => index).filter((index) => sample(effectId, frame, index, true, parameters) > 0)
// 由外圈往內數的 LED 層數。 / LED step counted inward from the rim.
const rimStep = (index: number) => Math.min(index, LEDS - 1 - index)

describe('rain lines', () => {
  it('leaves effects without a rain version unchanged', () => {
    for (const effectId of ['random-leds', 'twenty-beat', 'spectrum-cycle', 'moving-rings', 'sector-smear'] as const) {
      for (const index of [0, 40, 77, 120]) {
        expect(sample(effectId, 33, index, true)).toBe(sample(effectId, 33, index, false))
      }
    }
  })

  it('stripes full fills every sixth LED from the rim, mirrored', () => {
    // 九台全亮後（共用時間）。 / After all nine units have filled (shared time).
    const lit = litIndices('sequential-center-fill', 40 * 60)
    expect(lit.length).toBeGreaterThan(20)
    lit.forEach((index) => expect(rimStep(index) % RAIN_LINES.stripeSpacing).toBe(0))
    lit.forEach((index) => expect(lit).toContain(LEDS - 1 - index))
    expect(lit).toContain(0)
  })

  it('stripes reverse-tide and color-breathing', () => {
    for (const effectId of ['reverse-tide', 'color-breathing'] as const) {
      for (const frame of [30, 70]) {
        litIndices(effectId, frame).forEach((index) => expect(rimStep(index) % RAIN_LINES.stripeSpacing).toBe(0))
      }
    }
  })

  it('narrows wave crests to thin rings of two LEDs of energy', () => {
    for (const effectId of ['center-out-sine', 'sine-swell'] as const) {
      for (const frame of [0, 13, 57]) {
        const lit = litIndices(effectId, frame)
        expect(lit.length).toBeGreaterThan(0)
        expect(lit.length).toBeLessThanOrEqual(12)
        const dry = Array.from({ length: LEDS }, (_, index) => sample(effectId, frame, index, false)).filter((value) => value > 0)
        expect(dry.length).toBe(LEDS)
      }
    }
  })

  it('keeps only the two edges of each wide ring', () => {
    const lit = litIndices('wide-rings', 21, { ringCount: 1, width: 0.5 })
    // 一條寬帶在兩側各有內外兩條邊線，每條最多三顆 LED。 / Inner and outer edge on each side, at most three LEDs each.
    expect(lit.length).toBeGreaterThanOrEqual(4)
    expect(lit.length).toBeLessThanOrEqual(12)
  })

  it('draws full-on rain as streaks of about the sparse density', () => {
    let on = 0
    let total = 0
    for (let frame = 0; frame < 400; frame += 1) {
      for (let index = 0; index < LEDS; index += 1) {
        on += sample('full-on', frame, index, true)
        total += 1
      }
    }
    expect(on / total).toBeGreaterThan(RAIN_LINES.sparseDensity - 0.02)
    expect(on / total).toBeLessThan(RAIN_LINES.sparseDensity + 0.02)
    // 每顆至少連亮 2 影格。 / Each streak lasts at least two frames.
    for (let index = 0; index < 20; index += 1) {
      for (let frame = 0; frame < 40; frame += RAIN_LINES.streakFrames) {
        expect(sample('full-on', frame, index, true)).toBe(sample('full-on', frame + 1, index, true))
      }
    }
  })

  it('makes random-fill streaks only where the dry fill has lit', () => {
    const parameters = { fillSeconds: 5, acceleration: 1, ledFadeSeconds: 0, holdSeconds: 5, fadeOutSeconds: 0 }
    for (const frame of [50, 150, 300]) {
      for (let index = 0; index < LEDS; index += 1) {
        if (sample('random-fill', frame, index, true, parameters) > 0) {
          expect(sample('random-fill', frame, index, false, parameters)).toBe(1)
        }
      }
    }
  })

  it('gives comet-tail a thin head ring and streaks that thin out along the tail', () => {
    const parameters = { periodSeconds: 4, tailLength: 0.5 }
    const head = 40
    // 頭在燈帶 0.25 處。 / Head at strip position 0.25.
    const near = (index: number) => {
      const behind = (0.25 - index / (LEDS - 1) + 1) % 1
      return behind
    }
    let close = 0
    let far = 0
    for (let frame = head; frame < head + 4000; frame += 160) {
      for (let index = 0; index < LEDS; index += 1) {
        const behind = near(index)
        const on = sample('comet-tail', frame, index, true, parameters)
        if (behind > 0.02 && behind < 0.15) close += on
        if (behind > 0.35 && behind < 0.48) far += on
        if (behind > 0.55 && behind < 0.98) expect(on).toBe(0)
      }
    }
    expect(close).toBeGreaterThan(far * 2)
  })
})

describe('rain ring', () => {
  it('keeps two LEDs of energy wherever the ring sits', async () => {
    const { rainRing } = await import('../src/effects/rain')
    const pixel = 2 / (LEDS - 1)
    for (const offset of [0, 0.1, 0.25, 0.5, 0.8]) {
      const total = [-3, -2, -1, 0, 1, 2, 3].reduce((sum, step) => sum + rainRing((step - offset) * pixel, LEDS), 0)
      expect(total).toBeCloseTo(2)
    }
  })
})
