import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getBackendSchedule,
  saveBackendSchedule,
  type BackendScheduleState,
  type ScheduleDocument,
  type ScheduleMotor,
  type ScheduleWindow,
} from '../backendApi'
import {
  MAX_DATES,
  MAX_REST_MINUTES,
  MAX_SPIN_UP_SECONDS,
  MODE_LABELS,
  MAX_WINDOWS_PER_DAY,
  describeStatus,
  normalizeSchedule,
  scheduleProblems,
} from '../schedule'
import type { MotorDirection } from '../simulation/model'

const POLL_MS = 2000
const SPEED_LABELS: Record<ScheduleMotor['speed'], string> = { mid: '中速', max: '全速' }
const DIRECTION_LABELS: Record<MotorDirection, string> = { cw: '順', ccw: '逆' }
const NEW_WINDOW: ScheduleWindow = { start: '18:00', end: '20:00', mode: 'continuous' }
const DEFAULT_REST_MINUTES = 10

function numberInput(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value)
}

function sameDocument(a: ScheduleDocument, b: ScheduleDocument): boolean {
  return JSON.stringify(normalizeSchedule(a)) === JSON.stringify(normalizeSchedule(b))
}

function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days))
  return date.toISOString().slice(0, 10)
}

function WindowList({ windows, onChange }: { windows: ScheduleWindow[]; onChange: (windows: ScheduleWindow[]) => void }) {
  const update = (index: number, patch: Partial<ScheduleWindow>) =>
    onChange(windows.map((window, itemIndex) => itemIndex === index ? { ...window, ...patch } : window))
  return (
    <div className="schedule-windows">
      {windows.map((window, index) => (
        <div className="schedule-window-row" key={index}>
          <input type="text" inputMode="numeric" maxLength={5} placeholder="HH:MM" aria-label="開始"
            value={window.start} onChange={(event) => update(index, { start: event.target.value })} />
          <span>–</span>
          <input type="text" inputMode="numeric" maxLength={5} placeholder="HH:MM" aria-label="結束"
            value={window.end} onChange={(event) => update(index, { end: event.target.value })} />
          <select aria-label="馬達模式" value={window.mode}
            onChange={(event) => update(index, event.target.value === 'cycle'
              ? { mode: 'cycle', restMinutes: window.restMinutes ?? DEFAULT_REST_MINUTES }
              : { mode: 'continuous' })}>
            {(Object.keys(MODE_LABELS) as ScheduleWindow['mode'][]).map((mode) => (
              <option key={mode} value={mode}>{MODE_LABELS[mode]}</option>
            ))}
          </select>
          {window.mode === 'cycle' && (
            <label className="schedule-rest">
              休息
              <input type="number" min={0} max={MAX_REST_MINUTES} step={1} aria-label="休息分鐘"
                value={window.restMinutes === undefined || Number.isNaN(window.restMinutes) ? '' : window.restMinutes}
                onChange={(event) => update(index, { restMinutes: numberInput(event.target.value) })} />
              分
            </label>
          )}
          <button type="button" className="secondary" aria-label="刪除時段"
            onClick={() => onChange(windows.filter((_, itemIndex) => itemIndex !== index))}>刪除</button>
        </div>
      ))}
      <button type="button" className="secondary schedule-add" disabled={windows.length >= MAX_WINDOWS_PER_DAY}
        onClick={() => onChange([...windows, windows.length ? { ...windows[windows.length - 1], start: windows[windows.length - 1].end, end: '24:00' } : { ...NEW_WINDOW }])}>
        ＋ 新增時段
      </button>
    </div>
  )
}

