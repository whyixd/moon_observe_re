import { describe, expect, it } from 'vitest'
import { centerOutSine } from '../src/effects/centerOutSine'
import { unitPalettePosition } from '../src/effects/randomFill'
import { rouletteRing, rouletteTiming } from '../src/effects/rouletteRing'
import { spectrumCycle } from '../src/effects/spectrumCycle'
import { unitChase } from '../src/effects/unitChase'
import { unitRandom, unitTurn } from '../src/effects/unitRandom'
import {
  createDefaultEffectPreset,
  createEffectContext,
  EFFECT_MANIFEST,
  EFFECT_SCHEMA_VERSION,
  getEffectCompletion,
  getVariableParameters,
  ignoresWeatherTiming,
  axisChangeWeight,
  sampleEffect,
  withWeatherPalette,
} from '../src/effects'

function energy(color: { r: number; g: number; b: number }): number {
  return color.r + color.g + color.b
}

describe('effect synchronization contract', () => {
  it('exposes stable unique IDs as JSON-compatible metadata', () => {
    const encoded = JSON.stringify(EFFECT_MANIFEST)
    const decoded = JSON.parse(encoded) as typeof EFFECT_MANIFEST
    const ids = decoded.map((effect) => effect.id)

    expect(new Set(ids).size).toBe(ids.length)
    expect(decoded.find((effect) => effect.id === 'sequential-center-fill')?.label).toBe('逐月')
    expect(decoded.find((effect) => effect.id === 'periodic-leds')?.label).toBe('落雨')
    expect(decoded.find((effect) => effect.id === 'random-leds')?.label).toBe('隨機亮點')
    expect(decoded.find((effect) => effect.id === 'world-upper-half')?.label).toBe('空間上方 1/3 圓')
    expect(ids).toEqual([
      'spectrum-cycle',
      'center-out-sine',
      'moving-rings',
      'sequential-center-fill',
      'periodic-leds',
      'random-leds',
      'world-upper-half',
      'reverse-tide',
      'wide-rings',
      'comet-tail',
      'stardust-cloud',
      'color-breathing',
      'sector-smear',
      'twenty-beat',
      'sine-swell',
      'random-fill',
      'full-on',
      'unit-chase',
      'unit-random',
      'roulette-ring',
    ])
    expect(decoded.every(
      (effect) => effect.schemaVersion === EFFECT_SCHEMA_VERSION,
    )).toBe(true)
  })

  it('derives symmetric radius coordinates across a diameter strip', () => {
    const left = createEffectContext(0, 40, 18, 101)
    const right = createEffectContext(0, 40, 82, 101)

    expect(left.normalizedRadius).toBeCloseTo(0.64)
    expect(right.normalizedRadius).toBeCloseTo(0.64)
  })
})

describe('空間上方 1/3 圓 effect', () => {
  it('lights a complete half-strip only during its upper 120-degree window', () => {
    const preset = createDefaultEffectPreset('world-upper-half')
    const litIndices = (projection: number) => Array.from({ length: 156 }, (_, index) => index)
      .filter((index) => energy(sampleEffect(
        preset,
        createEffectContext(5, 40, index, 156, 4, 9, 5, 0, projection),
      )) > 0)

    expect(litIndices(0.49)).toEqual([])
    expect(litIndices(0.5)).toEqual([])
    expect(litIndices(0.51)).toEqual(Array.from({ length: 78 }, (_, index) => index))
    expect(litIndices(1)).toEqual(litIndices(0.51))
    expect(litIndices(-0.51)).toEqual(Array.from({ length: 78 }, (_, index) => index + 78))
    expect(litIndices(0)).toEqual([])
  })

  it('smoothly fades the inner edge while keeping the outer LEDs fully bright', () => {
    const preset = createDefaultEffectPreset('world-upper-half')
    const brightness = (index: number) => sampleEffect(
      preset,
      createEffectContext(5, 40, index, 156, 0, 1, 5, 0, 1),
    ).r

    expect(brightness(0)).toBe(1)
    expect(brightness(50)).toBe(1)
    expect(brightness(65)).toBeGreaterThan(brightness(72))
    expect(brightness(72)).toBeGreaterThan(brightness(77))
    expect(brightness(77)).toBeGreaterThan(0)
    expect(brightness(78)).toBe(0)
  })
})

