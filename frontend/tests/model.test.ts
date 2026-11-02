import { describe, expect, it } from 'vitest'
import {
  angleAtTime,
  buildUnitLayouts,
  buildTemporalSamples,
  controllerFrameAtTime,
  controllerFrameStartTime,
  DEFAULT_SETTINGS,
  NINE_UNIT_ARCH_HEIGHT,
  NINE_UNIT_SPACING,
  degreesPerControllerFrame,
  normalizedAngle,
  simulatedUnknownPhase,
  stripCoordinate,
  unitRelativeHeightAtPhase,
} from '../src/simulation/model'
import { LEDS_PER_ARC } from '../src/preview3d/geometry'

describe('rotor and controller clocks', () => {
  it('rotates 54 degrees during one 40 FPS frame at 360 RPM', () => {
    expect(degreesPerControllerFrame(360, 40)).toBe(54)
  })

  it('keeps the LED frame unchanged inside each 25 ms interval', () => {
    expect(controllerFrameAtTime(0.024999, 40)).toBe(0)
    expect(controllerFrameAtTime(0.025, 40)).toBe(1)
  })

  it('returns to the same nominal phase after 20 controller frames', () => {
    const angleAtStart = normalizedAngle(angleAtTime(0, 360))
    const angleAtTwentyFrames = normalizedAngle(angleAtTime(20 / 40, 360))
    expect(angleAtTwentyFrames).toBeCloseTo(angleAtStart, 10)
  })
})

describe('open-loop top-third sampling', () => {
  it('keeps one Art-Net LED choice while the rotor leaves the top 120-degree sector', () => {
    const localLed = [-1, 0, 0] as const
    const initialPhase = 320 * Math.PI / 180
    const frame = controllerFrameAtTime(0.024, 40)
    const heldAngle = angleAtTime(controllerFrameStartTime(frame, 40), 360, initialPhase)
    const actualAngle = angleAtTime(0.024, 360, initialPhase)
    const heightAt = (angle: number) => unitRelativeHeightAtPhase(
      localLed, Math.cos(angle), Math.sin(angle), 0, 1, 1,
    )

    expect(frame).toBe(0)
    expect(heightAt(heldAngle)).toBeGreaterThan(0.5)
    expect(heightAt(actualAngle)).toBeLessThan(0.5)
    expect(controllerFrameStartTime(controllerFrameAtTime(0.025, 40), 40))
      .toBe(0.025)
  })

  it('assigns different unknown startup phases per unit and reset', () => {
    const first = simulatedUnknownPhase(0, 0)
    expect(first).toBeGreaterThanOrEqual(0)
    expect(first).toBeLessThan(Math.PI * 2)
    expect(simulatedUnknownPhase(0, 0)).toBe(first)
    expect(simulatedUnknownPhase(1, 0)).not.toBe(first)
    expect(simulatedUnknownPhase(0, 1)).not.toBe(first)
  })
})
describe('3D semicircle effect mapping', () => {
  it('uses the tested 156 LED positions for each arc', () => {
    expect(DEFAULT_SETTINGS.ledCount).toBe(LEDS_PER_ARC)
    expect(LEDS_PER_ARC).toBe(156)
  })
})

describe('diameter strip geometry', () => {
  it('places one LED strip across both sides of the rotor center', () => {
    expect(stripCoordinate(0, 5, 3)).toBe(-3)
    expect(stripCoordinate(2, 5, 3)).toBe(0)
    expect(stripCoordinate(4, 5, 3)).toBe(3)
  })

  it('keeps an even LED count symmetric around the center', () => {
    expect(stripCoordinate(0, 48, 3.35)).toBeCloseTo(-3.35)
    expect(stripCoordinate(47, 48, 3.35)).toBeCloseTo(3.35)
    expect(stripCoordinate(23, 48, 3.35)).toBeCloseTo(
      -stripCoordinate(24, 48, 3.35),
    )
  })
})

describe('multi-unit layout', () => {
  it('lays the nine units on a circular arc peaking at Unit 5', () => {
    const units = buildUnitLayouts('nine', 40, 2)

    expect(DEFAULT_SETTINGS.unitPhaseStepDegrees).toBe(40)

    expect(units).toHaveLength(9)
    units.forEach((unit, index) => {
      expect(unit.index).toBe(index)
      expect(unit.x).toBeCloseTo((index - 4) * NINE_UNIT_SPACING)
      expect(unit.y).toBeCloseTo(units[8 - index].y)
      expect(unit.tiltXRadians).toBeCloseTo(Math.PI / 2)
      expect(unit.frameOffset).toBe(index * 2)
    })
    expect(units[0].y).toBeCloseTo(0)
    expect(units[4].y).toBeCloseTo(NINE_UNIT_ARCH_HEIGHT)
    const centerY = units[4].y - Math.hypot(units[0].x, units[0].y - units[4].y) ** 2
      / (2 * (units[4].y - units[0].y))
    units.forEach((unit) => {
      expect(Math.hypot(unit.x, unit.y - centerY)).toBeCloseTo(units[4].y - centerY)
    })
  })

  it('turns each outer pair toward Unit 5 by another 45 degrees', () => {
    const units = buildUnitLayouts('nine', 40, 2)

    units.forEach((unit, index) => {
      expect(unit.yawRadians).toBeCloseTo((4 - index) * Math.PI / 4)
    })
  })

  it('preserves the original per-unit rotor phase offsets', () => {
    const units = buildUnitLayouts('nine', 40, 2)

    units.forEach((unit, index) => {
      expect(unit.phaseOffsetRadians).toBeCloseTo(
        index * 40 * Math.PI / 180,
      )
    })
  })

  it('keeps single-unit mode unshifted and full scale', () => {
    expect(buildUnitLayouts('single', 40, 2)).toEqual([{
      index: 0,
      x: 0,
      y: 0,
      scale: 1,
      phaseOffsetRadians: 0,
      tiltXRadians: Math.PI / 2,
      yawRadians: 0,
      frameOffset: 0,
    }])
  })
})

describe('temporal exposure samples', () => {
  it('normalizes exposure and persistence weights', () => {
    const samples = buildTemporalSamples(1, 25, 45, 64)
    const totalWeight = samples.reduce((sum, sample) => sum + sample.weight, 0)
    expect(samples).toHaveLength(64)
    expect(totalWeight).toBeCloseTo(1, 10)
    expect(samples[0].timeSeconds).toBe(1)
    expect(samples.at(-1)!.timeSeconds).toBeLessThan(0.8)
  })

  it('uses one current-time sample when blur is disabled', () => {
    expect(buildTemporalSamples(2, 0, 0, 64)).toEqual([
      { timeSeconds: 2, weight: 1 },
    ])
  })
})