// 定時播放：燈光全天循環；馬達只在每日／特殊日期時段內運轉，每段選「持續」或「循環」。
// Timed shows: lights loop all day; motors follow the daily / per-date windows, each continuous or cycling.
export function SchedulePanel({ onSaved }: { onSaved?: () => void }) {
  const [state, setState] = useState<BackendScheduleState | null | undefined>(undefined)
  const [draft, setDraft] = useState<ScheduleDocument | null>(null)
  const [receivedAt, setReceivedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const savedRef = useRef<ScheduleDocument | null>(null)

  const receive = useCallback((next: BackendScheduleState | null, replaceDraft: boolean) => {
    const previous = savedRef.current
    savedRef.current = next?.schedule ?? null
    setState(next)
    // 沒有未儲存的變更時，草稿跟著後端更新（例如其他頁面存檔）。 / Follow the backend while nothing is edited.
    setDraft((current) => (replaceDraft || current === null || (previous !== null && sameDocument(current, previous)))
      ? next?.schedule ?? null : current)
    setReceivedAt(Date.now())
  }, [])

  useEffect(() => {
    let active = true
    const load = (first: boolean) => getBackendSchedule().then((next) => {
      if (active) receive(next, first)
    }, (failure) => {
      if (active) setError(failure instanceof Error ? failure.message : '無法讀取排程')
    })
    void load(true)
    const timer = window.setInterval(() => {
      setNow(Date.now())
      void load(false)
    }, POLL_MS)
    const clock = window.setInterval(() => setNow(Date.now()), 1000)
    return () => {
      active = false
      window.clearInterval(timer)
      window.clearInterval(clock)
    }
  }, [receive])

  if (state === undefined && error === null) return null
  if (state === null) return <p className="control-note">定時播放需要較新的後端版本。</p>
  if (!state || !draft) return error ? <p className="backend-error" role="alert">{error}</p> : null

  const problems = scheduleProblems(draft)
  const dirty = !sameDocument(draft, state.schedule)
  const status = state.status
  const today = status?.now.slice(0, 10) ?? new Date().toISOString().slice(0, 10)
  const edit = (patch: Partial<ScheduleDocument>) => setDraft({ ...draft, ...patch })
  const setMotor = (unitIds: number[], patch: Partial<ScheduleMotor>) =>
    edit({ motors: draft.motors.map((motor) => unitIds.includes(motor.unitId) ? { ...motor, ...patch } : motor) })
  const allMotor = draft.motors.every((motor) => motor.speed === draft.motors[0]?.speed
    && motor.direction === draft.motors[0]?.direction) ? draft.motors[0] : null
  const setDate = (index: number, patch: Partial<ScheduleDocument['dates'][number]>) =>
    edit({ dates: draft.dates.map((entry, itemIndex) => itemIndex === index ? { ...entry, ...patch } : entry) })
  const nextFreeDate = () => {
    const used = new Set(draft.dates.map((entry) => entry.date))
    let candidate = today
    while (used.has(candidate)) candidate = addDays(candidate, 1)
    return candidate
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      receive(await saveBackendSchedule(normalizeSchedule(draft)), true)
      onSaved?.()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '排程儲存失敗')
    } finally {
      setBusy(false)
    }
  }

  const motorRow = (label: string, motor: ScheduleMotor | null, unitIds: number[]) => (
    <div className="motor-row schedule-motor-row" key={label}>
      <span className="motor-row-label">{label}</span>
      <div className="segmented-control motor-speeds" role="group" aria-label={`${label} 速度`}>
        {(Object.keys(SPEED_LABELS) as ScheduleMotor['speed'][]).map((speed) => (
          <button key={speed} type="button" className={motor?.speed === speed ? 'active' : 'secondary'}
            aria-pressed={motor?.speed === speed} onClick={() => setMotor(unitIds, { speed })}>{SPEED_LABELS[speed]}</button>
        ))}
      </div>
      <div className="segmented-control motor-directions" role="group" aria-label={`${label} 方向`}>
        {(Object.keys(DIRECTION_LABELS) as MotorDirection[]).map((direction) => (
          <button key={direction} type="button" className={motor?.direction === direction ? 'active' : 'secondary'}
            aria-pressed={motor?.direction === direction} onClick={() => setMotor(unitIds, { direction })}>{DIRECTION_LABELS[direction]}</button>
        ))}
      </div>
    </div>
  )

  return (
    <div className="schedule-controls">
      <span className="control-label">定時播放</span>
      {status && (
        <>
          <p className={status.phase && status.phase !== 'disabled' && status.phase !== 'off' ? 'weather-override' : 'weather-status'} role="status">
            {describeStatus(status, now - receivedAt)}
          </p>
          <p className="weather-status">
            後端時間 {status.now.replace('T', ' ')}
            {' · 今天 '}{status.today.length ? status.today.map((window) => `${window.start}–${window.end}`).join('、') : '不表演'}
          </p>
        </>
      )}

      <label className="scene-toggle">
        <input type="checkbox" checked={draft.enabled} onChange={(event) => edit({ enabled: event.target.checked })} />
        <span>啟用排程（儲存後生效；啟用時手動馬達控制會停用）</span>
      </label>

      <div className="schedule-numbers">
        <label className="sequence-field">
          馬達暖機（秒：持續時段在那一輪開始前啟動；循環時段暖機後才從第 1 段播放）
          <input type="number" min={0} max={MAX_SPIN_UP_SECONDS} step={0.5} value={Number.isNaN(draft.spinUpSeconds) ? '' : draft.spinUpSeconds}
            onChange={(event) => edit({ spinUpSeconds: numberInput(event.target.value) })} />
        </label>
      </div>

      <span className="control-label">時段內的馬達</span>
      {motorRow('全部', allMotor, draft.motors.map((motor) => motor.unitId))}
      {draft.motors.map((motor) => motorRow(`第 ${motor.unitId} 台`, motor, [motor.unitId]))}

      <span className="control-label">每日時段</span>
      <WindowList windows={draft.daily} onChange={(daily) => edit({ daily })} />

      <span className="control-label">特殊日期（取代當天的每日時段；當天不表演 = 馬達整天不轉）</span>
      <ul className="schedule-dates">
        {draft.dates.map((entry, index) => (
          <li key={index} className={entry.date < today ? 'schedule-past' : undefined}>
            <div className="schedule-date-head">
              <input type="date" aria-label="日期" value={entry.date}
                onChange={(event) => setDate(index, { date: event.target.value })} />
              <label className="unit-color-toggle">
                <input type="checkbox" checked={entry.windows.length === 0}
                  onChange={(event) => setDate(index, { windows: event.target.checked ? [] : [{ ...NEW_WINDOW }] })} />
                當天不表演
              </label>
              <button type="button" className="secondary" aria-label="刪除特殊日期"
                onClick={() => edit({ dates: draft.dates.filter((_, itemIndex) => itemIndex !== index) })}>刪除</button>
            </div>
            {entry.date < today && <small>已過期</small>}
            {entry.windows.length > 0 && (
              <WindowList windows={entry.windows} onChange={(windows) => setDate(index, { windows })} />
            )}
          </li>
        ))}
      </ul>
      <button type="button" className="secondary schedule-add" disabled={draft.dates.length >= MAX_DATES}
        onClick={() => edit({ dates: [...draft.dates, { date: nextFreeDate(), windows: [{ ...NEW_WINDOW }] }] })}>
        ＋ 新增特殊日期
      </button>

      {problems.length > 0 && (
        <ul className="backend-error schedule-problems" role="alert">
          {problems.map((problem) => <li key={problem}>{problem}</li>)}
        </ul>
      )}
      <div className="button-row">
        <button type="button" disabled={busy || !dirty || problems.length > 0} onClick={() => { void save() }}>儲存排程</button>
        <button type="button" className="secondary" disabled={busy || !dirty}
          onClick={() => setDraft(state.schedule)}>還原</button>
      </div>
      {error && <p className="backend-error" role="alert">{error}</p>}
      <p className="control-note">
        排程啟用時燈光全天循環播放串接，時段外馬達停止、燈光照常。每個時段選一種模式：
        持續＝在「涵蓋時段開始時間的那一輪」（開始時間或之前最近的一輪開頭）前幾秒先啟動，一直運轉到時段結束，結束時播完當輪才停；
        循環＝時段開始時馬達先暖機，燈光從第 1 段播放一輪，播完休息設定的分鐘數（馬達停、燈照常），休息後再暖機、從第 1 段重播，時段結束時馬達立刻停止。
        時間依後端電腦的本地時間；時段不能跨午夜，跨夜請拆成兩天（例如 22:00–24:00 與隔天 00:00–02:00，會接續運轉）。
      </p>
    </div>
  )
}