describe('隨機亮點 effect', () => {
  const litIndices = (frame: number, litCount: number, unitIndex = 0, holdFrames = 4) => {
    const preset = createDefaultEffectPreset('random-leds')
    preset.parameters.litCount = litCount
    preset.parameters.holdFrames = holdFrames
    return Array.from({ length: 156 }, (_, ledIndex) => ledIndex)
      .filter((ledIndex) => energy(sampleEffect(
        preset,
        createEffectContext(frame, 40, ledIndex, 156, unitIndex, 9),
      )) > 0)
  }

  it('lights exactly the configured number of distinct LEDs per semicircle', () => {
    for (const count of [1, 12, 156]) {
      expect(litIndices(0, count)).toHaveLength(count)
      expect(litIndices(1, count)).toHaveLength(count)
    }
  })

  it('is reproducible within a frame and changes across frames and units', () => {
    const initial = litIndices(0, 12)
    expect(litIndices(0, 12)).toEqual(initial)
    expect(litIndices(3, 12)).toEqual(initial)
    expect(litIndices(4, 12)).not.toEqual(initial)
    expect(litIndices(0, 12, 1)).not.toEqual(initial)
  })

  it('respects the configured change interval', () => {
    expect(litIndices(0, 12, 0, 1)).not.toEqual(litIndices(1, 12, 0, 1))
    expect(litIndices(0, 12, 0, 8)).toEqual(litIndices(7, 12, 0, 8))
    expect(litIndices(0, 12, 0, 8)).not.toEqual(litIndices(8, 12, 0, 8))
  })

  it('shortens outer exposure by radius while retaining the equal-duration mode', () => {
    const preset = createDefaultEffectPreset('random-leds')
    preset.parameters.litCount = 156
    preset.parameters.holdFrames = 8
    preset.parameters.minHoldFrames = 1
    const lit = (frame: number, index: number) => energy(sampleEffect(
      preset, createEffectContext(frame, 40, index, 156),
    )) > 0

    preset.parameters.durationMode = 1
    expect(lit(0, 0)).toBe(true)
    expect(lit(1, 0)).toBe(false)
    expect(lit(1, 77)).toBe(true)
    expect(lit(7, 77)).toBe(true)
    expect(lit(8, 0)).toBe(true)

    preset.parameters.durationMode = 0
    expect(lit(7, 0)).toBe(true)
  })
})

describe('落雨 effect', () => {
  it('lights exactly twelve single LEDs with twelve dark LEDs between them', () => {
    const preset = createDefaultEffectPreset('periodic-leds')
    const litIndices = Array.from({ length: 156 }, (_, ledIndex) => ledIndex)
      .filter((ledIndex) => energy(sampleEffect(
        preset,
        createEffectContext(0, 40, ledIndex, 156),
      )) > 0)

    expect(litIndices).toEqual(
      Array.from({ length: 12 }, (_, index) => index * 13),
    )
  })

  it('moves the configured lights around the semicircle and returns after one period', () => {
    const preset = createDefaultEffectPreset('periodic-leds')
    preset.parameters.litCount = 3
    preset.parameters.darkGap = 2
    preset.parameters.periodSeconds = 4

    const litIndices = (frame: number) => Array.from({ length: 156 }, (_, ledIndex) => ledIndex)
      .filter((ledIndex) => energy(sampleEffect(
        preset,
        createEffectContext(frame, 40, ledIndex, 156),
      )) > 0)

    expect(litIndices(0)).toEqual([0, 3, 6])
    expect(litIndices(40)).toEqual([39, 42, 45])
    expect(litIndices(158)).toEqual([1, 4, 154])
    expect(litIndices(160)).toEqual([0, 3, 6])
  })

  it('changes motion speed with the configured period', () => {
    const preset = createDefaultEffectPreset('periodic-leds')
    preset.parameters.litCount = 1
    preset.parameters.periodSeconds = 2

    const litIndices = (frame: number) => Array.from({ length: 156 }, (_, ledIndex) => ledIndex)
      .filter((ledIndex) => energy(sampleEffect(
        preset,
        createEffectContext(frame, 40, ledIndex, 156),
      )) > 0)

    expect(litIndices(40)).toEqual([78])
    expect(litIndices(80)).toEqual([0])
  })

  it('supports a 0.01-second movement period', () => {
    const period = EFFECT_MANIFEST.find((effect) => effect.id === 'periodic-leds')
      ?.parameters.find((parameter) => parameter.key === 'periodSeconds')
    expect(period).toMatchObject({ min: 0.01, step: 0.01 })

    const preset = createDefaultEffectPreset('periodic-leds')
    preset.parameters.litCount = 1
    preset.parameters.periodSeconds = 0.01

    expect(sampleEffect(preset, createEffectContext(1, 40, 78, 156)))
      .toEqual({ r: 1, g: 1, b: 1 })
    expect(sampleEffect(preset, createEffectContext(1, 40, 0, 156)))
      .toEqual({ r: 0, g: 0, b: 0 })
  })

  it('can light every LED when the gap is zero', () => {
    const preset = createDefaultEffectPreset('periodic-leds')
    preset.parameters.litCount = 156
    preset.parameters.darkGap = 0

    for (let ledIndex = 0; ledIndex < 156; ledIndex += 1) {
      expect(sampleEffect(
        preset,
        createEffectContext(0, 40, ledIndex, 156),
      )).toEqual({ r: 1, g: 1, b: 1 })
    }
  })
})

