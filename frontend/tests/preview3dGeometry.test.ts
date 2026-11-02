import { describe, expect, it } from 'vitest'
import {
  buildSemicircleLedPositions,
  LEDS_PER_ARC,
  semicirclePoint,
} from '../src/preview3d/geometry'

function distance(
  a: readonly number[],
  b: readonly number[],
): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function expectPointClose(
  actual: readonly number[],
  expected: readonly number[],
) {
  actual.forEach((value, index) => {
    expect(value).toBeCloseTo(expected[index], 12)
  })
}

describe('3D semicircle geometry', () => {
  it('places perpendicular arcs around the same local origin', () => {
    expectPointClose(semicirclePoint(2.5, 0, 'xy'), [-2.5, 0, 0])
    expectPointClose(semicirclePoint(2.5, 1, 'xy'), [2.5, 0, 0])
    expectPointClose(semicirclePoint(2.5, 0, 'zy'), [0, 0, -2.5])
    expectPointClose(semicirclePoint(2.5, 1, 'zy'), [0, 0, 2.5])
  })

  it('reaches the same apex on both planes', () => {
    expectPointClose(semicirclePoint(2.5, 0.5, 'xy'), [0, 2.5, 0])
    expectPointClose(semicirclePoint(2.5, 0.5, 'zy'), [0, 2.5, 0])
  })

  it('distributes an equal LED count at uniform chord spacing', () => {
    const firstArc = buildSemicircleLedPositions(2.5, LEDS_PER_ARC, 'xy', -0.035)
    const secondArc = buildSemicircleLedPositions(2.5, LEDS_PER_ARC, 'zy', 0.035)
    const firstDistances = firstArc.slice(1).map(
      (point, index) => distance(firstArc[index], point),
    )

    expect(LEDS_PER_ARC).toBe(156)
    expect(firstArc).toHaveLength(156)
    expect(secondArc).toHaveLength(156)
    expect(Math.max(...firstDistances) - Math.min(...firstDistances))
      .toBeLessThan(1e-10)
  })
})
