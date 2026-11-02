import { useEffect, useState } from 'react'
import { clearUnitColorTest, getUnitColorTest, setUnitColorTest, type UnitColorTest } from '../backendApi'
import type { RgbColor } from '../effects'
import { ColorInput } from './GradientEditor'
import { formatRemaining } from './WeatherPanel'

const PRESETS: { label: string; color: RgbColor }[] = [
  { label: '全白', color: { r: 1, g: 1, b: 1 } },
  { label: '全紅', color: { r: 1, g: 0, b: 0 } },
  { label: '全綠', color: { r: 0, g: 1, b: 0 } },
  { label: '全藍', color: { r: 0, g: 0, b: 1 } },
  { label: '全關', color: { r: 0, g: 0, b: 0 } },
]
const MAX_MINUTES = 1440

type Slot = { enabled: boolean; color: RgbColor }

// 測試：單獨指定每台燈全亮的純色，直接影響實機輸出；底下的播放照常前進。
// Test: a solid full-on color per unit on the real output; playback underneath keeps advancing.
export function UnitColorTestPanel({ unitCount, onChange }: { unitCount: number; onChange?: () => void }) {
  const [test, setTest] = useState<UnitColorTest | null | undefined>(undefined)
  const [slots, setSlots] = useState<Slot[]>(() =>
    Array.from({ length: unitCount }, () => ({ enabled: true, color: { r: 1, g: 1, b: 1 } })))
  const [timed, setTimed] = useState(false)
  const [minutes, setMinutes] = useState('10')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 剩餘秒數換算成本機截止時間。 / Remaining seconds become a local deadline.
  const [deadline, setDeadline] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const receive = (state: UnitColorTest | null) => {
    setTest(state)
    setDeadline(state?.active && state.remainingSeconds !== null ? Date.now() + state.remainingSeconds * 1000 : null)
  }

  useEffect(() => {
    let active = true
    getUnitColorTest().then((state) => {
      if (!active) return
      receive(state)
      if (state?.colors) {
        setSlots(state.colors.map((color) => color
          ? { enabled: true, color }
          : { enabled: false, color: { r: 1, g: 1, b: 1 } }))
      }
    }, (failure) => { if (active) setError(failure instanceof Error ? failure.message : '無法讀取單色測試') })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (deadline === null) return
    const timer = window.setInterval(() => {
      setNow(Date.now())
      if (Date.now() >= deadline) getUnitColorTest().then(receive, () => undefined)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [deadline])

  const run = async (request: () => Promise<UnitColorTest>) => {
    setBusy(true)
    setError(null)
    try {
      receive(await request())
      onChange?.()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '單色測試失敗')
    } finally {
      setBusy(false)
    }
  }

  if (test === undefined && error === null) return null
  if (test === null) {
    return <p className="control-note">單色測試需要 v0.1.9 以上的後端。</p>
  }

  const parsedMinutes = Number(minutes)
  const minutesValid = minutes.trim() !== '' && Number.isFinite(parsedMinutes)
    && parsedMinutes * 60 >= 1 && parsedMinutes <= MAX_MINUTES
  const anyEnabled = slots.some((slot) => slot.enabled)
  const update = (index: number, slot: Partial<Slot>) =>
    setSlots((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...slot } : item))

  return (
    <div className="unit-color-test">
      <span className="control-label">單色測試 · 各燈台全亮</span>
      {test?.active ? (
        <p className="weather-override" role="status">
          測試中：{test.colors?.filter((color) => color !== null).length} 台指定顏色
          {' · '}{deadline === null ? '手動結束' : `剩 ${formatRemaining((deadline - now) / 1000)}`}
        </p>
      ) : null}
      <div className="button-row unit-color-presets">
        {PRESETS.map(({ label, color }) => (
          <button key={label} type="button" className="secondary"
            onClick={() => setSlots((current) => current.map(() => ({ enabled: true, color: { ...color } })))}>
            {label}
          </button>
        ))}
      </div>
      <ol className="unit-color-list">
        {slots.map((slot, index) => (
          <li key={index} className={slot.enabled ? undefined : 'unit-color-off'}>
            <label className="unit-color-toggle">
              <input type="checkbox" checked={slot.enabled}
                onChange={(event) => update(index, { enabled: event.target.checked })} />
              第 {index + 1} 台
            </label>
            {slot.enabled
              ? <ColorInput label="" color={slot.color} onChange={(color) => update(index, { color })} />
              : <span className="unit-color-idle">照常播放</span>}
          </li>
        ))}
      </ol>
      <div className="segmented-control" aria-label="測試時間">
        <button type="button" className={timed ? 'secondary' : 'active'} aria-pressed={!timed}
          onClick={() => setTimed(false)}>手動結束</button>
        <button type="button" className={timed ? 'active' : 'secondary'} aria-pressed={timed}
          onClick={() => setTimed(true)}>限時</button>
      </div>
      {timed && (
        <label className="sequence-field">
          測試時間（分鐘，最多 {MAX_MINUTES}）
          <input type="number" min={0.1} max={MAX_MINUTES} step={1} value={minutes}
            onChange={(event) => setMinutes(event.target.value)} />
        </label>
      )}
      <div className="button-row">
        <button type="button" disabled={busy || !anyEnabled || (timed && !minutesValid)}
          onClick={() => {
            void run(() => setUnitColorTest(slots.map((slot) => slot.enabled ? slot.color : null),
              timed ? parsedMinutes * 60 : null))
          }}>
          {test?.active ? '更新測試' : '套用測試'}
        </button>
        <button type="button" className="secondary" disabled={busy || !test?.active}
          onClick={() => { void run(clearUnitColorTest) }}>
          結束測試
        </button>
      </div>
      {error && <p className="backend-error" role="alert">{error}</p>}
      <p className="control-note">
        勾選的燈台整條燈帶以該顏色全亮，未勾選的照常播放；直接影響實機輸出，底下的串接或效果照常前進，結束後接回目前進度。
        選「手動結束」時會一直維持到按「結束測試」或後端重新啟動。3D 畫面會跟著顯示測試顏色。
      </p>
    </div>
  )
}