describe('逐月 effect', () => {
  const sampleUnit = (
    frame: number,
    unitIndex: number,
    ledIndex: number,
  ) => sampleEffect(
    createDefaultEffectPreset('sequential-center-fill'),
    createEffectContext(frame, 40, ledIndex, 101, unitIndex, 9, frame),
  )

  it('fills Unit 1 from the center while all other units stay dark', () => {
    const centerAfterOneSecond = sampleUnit(40, 0, 50)
    const edgeAfterOneSecond = sampleUnit(40, 0, 100)
    const unitTwoCenter = sampleUnit(40, 1, 50)

    expect(centerAfterOneSecond).toEqual({ r: 1, g: 1, b: 1 })
    expect(edgeAfterOneSecond).toEqual({ r: 0, g: 0, b: 0 })
    expect(unitTwoCenter).toEqual({ r: 0, g: 0, b: 0 })
  })

  it('keeps Unit 1 lit while Unit 2 starts filling', () => {
    const unitOneEdgeAtFullFill = sampleUnit(100, 0, 100)
    const unitOneDuringHold = sampleUnit(110, 0, 100)
    const unitOneAfterHandoff = sampleUnit(116, 0, 100)
    const unitTwoAfterHandoff = sampleUnit(117, 1, 50)

    expect(unitOneEdgeAtFullFill).toEqual({ r: 1, g: 1, b: 1 })
    expect(unitOneDuringHold).toEqual({ r: 1, g: 1, b: 1 })
    expect(unitOneAfterHandoff).toEqual({ r: 1, g: 1, b: 1 })
    expect(energy(unitTwoAfterHandoff)).toBeGreaterThan(0)
  })

  it('keeps all nine units lit after the final expansion', () => {
    const cycleFrames = 9 * (100 + 16)

    for (const frame of [cycleFrames, cycleFrames + 400]) {
      for (let unitIndex = 0; unitIndex < 9; unitIndex += 1) {
        expect(sampleUnit(frame, unitIndex, 100)).toEqual({ r: 1, g: 1, b: 1 })
      }
    }
  })
})

describe('center-out sine effect', () => {
  it('starts bright at the center and propagates its peak outward', () => {
    const preset = createDefaultEffectPreset('center-out-sine')
    preset.parameters.speedHz = 0.3

    const centerAtStart = sampleEffect(
      preset,
      createEffectContext(0, 40, 50, 101),
    )
    const centerAtOneSecond = sampleEffect(
      preset,
      createEffectContext(40, 40, 50, 101),
    )
    const outwardPeakAtOneSecond = sampleEffect(
      preset,
      createEffectContext(40, 40, 60, 101),
    )

    expect(energy(centerAtStart)).toBeGreaterThan(energy(centerAtOneSecond))
    expect(energy(outwardPeakAtOneSecond)).toBeGreaterThan(
      energy(centerAtOneSecond),
    )
  })
})

describe('spectrum compatibility effect', () => {
  it('preserves the original first-frame edge color and brightness', () => {
    const color = sampleEffect(
      createDefaultEffectPreset('spectrum-cycle'),
      createEffectContext(0, 40, 0, 48),
    )

    expect(color.r).toBeCloseTo((0x47 / 255) * 0.42, 10)
    expect(color.g).toBeCloseTo((0xd7 / 255) * 0.42, 10)
    expect(color.b).toBeCloseTo(0.42, 10)
  })
})

