// 定時播放：與後端 schedule.py 相同的驗證規則與狀態文字。
// Timed shows: the same validation rules as the backend's schedule.py, plus status wording.
import type { ScheduleDocument, SchedulePhase, ScheduleStatus, ScheduleWindow } from './backendApi'

export const MAX_WINDOWS_PER_DAY = 8
export const MAX_DATES = 400
export const MAX_REST_MINUTES = 240
export const MAX_SPIN_UP_SECONDS = 30
export const MAX_END_FADE_SECONDS = 10

export const PHASE_LABELS: Record<SchedulePhase, string> = {
  disabled: '排程關閉',
  off: '時段外',
  spinup: '暖機中',
  play: '表演中',
  rest: '休息中',
  ending: '結束中',
}

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** HH:MM → 分鐘；`end` 允許 24:00。不合法回傳 null。 / HH:MM to minutes; `end` allows 24:00. */
export function timeToMinutes(value: string, end = false): number | null {
  if (!(TIME.test(value) || (end && value === '24:00'))) return null
  const [hours, minutes] = value.split(':').map(Number)
  return hours * 60 + minutes
}

function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}

export function windowProblems(windows: ScheduleWindow[], label: string): string[] {
  const problems: string[] = []
  if (windows.length > MAX_WINDOWS_PER_DAY) problems.push(`${label}最多 ${MAX_WINDOWS_PER_DAY} 段`)
  const parsed: [number, number][] = []
  windows.forEach((window, index) => {
    const start = timeToMinutes(window.start)
    const end = timeToMinutes(window.end, true)
    if (start === null || end === null) problems.push(`${label}第 ${index + 1} 段的時間格式要是 HH:MM`)
    else if (end <= start) problems.push(`${label}第 ${index + 1} 段要在開始之後結束（不能跨午夜）`)
    else parsed.push([start, end])
  })
  parsed.sort((a, b) => a[0] - b[0])
  if (parsed.some((window, index) => index > 0 && window[0] < parsed[index - 1][1])) {
    problems.push(`${label}的時段不能重疊`)
  }
  return problems
}

export function scheduleProblems(document: ScheduleDocument): string[] {
  const problems: string[] = []
  const integerIn = (value: number, max: number) => Number.isInteger(value) && value >= 0 && value <= max
  const numberIn = (value: number, max: number) => Number.isFinite(value) && value >= 0 && value <= max
  if (!integerIn(document.restMinutes, MAX_REST_MINUTES)) problems.push(`休息時間要是 0–${MAX_REST_MINUTES} 的整數分鐘`)
  if (!numberIn(document.spinUpSeconds, MAX_SPIN_UP_SECONDS)) problems.push(`暖機時間要在 0–${MAX_SPIN_UP_SECONDS} 秒`)
  if (!numberIn(document.endFadeSeconds, MAX_END_FADE_SECONDS)) problems.push(`結束淡出要在 0–${MAX_END_FADE_SECONDS} 秒`)
  problems.push(...windowProblems(document.daily, '每日時段'))
  if (document.dates.length > MAX_DATES) problems.push(`特殊日期最多 ${MAX_DATES} 天`)
  const seen = new Set<string>()
  for (const entry of document.dates) {
    if (!isRealDate(entry.date)) {
      problems.push(`特殊日期「${entry.date || '（空白）'}」要是有效的日期`)
      continue
    }
    if (seen.has(entry.date)) problems.push(`特殊日期 ${entry.date} 重複`)
    seen.add(entry.date)
    problems.push(...windowProblems(entry.windows, `${entry.date} `))
  }
  return problems
}

/** 存檔前排序（與後端正規化相同），讓「有沒有變更」的比較穩定。 / Sort like the backend normalizes. */
export function normalizeSchedule(document: ScheduleDocument): ScheduleDocument {
  const byStart = (windows: ScheduleWindow[]) => [...windows].sort((a, b) => a.start.localeCompare(b.start))
  return {
    ...document,
    motors: [...document.motors].sort((a, b) => a.unitId - b.unitId),
    daily: byStart(document.daily),
    dates: [...document.dates]
      .map((entry) => ({ ...entry, windows: byStart(entry.windows) }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  }
}

/** 後端時間（無時區 ISO）解析成本地 Date；兩邊用同一個基準相減即可。 / Parse a zone-less ISO time. */
function parseLocal(iso: string): Date {
  const [day, time = '00:00:00'] = iso.split('T')
  const [year, month, date] = day.split('-').map(Number)
  const [hours, minutes, seconds = 0] = time.split(':').map(Number)
  return new Date(year, month - 1, date, hours, minutes, seconds)
}

/** 同一天只顯示時間，其他天加上 月/日。 / Time only on the same day, else month/day too. */
export function formatShowTime(iso: string, nowIso: string): string {
  const when = parseLocal(iso)
  const now = parseLocal(nowIso)
  const time = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
  const sameDay = when.getFullYear() === now.getFullYear() && when.getMonth() === now.getMonth()
    && when.getDate() === now.getDate()
  return sameDay ? time : `${when.getMonth() + 1}/${when.getDate()} ${time}`
}

/** 這個階段還剩幾秒（扣掉收到回應後經過的時間）。 / Seconds left in the phase, minus time since the response. */
export function phaseRemainingSeconds(status: ScheduleStatus, elapsedMs: number): number | null {
  if (!status.phaseEndsAt) return null
  const seconds = (parseLocal(status.phaseEndsAt).getTime() - parseLocal(status.now).getTime() - elapsedMs) / 1000
  return Math.max(0, seconds)
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds))
  if (total < 60) return `${total} 秒`
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** 控制頁的狀態列。 / The status line on the control page. */
export function describeStatus(status: ScheduleStatus, elapsedMs: number): string {
  if (!status.running) return status.phase === 'disabled' ? '排程關閉' : '後端沒有輸出 Art-Net（--api-only），排程不會執行'
  const remaining = phaseRemainingSeconds(status, elapsedMs)
  const next = status.nextShowAt ? `下一場 ${formatShowTime(status.nextShowAt, status.now)}` : '之後沒有排定的時段'
  const windowEnd = status.window ? `，${status.window.end.slice(11)} 結束` : ''
  switch (status.phase) {
    case 'off':
      return `時段外 · ${next}`
    case 'spinup':
      return `暖機中 · ${remaining === null ? '' : `${formatDuration(remaining)}後`}開始第 ${(status.round ?? 0) + 1} 輪${windowEnd}`
    case 'play':
      return `表演中 · 第 ${status.round ?? 1} 輪${remaining === null ? '' : `，剩 ${formatDuration(remaining)}`}${windowEnd}`
    case 'rest':
      return `休息中 · ${remaining === null ? '' : `${formatDuration(remaining)}後`}暖機開始下一輪${windowEnd}`
    case 'ending':
      return `結束中 · 馬達停止、燈光淡出 · ${next}`
    default:
      return '排程關閉'
  }
}
