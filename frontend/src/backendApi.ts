import type { EffectPreset, RgbColor } from './effects'
import type { SequenceDocument } from './simulation/sequence'

export type BackendState = {
  revision: number
  preset: EffectPreset
  motor: { channel: number; enabled: boolean; value: number }
  output: {
    ip: string
    universe: number
    fps: number
    rpm: number
    unitId: number
    unitCount: number
  }
}

export type BackendSequenceState = {
  revision: number
  sequence: SequenceDocument
  playbackMode: 'sequence' | 'single'
  output: { fps: number; rpm: number; unitCount: number }
}

async function readState<T>(response: Response): Promise<T> {
  let body: T & { error?: string }
  try {
    body = await response.json() as T & { error?: string }
  } catch {
    throw new Error('無法讀取後端回應（HTTP ' + response.status + '）')
  }
  if (!response.ok) throw new Error(body.error ?? '後端回應 ' + response.status)
  return body
}

export async function getBackendState(): Promise<BackendState> {
  return readState<BackendState>(await fetch('/api/state', { cache: 'no-store' }))
}

export async function applyBackendPreset(preset: EffectPreset): Promise<BackendState> {
  return readState<BackendState>(await fetch('/api/preset', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(preset),
  }))
}

export async function setBackendMotor(enabled: boolean): Promise<BackendState> {
  return readState<BackendState>(await fetch('/api/motor', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  }))
}

export async function getBackendSequence(): Promise<BackendSequenceState> {
  return readState<BackendSequenceState>(await fetch('/api/sequence', { cache: 'no-store' }))
}

export async function saveBackendSequence(sequence: SequenceDocument): Promise<BackendSequenceState> {
  return readState<BackendSequenceState>(await fetch('/api/sequence', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sequence),
  }))
}

// 從第 0 影格重播後端已儲存的串接或已套用的效果。 / Replay the saved sequence or applied preset from frame 0.
export async function restartBackendPlayback(source: 'sequence' | 'single'): Promise<BackendSequenceState> {
  return readState<BackendSequenceState>(await fetch('/api/playback/restart', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  }))
}

export type WeatherCategory = 'clear' | 'cloudy' | 'rain'

export type WeatherState = {
  enabled: boolean
  category: WeatherCategory | null
  temperatureC: number | null
  weatherCode: number | null
  observedAt: string | null
  updatedAt: string | null
  /** v0.1.10（含）以前的降水延遲；之後一律為 0。 / Rain delays up to v0.1.10; always 0 since. */
  startPhases: number[]
  frameStep: number
  color: import('./effects').EffectColor | null
  generation: number
  error: string | null
  override: { category: WeatherCategory; temperatureC: number; remainingSeconds: number } | null
  real: { category: WeatherCategory | null; temperatureC: number | null }
  thresholds: number[]
  // 舊版後端沒有以下欄位。 / Older backends omit the fields below.
  source?: 'local' | 'visit' | 'override'
  visit?: { name: string; category: WeatherCategory; temperatureC: number; observedAt: string | null } | null
  /** v0.1.7（含）以前：整點後等這一輪播完才造訪。 / Up to v0.1.7: the hourly visit waited for the round to end. */
  visits?: { count: number; pending?: boolean; next: string; names?: string[] } | null
  /** 天氣分類效果（多雲錯開、雨天線條）等下一段才套用。 / The weather category effects wait for the next step. */
  categoryPending?: boolean
}

export async function getWeatherState(): Promise<WeatherState | null> {
  const state = await readState<WeatherState>(await fetch('/api/weather', { cache: 'no-store' }))
  return state.enabled ? state : null
}

export async function setWeatherOverride(category: WeatherCategory, temperatureC: number): Promise<WeatherState> {
  return readState<WeatherState>(await fetch('/api/weather/override', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category, temperatureC }),
  }))
}

// 測試：立即造訪清單中的地點（播一輪後回到當地）。 / Test: visit a listed location now for one round.
export async function startWeatherVisit(index: number): Promise<WeatherState> {
  return readState<WeatherState>(await fetch('/api/weather/visit', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ index }),
  }))
}

export async function endWeatherVisit(): Promise<WeatherState> {
  return readState<WeatherState>(await fetch('/api/weather/visit', { method: 'DELETE' }))
}

export async function clearWeatherOverride(): Promise<WeatherState> {
  return readState<WeatherState>(await fetch('/api/weather/override', { method: 'DELETE' }))
}

export type UnitColorTest = {
  active: boolean
  /** 每台一色；null 表示該台照常播放。 / One color per unit; null plays normally. */
  colors: (RgbColor | null)[] | null
  /** null：手動結束。 / null: until ended manually. */
  remainingSeconds: number | null
}

// 舊版後端沒有這個 API，回 null。 / Older backends lack this API; returns null.
export async function getUnitColorTest(): Promise<UnitColorTest | null> {
  const response = await fetch('/api/test/units', { cache: 'no-store' })
  if (response.status === 404) return null
  return readState<UnitColorTest>(response)
}

export async function setUnitColorTest(colors: (RgbColor | null)[], seconds: number | null): Promise<UnitColorTest> {
  return readState<UnitColorTest>(await fetch('/api/test/units', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ colors, seconds }),
  }))
}

export async function clearUnitColorTest(): Promise<UnitColorTest> {
  return readState<UnitColorTest>(await fetch('/api/test/units', { method: 'DELETE' }))
}

export type WeatherPaletteBand = { belowC: number | null; colors: RgbColor[] }

export type WeatherPalette = {
  schemaVersion: 1
  axis: 'strip' | 'radius'
  bands: WeatherPaletteBand[]
}

export async function getWeatherPalette(): Promise<WeatherPalette> {
  return readState<WeatherPalette>(await fetch('/api/weather/palette', { cache: 'no-store' }))
}

export async function saveWeatherPalette(palette: WeatherPalette): Promise<WeatherPalette> {
  return readState<WeatherPalette>(await fetch('/api/weather/palette', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(palette),
  }))
}

export type PlaybackTransition = {
  kind: 'crossfade' | 'fade-black' | 'unit-fade-black'
  fromIndex: number
  elapsed: number
  frames: number
}

type ActivePlaybackBase = {
  active: true
  restart: number
  fps: number
  ageMs: number
  frame: number
  /** 單色測試進行中才有：每台一色或 null。 / Only during a unit colour test: one color or null per unit. */
  unitColors?: (RgbColor | null)[]
}

export type SequencePlayback = ActivePlaybackBase & {
  mode: 'sequence'
  sequenceFrame: number
  totalFrames: number
  ending: 'hold' | 'loop' | 'fade-black'
  loopIteration: number
  ended: boolean
  endFade: { elapsed: number; frames: number } | null
  step: {
    index: number
    id: number
    effectId: import('./effects').EffectId
    elapsed: number
    duration: number
    repeat: { current: number; total: number } | null
  }
  transition: PlaybackTransition | null
}

export type SinglePlayback = ActivePlaybackBase & {
  mode: 'single'
  effectId: import('./effects').EffectId
  cycle: { current: number; elapsed: number; frames: number } | null
}

export type BackendPlayback = { active: false } | SequencePlayback | SinglePlayback

// null：後端版本沒有此 API（v0.1.1 以前）。 / null: the backend predates this API.
export async function getBackendPlayback(): Promise<BackendPlayback | null> {
  const response = await fetch('/api/playback', { cache: 'no-store' })
  if (response.status === 404) return null
  return readState<BackendPlayback>(response)
}