describe('moving rings effect', () => {
  it('crossfades all default rings on the simulator 48-LED strip', () => {
    const preset = createDefaultEffectPreset('moving-rings')
    const pixels = Array.from({ length: 48 }, (_, ledIndex) => ({
      ledIndex,
      color: sampleEffect(
        preset,
        createEffectContext(0, 40, ledIndex, 48),
      ),
    }))
    const litPixels = pixels.filter(({ color }) => energy(color) > 0)
    const litRadii = [...new Set(litPixels.map(({ ledIndex }) => (
      createEffectContext(0, 40, ledIndex, 48).normalizedRadius
    )))].sort((a, b) => a - b)
    const radialStep = 2 / 47
    const ringGroups = litRadii.reduce<number[][]>((groups, radius) => {
      const current = groups.at(-1)
      if (!current || radius - current.at(-1)! > radialStep * 1.1) {
        groups.push([radius])
      } else {
        current.push(radius)
      }
      return groups
    }, [])

    expect(ringGroups).toHaveLength(3)
    expect(litPixels.every(({ color }) => (
      color.r === color.g && color.g === color.b
    ))).toBe(true)
    expect(litPixels.reduce((sum, { color }) => sum + color.r, 0)).toBeCloseTo(
      6,
      10,
    )
  })

  it('renders one pure-white LED on each side of a diameter', () => {
    const preset = createDefaultEffectPreset('moving-rings')
    preset.parameters.speedHz = 0.25
    preset.parameters.ringCount = 1

    const pixels = Array.from({ length: 101 }, (_, ledIndex) => ({
      ledIndex,
      color: sampleEffect(
        preset,
        createEffectContext(0, 40, ledIndex, 101),
      ),
    }))
    const litPixels = pixels.filter(({ color }) => energy(color) > 0)

    expect(litPixels.map(({ ledIndex }) => ledIndex)).toEqual([25, 75])
    expect(litPixels.every(({ color }) => (
      color.r === 1 && color.g === 1 && color.b === 1
    ))).toBe(true)
  })

  it('moves a single ring from the center to the circumference', () => {
    const preset = createDefaultEffectPreset('moving-rings')
    preset.parameters.speedHz = 0.25
    preset.parameters.ringCount = 1

    const initialCenter = sampleEffect(
      preset,
      createEffectContext(0, 40, 75, 101),
    )
    const oldCenterAfterQuarterCycle = sampleEffect(
      preset,
      createEffectContext(40, 40, 75, 101),
    )
    const newCenterAfterQuarterCycle = sampleEffect(
      preset,
      createEffectContext(40, 40, 100, 101),
    )

    expect(initialCenter).toEqual({ r: 1, g: 1, b: 1 })
    expect(oldCenterAfterQuarterCycle).toEqual({ r: 0, g: 0, b: 0 })
    expect(newCenterAfterQuarterCycle).toEqual({ r: 1, g: 1, b: 1 })
  })

  it('lets the innermost ring reach center and outermost reach circumference', () => {
    const preset = createDefaultEffectPreset('moving-rings')
    preset.parameters.speedHz = 0.25
    preset.parameters.ringCount = 3

    const outerAtPositiveLimit = sampleEffect(
      preset,
      createEffectContext(40, 40, 100, 101),
    )
    const innerAtNegativeLimit = sampleEffect(
      preset,
      createEffectContext(120, 40, 50, 101),
    )

    expect(outerAtPositiveLimit).toEqual({ r: 1, g: 1, b: 1 })
    expect(innerAtNegativeLimit).toEqual({ r: 1, g: 1, b: 1 })
  })

  it('moves adjacent rings in opposite directions without collision', () => {
    const preset = createDefaultEffectPreset('moving-rings')
    preset.parameters.speedHz = 0.25
    preset.parameters.ringCount = 2

    const litRadii = (frame: number) => [...new Set(
      Array.from({ length: 101 }, (_, ledIndex) => ({
        radius: createEffectContext(frame, 40, ledIndex, 101).normalizedRadius,
        color: sampleEffect(
          preset,
          createEffectContext(frame, 40, ledIndex, 101),
        ),
      }))
        .filter(({ color }) => energy(color) > 2.9)
        .map(({ radius }) => radius),
    )].sort((a, b) => a - b)

    expect(litRadii(0)).toEqual([0.24, 0.76])
    expect(litRadii(40)).toEqual([0.48, 0.52])
    expect(litRadii(40)[0]).toBeLessThan(litRadii(40)[1])
  })

  it('splits one LED of white energy between adjacent radial pixels', () => {
    const preset = createDefaultEffectPreset('moving-rings')
    preset.parameters.speedHz = 0.25
    preset.parameters.ringCount = 1

    const pixels = Array.from({ length: 101 }, (_, ledIndex) => ({
      ledIndex,
      color: sampleEffect(
        preset,
        createEffectContext(1, 40, ledIndex, 101),
      ),
    }))
    const litPixels = pixels.filter(({ color }) => energy(color) > 0)

    expect(litPixels.map(({ ledIndex }) => ledIndex)).toEqual([24, 25, 75, 76])
    expect(litPixels.every(({ color }) => (
      color.r > 0 && color.r < 1 &&
      color.r === color.g && color.g === color.b
    ))).toBe(true)
    expect(litPixels.reduce((sum, { color }) => sum + color.r, 0)).toBeCloseTo(
      2,
      10,
    )
  })
})

