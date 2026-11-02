import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyBackendPreset, getBackendSequence, getBackendState, saveBackendSequence, setBackendMotor } from '../src/backendApi'
import { createDefaultEffectPreset } from '../src/effects'

afterEach(() => vi.unstubAllGlobals())

describe('backend preset API', () => {
  it('loads state through the same-origin API path', async () => {
    const preset = createDefaultEffectPreset('random-leds')
    const state = { revision: 2, preset, motor: { channel: 469, enabled: false, value: 0 }, output: { ip: '192.0.2.5', universe: 0, fps: 40, rpm: 360, unitId: 1, unitCount: 9 } }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => state })
    vi.stubGlobal('fetch', fetchMock)
    expect(await getBackendState()).toEqual(state)
    expect(fetchMock).toHaveBeenCalledWith('/api/state', { cache: 'no-store' })
  })

  it('sends a complete preset only when apply is invoked', async () => {
    const preset = createDefaultEffectPreset('center-out-sine')
    const state = { revision: 3, preset, motor: { channel: 469, enabled: false, value: 0 }, output: { ip: '192.0.2.5', universe: 0, fps: 40, rpm: 360, unitId: 1, unitCount: 9 } }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => state })
    vi.stubGlobal('fetch', fetchMock)
    expect(await applyBackendPreset(preset)).toEqual(state)
    expect(fetchMock).toHaveBeenCalledWith('/api/preset', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(preset),
    })
  })

  it('loads and saves the same sequence document through the backend API', async () => {
    const sequence = {
      schemaVersion: 1 as const,
      ending: { kind: 'hold' as const },
      steps: [{
        id: 1,
        preset: createDefaultEffectPreset('center-out-sine'),
        playback: { kind: 'count' as const, count: 1 },
        transition: { kind: 'cut' as const, seconds: 0.5 },
      }],
    }
    const state = { revision: 3, sequence, playbackMode: 'sequence', output: { fps: 40, rpm: 360, unitCount: 9 } }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => state })
    vi.stubGlobal('fetch', fetchMock)
    expect(await getBackendSequence()).toEqual(state)
    expect(fetchMock).toHaveBeenCalledWith('/api/sequence', {
      cache: 'no-store',
    })
    expect(await saveBackendSequence(sequence)).toEqual(state)
    expect(fetchMock).toHaveBeenCalledWith('/api/sequence', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sequence),
    })
  })

  it('surfaces backend validation errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 422, json: async () => ({ error: 'invalid effect parameters' }),
    }))
    await expect(applyBackendPreset(createDefaultEffectPreset('random-leds')))
      .rejects.toThrow('invalid effect parameters')
  })

  it('sends a separate boolean motor command', async () => {
    const state = { motor: { channel: 469, enabled: true, value: 255 } }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => state })
    vi.stubGlobal('fetch', fetchMock)
    expect(await setBackendMotor(true)).toEqual(state)
    expect(fetchMock).toHaveBeenCalledWith('/api/motor', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{"enabled":true}',
    })
  })
})
