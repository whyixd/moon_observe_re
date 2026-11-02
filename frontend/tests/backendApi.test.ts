import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyBackendPreset, getBackendSequence, getBackendState, saveBackendSequence, setBackendMoonCorrection, setBackendMotor } from '../src/backendApi'
import { createDefaultEffectPreset } from '../src/effects'

afterEach(() => vi.unstubAllGlobals())

describe('backend preset API', () => {
  it('loads state through the same-origin API path', async () => {
    const preset = createDefaultEffectPreset('random-leds')
    const state = { revision: 2, preset, motor: { revision: 0, units: [] }, output: { fps: 40, pixels: 152, unitCount: 5, motorRpm: { mid: 130, max: 500 }, sourceIp: null, targets: [] } }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => state })
    vi.stubGlobal('fetch', fetchMock)
    expect(await getBackendState()).toEqual(state)
    expect(fetchMock).toHaveBeenCalledWith('/api/state', { cache: 'no-store' })
  })

  it('sends a complete preset only when apply is invoked', async () => {
    const preset = createDefaultEffectPreset('center-out-sine')
    const state = { revision: 3, preset, motor: { revision: 0, units: [] }, output: { fps: 40, pixels: 152, unitCount: 5, motorRpm: { mid: 130, max: 500 }, sourceIp: null, targets: [] } }
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
    const state = { revision: 3, sequence, playbackMode: 'sequence', output: { fps: 40, pixels: 152, unitCount: 5, motorRpm: { mid: 130, max: 500 } } }
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

  it('sends per-unit motor commands and the moon-correction switch', async () => {
    const state = { motor: { units: [{ unitId: 2, speed: 'max', direction: 'ccw' }] } }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => state })
    vi.stubGlobal('fetch', fetchMock)
    expect(await setBackendMotor({ unitIds: [2], speed: 'max', direction: 'ccw' })).toEqual(state)
    expect(fetchMock).toHaveBeenCalledWith('/api/motor', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{"unitIds":[2],"speed":"max","direction":"ccw"}',
    })
    await setBackendMotor({ speed: 'stop' })
    expect(fetchMock).toHaveBeenLastCalledWith('/api/motor', expect.objectContaining({ body: '{"speed":"stop"}' }))
    await setBackendMoonCorrection(false)
    expect(fetchMock).toHaveBeenLastCalledWith('/api/hardware', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{"moonCorrection":false}',
    })
  })
})