describe('effect color controls', () => {
  it('preserves the previous default colors across frames and LED positions', () => {
    for (const effect of [centerOutSine, spectrumCycle]) {
      const preset = createDefaultEffectPreset(effect.manifest.id)
      for (const frame of [0, 1, 4, 19, 20]) {
        for (const ledIndex of [0, 40, 77, 155]) {
          const context = createEffectContext(frame, 40, ledIndex, 156)
          const original = effect.sample(context, preset.parameters)
          const current = sampleEffect(preset, context)
          expect(current.r).toBeCloseTo(original.r, 10)
          expect(current.g).toBeCloseTo(original.g, 10)
          expect(current.b).toBeCloseTo(original.b, 10)
        }
      }
    }
  })
  it('accepts solid colors for every effect while keeping unlit LEDs black', () => {
    for (const effect of EFFECT_MANIFEST) {
      const preset = createDefaultEffectPreset(effect.id)
      preset.color = { mode: 'solid', color: { r: 1, g: 0, b: 0 } }
      // random-fill starts dark and lights its first LED after about 4.8 s.
      const frame = effect.id === 'random-fill' ? 400 : 40
      const colors = Array.from({ length: 156 }, (_, ledIndex) => sampleEffect(
        preset,
        createEffectContext(frame, 40, ledIndex, 156, 0, 1, frame, 1),
      ))
      expect(colors.some((color) => color.r > 0), effect.id).toBe(true)
      expect(colors.every((color) => color.g === 0 && color.b === 0), effect.id).toBe(true)
    }
  })

  it('maps gradient endpoints along the strip and mirrors a radial gradient', () => {
    const preset = createDefaultEffectPreset('periodic-leds')
    preset.parameters.litCount = 3
    preset.parameters.darkGap = 0
    preset.color = {
      mode: 'gradient',
      axis: 'strip',
      colors: [{ r: 1, g: 0, b: 0 }, { r: 0, g: 0, b: 1 }],
    }
    const at = (index: number) => sampleEffect(
      preset,
      createEffectContext(0, 40, index, 3, 0, 1, 0, 1),
    )
    expect(at(0)).toEqual({ r: 1, g: 0, b: 0 })
    expect(at(1)).toEqual({ r: 0.5, g: 0, b: 0.5 })
    expect(at(2)).toEqual({ r: 0, g: 0, b: 1 })

    preset.color = { ...preset.color, axis: 'radius' }
    expect(at(0)).toEqual(at(2))
    expect(at(1)).toEqual({ r: 1, g: 0, b: 0 })
    expect(at(0)).toEqual({ r: 0, g: 0, b: 1 })
  })

  it('keeps the spectrum gradient cycling and allows a solid override', () => {
    const preset = createDefaultEffectPreset('spectrum-cycle')
    const at = (frame: number) => sampleEffect(
      preset,
      createEffectContext(frame, 40, 0, 48),
    )
    expect(at(0)).not.toEqual(at(4))
    preset.color = { mode: 'solid', color: { r: 1, g: 0, b: 0 } }
    expect(at(0)).toEqual({ r: 0.42, g: 0, b: 0 })
    expect(at(4).r).toBeLessThan(at(0).r)
  })

  it('gives each unit one solid color sampled across the units', () => {
    const preset = createDefaultEffectPreset('color-breathing')
    preset.color = {
      mode: 'gradient', axis: 'unit', colors: [{ r: 1, g: 0, b: 0 }, { r: 0, g: 0, b: 1 }],
    }
    // Frame 0 of color-breathing is full brightness on every LED.
    const unitColors = (unitIndex: number, unitCount = 9) => new Set([0, 40, 77].map((led) => JSON.stringify(
      sampleEffect(preset, createEffectContext(0, 40, led, 156, unitIndex, unitCount)),
    )))

    expect(unitColors(0)).toEqual(new Set([JSON.stringify({ r: 1, g: 0, b: 0 })]))
    expect(unitColors(4)).toEqual(new Set([JSON.stringify({ r: 0.5, g: 0, b: 0.5 })]))
    expect(unitColors(8)).toEqual(new Set([JSON.stringify({ r: 0, g: 0, b: 1 })]))
    expect(unitColors(0, 1)).toEqual(new Set([JSON.stringify({ r: 1, g: 0, b: 0 })]))
  })
})

