import { describe, expect, it } from 'vitest'
import { moonCorrectionGain, moonCorrectionGains } from '../src/hardware'

// 數值與後端 hardware.moon_correction_gain 相同（backend/tests/test_hardware.py）。
// Same values as backend hardware.moon_correction_gain (backend/tests/test_hardware.py).
describe('LongN moon correction', () => {
  it('fades both feet over 15 LEDs and dims the apex to 0.3 over 7', () => {
    const gains = Array.from({ length: 152 }, (_, index) => moonCorrectionGain(index, 152))
    expect(gains).toEqual([...gains].reverse())
    expect(gains[0]).toBeCloseTo(1 / 15)
    expect(gains[14]).toBe(1)
    expect(gains.slice(15, 69)).toEqual(Array(54).fill(1))
    expect(gains[69]).toBeCloseTo(0.3 + 0.7 * 6 / 7)
    expect(gains[75]).toBeCloseTo(0.3)
    expect(gains[76]).toBeCloseTo(0.3)
    expect(moonCorrectionGain(0, 1)).toBeCloseTo(1 / 15)
    expect(() => moonCorrectionGain(152, 152)).toThrow(RangeError)
  })

  it('applies only when enabled and at max speed', () => {
    expect(moonCorrectionGains(152, true, 'max')).toHaveLength(152)
    expect(moonCorrectionGains(152, true, 'mid')).toBeNull()
    expect(moonCorrectionGains(152, false, 'max')).toBeNull()
  })
})
