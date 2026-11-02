import { describe, expect, it } from 'vitest'
import { frontFacingBrightness } from '../src/simulation/scene/facing'

describe('camera-facing LED emission', () => {
  it('keeps LEDs facing the camera bright', () => {
    expect(frontFacingBrightness(0, 0, 1, 0, 0, 0, 0, 0, 10)).toBe(1)
  })

  it('turns away-facing and edge-on LEDs fully dark', () => {
    expect(frontFacingBrightness(0, 0, -1, 0, 0, 0, 0, 0, 10)).toBe(0)
    expect(frontFacingBrightness(1, 0, 0, 0, 0, 0, 0, 0, 10)).toBe(0)
  })

  it('responds to camera position', () => {
    expect(frontFacingBrightness(0, 0, -1, 0, 0, 0, 0, 0, -10)).toBe(1)
  })
})