describe('random-fill', () => {
  const fps = 40
  const preset = createDefaultEffectPreset('random-fill')
  const brightness = (frame: number, led: number, unit = 0) => {
    const color = sampleEffect(preset, createEffectContext(frame, fps, led, 156, unit, 9))
    return Math.max(color.r, color.g, color.b)
  }
  const litCount = (frame: number, unit = 0) =>
    Array.from({ length: 156 }, (_, led) => brightness(frame, led, unit)).filter((value) => value > 0).length

  it('lights LEDs one by one in random order until the strip is full, then fades out', () => {
    expect(litCount(0)).toBe(0)
    // Lit count follows 156 * (t / 60 s)^2: the first LED at 60 * sqrt(1/156) ≈ 4.8 s, then faster and faster.
    const perFrame = Array.from({ length: 60 * fps + 1 }, (_, frame) => litCount(frame))
    perFrame.slice(1).forEach((count, frame) => expect(count - perFrame[frame]).toBeLessThanOrEqual(1))
    expect(perFrame[192 - 1]).toBe(0)
    expect(perFrame[192]).toBe(1)
    expect(perFrame[30 * fps]).toBe(39)
    expect(perFrame[60 * fps]).toBe(156)
    const firstHalf = perFrame[30 * fps] - perFrame[0]
    const secondHalf = perFrame[60 * fps] - perFrame[30 * fps]
    expect(secondHalf).toBeGreaterThan(2 * firstHalf)
    const counts = [10, 20, 30, 40, 50].map((seconds) => litCount(seconds * fps))
    counts.reduce((previous, count) => { expect(count).toBeGreaterThan(previous); return count }, 0)
    // Fill 60 s, then hold 5 s at full brightness and fade out over 3 s.
    expect(Array.from({ length: 156 }, (_, led) => brightness(65 * fps - 1, led)).every((value) => value === 1)).toBe(true)
    expect(litCount(68 * fps - 1)).toBe(0)
    expect(litCount(68 * fps)).toBe(0)
    expect(createEffectCompletionFrames()).toBe(68 * fps)
  })

  it('uses a different random order per unit and per round', () => {
    const order = (frame: number, unit: number) =>
      Array.from({ length: 156 }, (_, led) => brightness(frame, led, unit) > 0)
    expect(order(400, 0)).not.toEqual(order(400, 1))
    expect(order(400, 0)).not.toEqual(order(68 * fps + 400, 0))
  })

  it('gives each unit one solid palette color, skipping so neighbours are not adjacent', () => {
    const positions = Array.from({ length: 9 }, (_, unit) => unitPalettePosition(unit, 9) * 8)
    expect(positions.map(Math.round)).toEqual([0, 4, 8, 3, 7, 2, 6, 1, 5])
    positions.slice(1).forEach((position, index) =>
      expect(Math.abs(position - positions[index])).toBeGreaterThanOrEqual(4))
    expect(unitPalettePosition(0, 1)).toBe(0)

    for (const axis of ['unit', 'strip', 'radius'] as const) {
      const solid = { ...preset, color: { mode: 'gradient' as const, axis, colors: [{ r: 1, g: 0, b: 0 }, { r: 0, g: 0, b: 1 }] } }
      const colors = new Set([0, 77, 155].map((led) =>
        JSON.stringify(sampleEffect(solid, createEffectContext(61 * fps, fps, led, 156, 1, 9)))))
      expect(colors).toEqual(new Set([JSON.stringify({ r: 0.5, g: 0, b: 0.5 })]))
    }
  })

  function createEffectCompletionFrames() {
    return getEffectCompletion(preset, fps, 9)?.frames
  }
})

describe('weather palette', () => {
  const palette = { mode: 'gradient' as const, axis: 'radius' as const, colors: [{ r: 1, g: 0, b: 0 }, { r: 0, g: 0, b: 1 }] }

  it('swaps colors but keeps each gradient effect\'s own axis', () => {
    for (const axis of ['strip', 'radius', 'unit'] as const) {
      const preset = { ...createDefaultEffectPreset('sine-swell'), color: { mode: 'gradient' as const, axis, colors: [{ r: 1, g: 1, b: 1 }, { r: 0, g: 1, b: 0 }] } }
      expect(withWeatherPalette(preset, palette).color).toEqual({ ...palette, axis })
    }
  })

  it('gives solid effects the palette with its own axis', () => {
    const preset = { ...createDefaultEffectPreset('full-on'), color: { mode: 'solid' as const, color: { r: 1, g: 1, b: 1 } } }
    expect(withWeatherPalette(preset, palette).color).toEqual(palette)
  })

  it('keeps the effect\'s axis change', () => {
    const axisChange = { to: 'unit' as const, atSeconds: 2, blendSeconds: 1, repeat: false }
    const preset = { ...createDefaultEffectPreset('full-on'), color: { mode: 'gradient' as const, axis: 'strip' as const, axisChange, colors: [{ r: 1, g: 1, b: 1 }, { r: 0, g: 1, b: 0 }] } }
    expect(withWeatherPalette(preset, palette).color).toEqual({ ...palette, axis: 'strip', axisChange })
  })
})

