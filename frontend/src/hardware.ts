/**
 * LongN 月亮校正，與後端 hardware.moon_correction_gain 相同：全速時兩腳漸暗、頂點壓暗。
 * LongN moon correction, same as backend hardware.moon_correction_gain: at max speed the feet fade
 * in and the apex is dimmed.
 */
export const FOOT_FADE_PIXELS = 15
export const APEX_FADE_PIXELS = 7
export const APEX_MIN_GAIN = 0.3

export function moonCorrectionGain(index: number, count: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new RangeError('LED index out of range')
  const fromFoot = Math.min(index, count - 1 - index)
  const fromApex = Math.floor((count - 1) / 2) - fromFoot
  if (fromFoot < FOOT_FADE_PIXELS) return (fromFoot + 1) / FOOT_FADE_PIXELS
  if (fromApex < APEX_FADE_PIXELS) return APEX_MIN_GAIN + (1 - APEX_MIN_GAIN) * fromApex / APEX_FADE_PIXELS
  return 1
}

/** Gains for a whole strip, or null when the correction does not apply. */
export function moonCorrectionGains(count: number, enabled: boolean, speed: string): number[] | null {
  if (!enabled || speed !== 'max') return null
  return Array.from({ length: count }, (_, index) => moonCorrectionGain(index, count))
}
