import { useEffect, useState } from 'react'
import { clearWeatherOverride, endWeatherVisit, setWeatherOverride, startWeatherVisit, type WeatherCategory, type WeatherState } from '../backendApi'

export const CATEGORY_LABELS: Record<WeatherCategory, string> = {
  clear: '晴',
  cloudy: '多雲／霧',
  rain: '降水',
}

type WeatherPanelProps = {
  weather: WeatherState
  onWeather: (weather: WeatherState) => void
}

export function formatRemaining(seconds: number) {
  const total = Math.max(0, Math.ceil(seconds))
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0')
}

export function WeatherPanel({ weather, onWeather }: WeatherPanelProps) {
  const [category, setCategory] = useState<WeatherCategory>(weather.override?.category ?? weather.real.category ?? 'clear')
  const [temperature, setTemperature] = useState(String(weather.override?.temperatureC ?? weather.real.temperatureC ?? 22))
  const [visitIndex, setVisitIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 後端回傳剩餘秒數；換算成本機截止時間，避免依賴 Pi 與瀏覽器時鐘一致。
  // Backend reports remaining seconds; convert to a local deadline so clocks need not agree.
  const [deadline, setDeadline] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // 延後套用時，下一段要換成的分類。 / The category the next step switches to while it is deferred.
  const nextCategory = weather.override?.category ?? weather.visit?.category ?? weather.real.category
  const remainingSeconds = weather.override?.remainingSeconds
  useEffect(() => {
    setDeadline(remainingSeconds === undefined ? null : Date.now() + remainingSeconds * 1000)
  }, [remainingSeconds])

  useEffect(() => {
    if (deadline === null) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [deadline])

  const run = async (request: () => Promise<WeatherState>) => {
    setBusy(true)
    setError(null)
    try {
      onWeather(await request())
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '天氣設定失敗')
    } finally {
      setBusy(false)
    }
  }

  const parsedTemperature = Number(temperature)
  const temperatureValid = temperature.trim() !== '' && Number.isFinite(parsedTemperature)
    && parsedTemperature >= -100 && parsedTemperature <= 70

  return (
    <div className="weather-controls">
      <div className="section-heading">
        <span className="control-label">天氣</span>
        <a className="weather-palette-link" href="palette.html">編輯天氣色盤 →</a>
      </div>
      {weather.override ? (
        <p className="weather-override" role="status">
          手動天氣（測試）：{CATEGORY_LABELS[weather.override.category]} · {weather.override.temperatureC} °C
          · 剩 {formatRemaining(deadline === null ? 0 : (deadline - now) / 1000)}
        </p>
      ) : null}
      {weather.visit ? (
        <p className="weather-visit" role="status">
          造訪中：{weather.visit.name} · {CATEGORY_LABELS[weather.visit.category]} · {weather.visit.temperatureC} °C
          {weather.visit.observedAt ? ` · 資料 ${weather.visit.observedAt}` : ''}（播放一輪的時間後回到當地）
        </p>
      ) : null}
      <p className="weather-status">
        {weather.override || weather.visit ? '當地天氣：' : '目前：'}
        {weather.real.category ? CATEGORY_LABELS[weather.real.category] : '等待資料'}
        {weather.real.temperatureC !== null ? ` · ${weather.real.temperatureC} °C` : ''}
        {weather.observedAt ? ` · 資料 ${weather.observedAt}` : ''}
        {weather.error ? ` · 更新失敗：${weather.error}` : ''}
      </p>
      <p className="weather-status">
        生效：{weather.category ? CATEGORY_LABELS[weather.category] : '無'}
        {weather.category ? ' · 氣溫漸層' : ''}
        {weather.category === 'cloudy' ? ` · step ${weather.frameStep}` : ''}
        {weather.category === 'rain' ? ' · 效果改為線條' : ''}
        {weather.categoryPending ? ` · 下一段起改為${CATEGORY_LABELS[nextCategory ?? 'clear']}` : ''}
      </p>
      {weather.visits ? (
        <p className="weather-status">
          {weather.visits.pending
            ? `整點造訪待開始：${weather.visits.next}（這一輪播完後）`
            : `下次整點造訪：${weather.visits.next}（整點準時換色盤，天氣時間效果從下一段起）`}
          {` · 共 ${weather.visits.count} 個地點輪流`}
        </p>
      ) : null}

      <div className="segmented-control weather-categories" aria-label="測試天氣分類">
        {(Object.keys(CATEGORY_LABELS) as WeatherCategory[]).map((value) => (
          <button key={value} type="button" className={category === value ? 'active' : 'secondary'}
            aria-pressed={category === value} onClick={() => setCategory(value)}>
            {CATEGORY_LABELS[value]}
          </button>
        ))}
      </div>
      <label className="sequence-field">
        測試氣溫（°C；色盤分界 {weather.thresholds.length ? weather.thresholds.join(' / ') : '無'}）
        <input type="number" min={-100} max={70} step={1} value={temperature}
          onChange={(event) => setTemperature(event.target.value)} />
      </label>
      <div className="button-row weather-actions">
        <button type="button" disabled={busy || !temperatureValid}
          onClick={() => { void run(() => setWeatherOverride(category, parsedTemperature)) }}>
          套用測試天氣
        </button>
        <button type="button" className="secondary" disabled={busy || !weather.override}
          onClick={() => { void run(clearWeatherOverride) }}>
          切回真實天氣
        </button>
      </div>
      {weather.visits?.names && (
        <div className="weather-visit-test">
          <label className="sequence-field">
            測試造訪地點
            <select value={visitIndex} onChange={(event) => setVisitIndex(Number(event.target.value))}>
              {weather.visits.names.map((name, index) => <option key={index} value={index}>{name}</option>)}
            </select>
          </label>
          <div className="button-row weather-actions">
            <button type="button" disabled={busy || weather.override !== null}
              onClick={() => { void run(() => startWeatherVisit(visitIndex)) }}>
              立即造訪
            </button>
            <button type="button" className="secondary" disabled={busy || !weather.visit}
              onClick={() => { void run(endWeatherVisit) }}>
              結束造訪
            </button>
          </div>
        </div>
      )}
      {error && <p className="backend-error" role="alert">{error}</p>}
      <p className="control-note">
        「立即造訪」與整點造訪相同：色盤立即換上、不重播，多雲錯開／雨天線條從下一段起；一輪的時間後回到當地，不影響整點輪替。手動測試天氣進行中時無法造訪。
        測試天氣直接影響實機輸出，10 分鐘後自動切回真實天氣；重新套用會重新計時並從頭播放。
      </p>
    </div>
  )
}