describe('gradient axis change', () => {
  const fps = 40

  it('blends once from the effect axis to the new one', () => {
    const change = { to: 'unit' as const, atSeconds: 2, blendSeconds: 1, repeat: false }
    expect(axisChangeWeight(change, 0, fps)).toBe(0)
    expect(axisChangeWeight(change, 80, fps)).toBe(0)
    expect(axisChangeWeight(change, 100, fps)).toBe(0.5)
    expect(axisChangeWeight(change, 120, fps)).toBe(1)
    expect(axisChangeWeight(change, 10_000, fps)).toBe(1)
    expect(axisChangeWeight({ ...change, blendSeconds: 0 }, 79, fps)).toBe(0)
    expect(axisChangeWeight({ ...change, blendSeconds: 0 }, 80, fps)).toBe(1)
  })

  it('alternates when repeating, holding each axis', () => {
    const change = { to: 'unit' as const, atSeconds: 2, blendSeconds: 1, repeat: true }
    expect([0, 79, 100, 120, 199, 220, 240, 319, 340].map((frame) => axisChangeWeight(change, frame, fps)))
      .toEqual([0, 0, 0.5, 1, 1, 0.5, 0, 0, 0.5])
  })

  it('samples the old axis, the new axis, and a mix in between', () => {
    const colors = [{ r: 1, g: 0, b: 0 }, { r: 0, g: 0, b: 1 }]
    const base = { ...createDefaultEffectPreset('full-on'), color: { mode: 'gradient' as const, axis: 'strip' as const, colors } }
    const changing = { ...base, color: { ...base.color, axisChange: { to: 'unit' as const, atSeconds: 1, blendSeconds: 1, repeat: false } } }
    const unit = { ...base, color: { ...base.color, axis: 'unit' as const } }
    // LED 0 of unit 9: red on the strip axis, blue on the unit axis.
    const context = createEffectContext(0, fps, 0, 156, 8, 9)
    expect(sampleEffect(changing, context, 0)).toEqual(sampleEffect(base, context))
    expect(sampleEffect(changing, context, 80)).toEqual(sampleEffect(unit, context))
    const middle = sampleEffect(changing, context, 60)
    expect(middle.r).toBeCloseTo(0.5, 10)
    expect(middle.b).toBeCloseTo(0.5, 10)
  })
})

describe('unit-chase', () => {
  const fps = 40
  const level = (unit: number, frame: number, parameters: Record<string, number> = {}) => unitChase.sample(
    createEffectContext(frame, fps, 10, 78, unit, 9), { ...createDefaultEffectPreset('unit-chase').parameters, ...parameters },
  ).r
  const lit = (frame: number) => Array.from({ length: 9 }, (_, unit) => unit).filter((unit) => level(unit, frame) > 0)

  it('runs left to right, goes dark, then closes in from both sides and holds the centre', () => {
    // 預設：每步 20 影格、全暗 20、中間停留 80、結尾全暗 20 → 一輪 400 影格。
    // Defaults: 20-frame steps, 20 dark, 80 hold, 20 end dark -> a 400-frame round.
    expect(getEffectCompletion(createDefaultEffectPreset('unit-chase'), fps, 9)?.frames).toBe(400)
    expect(lit(0)).toEqual([0])
    expect(lit(19)).toEqual([0])
    expect(lit(20)).toEqual([1])
    expect(lit(179)).toEqual([8])
    expect(lit(180)).toEqual([])
    expect(lit(200)).toEqual([0, 8])
    expect(lit(220)).toEqual([1, 7])
    expect(lit(260)).toEqual([3, 5])
    expect(lit(280)).toEqual([4])
    expect(lit(379)).toEqual([4])
    expect(lit(380)).toEqual([])
    expect(lit(400)).toEqual([0])
    expect(level(4, 300)).toBe(1)
  })

  it('crossfades between steps and keeps one shared schedule', () => {
    expect(level(0, 20, { fadeSeconds: 0.25 })).toBeCloseTo(0.9, 10)
    expect(level(1, 20, { fadeSeconds: 0.25 })).toBeCloseTo(0.1, 10)
    expect(level(1, 29, { fadeSeconds: 0.25 })).toBe(1)
    expect(ignoresWeatherTiming('unit-chase')).toBe(true)
    expect(ignoresWeatherTiming('full-on')).toBe(false)
    expect(getVariableParameters('unit-chase')).toEqual([])
  })
})

describe('unit-random', () => {
  const fps = 40
  const parameters = createDefaultEffectPreset('unit-random').parameters
  const level = (unit: number, frame: number) =>
    unitRandom.sample(createEffectContext(frame, fps, 10, 78, unit, 9), parameters).r
  // 預設一台 = 停留 40 + 淡出 40 + 全暗 8 = 88 影格。 / Default turn = 40 hold + 40 fade out + 8 dark = 88 frames.
  const slot = 88

  it('lights exactly one unit per turn, fading out before the next', () => {
    expect(getEffectCompletion(createDefaultEffectPreset('unit-random'), fps, 9)?.frames).toBe(slot * 9)
    for (let turn = 0; turn < 40; turn += 1) {
      const lit = Array.from({ length: 9 }, (_, unit) => unit).filter((unit) => level(unit, turn * slot) > 0)
      expect(lit).toHaveLength(1)
      const [unit] = lit
      expect(level(unit, turn * slot + 39)).toBe(1)
      expect(level(unit, turn * slot + 60)).toBeCloseTo(1 - 21 / 40, 10)
      expect(level(unit, turn * slot + 80)).toBe(0)
    }
  })

  it('visits every unit once per round and never repeats a unit back to back', () => {
    let previous = -1
    for (let round = 0; round < 50; round += 1) {
      const order = Array.from({ length: 9 }, (_, turn) =>
        Array.from({ length: 9 }, (_, unit) => unit).find((unit) => unitTurn(round, unit, 9) === turn))
      expect(new Set(order).size).toBe(9)
      for (const unit of order) {
        expect(unit).not.toBe(previous)
        previous = unit!
      }
    }
    expect(ignoresWeatherTiming('unit-random')).toBe(true)
    expect(getVariableParameters('unit-random')).toEqual([])
  })
})

