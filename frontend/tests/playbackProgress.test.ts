import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBackendPlayback, type SequencePlayback, type SinglePlayback } from '../src/backendApi'
import { advancedFrames, liveBackendFrame, PLAYBACK_STALE_MS, projectSequence, projectSingle } from '../src/playbackProgress'

afterEach(() => vi.unstubAllGlobals())

function sequence(overrides: Partial<SequencePlayback> = {}): SequencePlayback {
  return {
    active: true, mode: 'sequence', restart: 1, fps: 40, ageMs: 0, frame: 41,
    sequenceFrame: 41, totalFrames: 80, ending: 'hold', loopIteration: 1, ended: false, endFade: null,
    step: { index: 1, id: 3, effectId: 'spectrum-cycle', elapsed: 1, duration: 40, repeat: { current: 1, total: 2 } },
    transition: { kind: 'crossfade', fromIndex: 0, elapsed: 1, frames: 4 },
    ...overrides,
  }
}

describe('backend playback progress', () => {
  it('extrapolates the live frame for the 3D view until polls go stale', () => {
    expect(liveBackendFrame(sequence({ ageMs: 25 }), 475)).toBe(61)
    expect(liveBackendFrame(sequence(), 10)).toBeCloseTo(41.4)
    expect(liveBackendFrame(sequence(), PLAYBACK_STALE_MS + 1)).toBeNull()
    expect(liveBackendFrame({ active: false }, 0)).toBeNull()
    expect(liveBackendFrame(null, 0)).toBeNull()
  })

  it('counts frames from the backend sample age plus local time', () => {
    expect(advancedFrames(40, 0, 0)).toBe(0)
    expect(advancedFrames(40, 25, 0)).toBe(1)
    expect(advancedFrames(40, 10, 490)).toBe(20)
  })

  it('advances within the step, recomputing repeat and transition state', () => {
    const progress = projectSequence(sequence(), 500)
    expect(progress.stepElapsed).toBe(21)
    expect(progress.sequenceFrame).toBe(61)
    expect(progress.repeat).toEqual({ current: 2, total: 2 })
    expect(progress.transitionActive).toBe(false)
    expect(projectSequence(sequence(), 50).transitionActive).toBe(true)
  })

  it('holds at the step end instead of guessing the next step', () => {
    const progress = projectSequence(sequence(), 10_000)
    expect(progress.stepElapsed).toBe(39)
    expect(progress.sequenceFrame).toBe(79)
    expect(progress.repeat).toEqual({ current: 2, total: 2 })
  })

  it('fills the bars after the sequence ends and advances the end fade', () => {
    const held = projectSequence(sequence({ ended: true, transition: null }), 1_000)
    expect(held).toMatchObject({ stepElapsed: 40, sequenceFrame: 80, fadeElapsed: null })
    const fading = sequence({ ended: true, ending: 'fade-black', transition: null, endFade: { elapsed: 1, frames: 8 } })
    expect(projectSequence(fading, 100).fadeElapsed).toBe(5)
    expect(projectSequence(fading, 5_000).fadeElapsed).toBe(8)
  })

  it('advances single-effect cycles', () => {
    const single: SinglePlayback = {
      active: true, mode: 'single', restart: 2, fps: 40, ageMs: 0, frame: 35,
      effectId: 'center-out-sine', cycle: { current: 2, elapsed: 15, frames: 20 },
    }
    expect(projectSingle(single, 250).cycle).toEqual({ current: 3, elapsed: 5, frames: 20 })
    expect(projectSingle({ ...single, cycle: null }, 1_000)).toEqual({ frame: 75, cycle: null })
  })

  it('reads the playback API and treats a missing route as unsupported', async () => {
    const state = { active: false }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => state })
    vi.stubGlobal('fetch', fetchMock)
    expect(await getBackendPlayback()).toEqual(state)
    expect(fetchMock).toHaveBeenCalledWith('/api/playback', { cache: 'no-store' })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'not found' }) }))
    expect(await getBackendPlayback()).toBeNull()
  })
})
