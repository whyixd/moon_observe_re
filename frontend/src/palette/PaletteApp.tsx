import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getWeatherPalette,
  getWeatherState,
  saveWeatherPalette,
  setWeatherOverride,
  type WeatherPalette,
  type WeatherState,
} from '../backendApi'
import { GradientEditor } from '../components/GradientEditor'
import { EditableNumberInput } from '../components/SequenceEditor'
import {
  addBand,
  bandIndexFor,
  bandLabel,
  canAddBand,
  MAX_TEMPERATURE,
  MIN_TEMPERATURE,
  paletteError,
  previewTemperature,
  removeBand,
} from './paletteModel'

export function PaletteApp() {
  const [palette, setPalette] = useState<WeatherPalette | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [weather, setWeather] = useState<WeatherState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const request = useRef(0)

  const load = useCallback(() => {
    const current = ++request.current
    setBusy(true)
    setError(null)
    setNotice(null)
    void Promise.all([getWeatherPalette(), getWeatherState()]).then(([loaded, state]) => {
      if (current !== request.current) return
      setPalette(loaded)
      setSaved(JSON.stringify(loaded))
      setWeather(state)
    }).catch((failure: unknown) => {
      if (current === request.current) {
        setError(failure instanceof Error ? failure.message : '無法載入色盤；後端需設定 [weather]')
      }
    }).finally(() => {
      if (current === request.current) setBusy(false)
    })
  }, [])

  useEffect(() => {
    load()
    return () => { request.current += 1 }
  }, [load])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void getWeatherState().then(setWeather).catch(() => {})
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [])

  const dirty = palette !== null && JSON.stringify(palette) !== saved
  const validation = palette ? paletteError(palette) : null

  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  const run = async (action: () => Promise<void>, fallback: string) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await action()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : fallback)
    } finally {
      setBusy(false)
    }
  }

  const save = () => run(async () => {
    const result = await saveWeatherPalette(palette!)
    setPalette(result)
    setSaved(JSON.stringify(result))
    setNotice('已儲存；實機與模擬器在下一個影格改用新色盤。')
  }, '儲存色盤失敗')

  const preview = (index: number) => run(async () => {
    const temperature = previewTemperature(palette!, index)
    const state = await setWeatherOverride(weather?.category ?? 'clear', temperature)
    setWeather(state)
    setNotice(`已套用測試天氣 ${temperature} °C；10 分鐘後自動恢復，也可在主頁「切回真實天氣」。`)
  }, '套用測試天氣失敗')

  const updateBand = (index: number, change: Partial<WeatherPalette['bands'][number]>) => {
    setPalette((current) => current && {
      ...current,
      bands: current.bands.map((band, bandIndex) => (bandIndex === index ? { ...band, ...change } : band)),
    })
  }

  const currentTemperature = weather?.temperatureC ?? null
  const activeBand = palette && currentTemperature !== null ? bandIndexFor(palette, currentTemperature) : null

  return (
    <main className="app-shell palette-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Moon Observe / weather</p>
          <h1>天氣色盤</h1>
        </div>
        <a className="palette-back" href="./">← 回模擬器</a>
      </header>

      <section className="controls palette-page" aria-label="天氣色盤設定">
        <p className="control-note palette-intro">
          依氣溫分段設定天氣生效時的漸層色。儲存後立即套用到實機輸出與模擬器，不需重啟；
          preset 與串接本身的顏色不受影響。
          {currentTemperature !== null && ` 目前生效氣溫 ${currentTemperature} °C${weather?.override ? '（手動測試）' : ''}。`}
        </p>

        {palette && (
          <>
            <label className="control-field gradient-axis">
              <span>漸層方向（只用於純色效果；漸層效果照各自的方向）</span>
              <select value={palette.axis}
                onChange={(event) => setPalette({ ...palette, axis: event.target.value as WeatherPalette['axis'] })}>
                <option value="radius">中心 → 兩端</option>
                <option value="strip">半圓一端 → 另一端</option>
              </select>
            </label>

            <ol className="palette-bands">
              {palette.bands.map((band, index) => (
                <li key={`${palette.bands.length}-${index}`}
                  className={'palette-band' + (index === activeBand ? ' current' : '')}>
                  <div className="palette-band-heading">
                    <strong>第 {index + 1} 段 · {bandLabel(palette, index)}</strong>
                    {index === activeBand && <span className="palette-badge">目前氣溫</span>}
                  </div>
                  {band.belowC !== null ? (
                    <label className="sequence-field">
                      上限（低於此氣溫，°C）
                      <EditableNumberInput value={band.belowC} min={MIN_TEMPERATURE} max={MAX_TEMPERATURE} step={1}
                        onValue={(belowC) => updateBand(index, { belowC })} />
                    </label>
                  ) : (
                    <p className="weather-status palette-last-note">最後一段：涵蓋以上所有氣溫。</p>
                  )}
                  <GradientEditor colors={band.colors} onChange={(colors) => updateBand(index, { colors })} />
                  <div className="button-row palette-band-actions">
                    <button type="button" className="secondary" disabled={busy || dirty || !weather}
                      title={dirty ? '請先儲存，實機才會使用此色盤' : undefined}
                      onClick={() => { void preview(index) }}>
                      在實機預覽此段（{previewTemperature(palette, index)} °C）
                    </button>
                    <button type="button" className="secondary" disabled={busy || palette.bands.length <= 1}
                      onClick={() => setPalette(removeBand(palette, index))}>刪除此段</button>
                  </div>
                </li>
              ))}
            </ol>

            <button type="button" className="secondary palette-add" disabled={busy || !canAddBand(palette)}
              onClick={() => setPalette(addBand(palette))}>新增段落</button>
          </>
        )}

        <div className="palette-footer">
          <p role="status" className="weather-status">
            {busy ? '處理中…'
              : validation ?? (dirty ? '有尚未儲存的變更；預覽前請先儲存。' : palette ? '色盤已儲存。' : '')}
          </p>
          {error && <p className="backend-error" role="alert">{error}</p>}
          {notice && <p className="weather-status palette-notice">{notice}</p>}
          <div className="button-row">
            <button type="button" className="secondary" disabled={busy} onClick={load}>重新讀取</button>
            <button type="button" disabled={busy || !palette || !dirty || validation !== null}
              onClick={() => { void save() }}>儲存色盤</button>
          </div>
        </div>
      </section>
    </main>
  )
}