describe('roulette-ring', () => {
  const fps = 40
  const parameters = createDefaultEffectPreset('roulette-ring').parameters
  const level = (unit: number, frame: number, led = 39) =>
    rouletteRing.sample(createEffectContext(frame, fps, led, 78, unit, 9), parameters).r
  const litUnits = (frame: number, led = 39) =>
    Array.from({ length: 9 }, (_, unit) => unit).filter((unit) => level(unit, frame, led) > 0)

  it('bounces one unit at a time, slowing down, and stops on the centre unit', () => {
    const visits: { unit: number; frames: number }[] = []
    let frame = 0
    while (visits.length < 37) {
      const lit = litUnits(frame)
      expect(lit).toHaveLength(1)
      if (visits.at(-1)?.unit === lit[0] && visits.length > 0) visits.at(-1)!.frames += 1
      else visits.push({ unit: lit[0], frames: 1 })
      frame += 1
      if (frame > 4000) break
    }
    // 預設來回 4 趟：1→9→1→9→1，再走到 5。 / Four sweeps by default: 1→9→1→9→1, then on to 5.
    const sweep = [1, 2, 3, 4, 5, 6, 7, 8, 7, 6, 5, 4, 3, 2, 1, 0]
    expect(visits.map((visit) => visit.unit)).toEqual([0, ...sweep, ...sweep, 1, 2, 3, 4])
    const steps = visits.slice(0, -1).map((visit) => visit.frames)
    expect(steps[0]).toBe(2)
    expect(steps.at(-1)).toBeGreaterThanOrEqual(23)
    for (let index = 1; index < steps.length; index += 1) expect(steps[index]).toBeGreaterThanOrEqual(steps[index - 1])
  })

  it('darkens the centre unit from the middle out, keeps the rim LED, then spreads the rim outward and fades', () => {
    const cycle = getEffectCompletion(createDefaultEffectPreset('roulette-ring'), fps, 9)!.frames
    const { dimStart } = rouletteTiming(parameters, fps, 9)
    expect(level(4, dimStart - 1, 38)).toBe(1)
    const dimEnd = dimStart + 3 * fps
    expect(level(4, dimStart + 60, 38)).toBe(0)
    expect(level(4, dimStart + 60, 5)).toBe(1)
    expect(level(4, dimEnd - 1, 1)).toBe(0)
    expect(level(4, dimEnd - 1, 0)).toBe(1)
    expect(level(4, dimEnd - 1, 77)).toBe(1)
    expect(litUnits(dimEnd - 1, 0)).toEqual([4])
    // 外圈每 6 影格向外擴散一台。 / The rim spreads one unit outward every 6 frames.
    expect(litUnits(dimEnd, 0)).toEqual([4])
    expect(litUnits(dimEnd + 6, 0)).toEqual([3, 4, 5])
    expect(litUnits(dimEnd + 24, 0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(litUnits(dimEnd + 24, 39)).toEqual([])
    const glitchStart = dimEnd + 24 + 2 * fps
    expect(litUnits(glitchStart - 1, 0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    // 各台在 80 影格內隨機開始閃爍 48 影格，之後關閉；開始時間各不相同、每輪不同。
    // Each unit starts a 48-frame glitch at a random frame within 80, then stays off; starts differ per unit and round.
    const startsIn = (offset: number) => Array.from({ length: 9 }, (_, unit) => {
      let frame = offset + glitchStart
      while (level(unit, frame, 0) === 1 && frame < offset + glitchStart + 80 + 48) frame += 1
      return frame - offset - glitchStart
    })
    const first = startsIn(0)
    expect(new Set(first).size).toBeGreaterThan(3)
    expect(Math.max(...first)).toBeLessThanOrEqual(80)
    expect(startsIn(cycle)).not.toEqual(first)
    for (let unit = 0; unit < 9; unit += 1) {
      const window = Array.from({ length: 48 }, (_, offset) => level(unit, glitchStart + first[unit] + offset, 0))
      expect(window).toContain(0)
      expect(new Set(window.filter((value) => value !== 0))).toEqual(new Set([1]))
      expect(level(unit, glitchStart + first[unit] + 48, 0)).toBe(0)
    }
    expect(litUnits(glitchStart + 80 + 48, 0)).toEqual([])
    expect(cycle).toBe(glitchStart + 80 + 48 + 20)
    expect(litUnits(cycle)).toEqual([0])
    expect(ignoresWeatherTiming('roulette-ring')).toBe(true)
    expect(getVariableParameters('roulette-ring')).toEqual([])
  })
})
