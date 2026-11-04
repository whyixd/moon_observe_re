import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBackendSchedule, saveBackendSchedule, type ScheduleDocument, type ScheduleStatus } from '../src/backendApi'
import { describeStatus, formatShowTime, normalizeSchedule, phaseRemainingSeconds, scheduleProblems, timeToMinutes } from '../src/schedule'

afterEach(() => vi.unstubAllGlobals())

function schedule(overrides: Partial<ScheduleDocument> = {}): ScheduleDocument {
  return {
    schemaVersion: 1,
    enabled: true,
    restMinutes: 10,
    spinUpSeconds: 5,
    endFadeSeconds: 3,
    motors: [1, 2, 3, 4, 5].map((unitId) => ({ unitId, speed: 'max' as const, direction: 'cw' as const })),
    daily: [{ start: '18:00', end: '20:00' }],
    dates: [],
    ...overrides,
  }
}

function status(overrides: Partial<ScheduleStatus> = {}): ScheduleStatus {
  return {
    now: '2026-11-04T18:30:00',
    running: true,
    phase: 'play',
    round: 2,
    phaseEndsAt: '2026-11-04T18:31:30',
    window: { start: '2026-11-04T18:00', end: '2026-11-04T20:00' },
    today: [{ start: '18:00', end: '20:00' }],
    nextShowAt: '2026-11-05T18:00',
    ...overrides,
  }
}

describe('schedule validation', () => {
  it('accepts the default shape and 24:00 ends', () => {
    expect(scheduleProblems(schedule())).toEqual([])
    expect(scheduleProblems(schedule({ daily: [{ start: '22:00', end: '24:00' }] }))).toEqual([])
    expect(scheduleProblems(schedule({ daily: [{ start: '18:00', end: '19:00' }, { start: '19:00', end: '20:00' }] }))).toEqual([])
    expect(scheduleProblems(schedule({ dates: [{ date: '2026-11-10', windows: [] }] }))).toEqual([])
  })

  it('matches the backend rules', () => {
    const cases: [Partial<ScheduleDocument>, string][] = [
      [{ restMinutes: 1.5 }, '休息時間'],
      [{ restMinutes: 241 }, '休息時間'],
      [{ restMinutes: Number.NaN }, '休息時間'],
      [{ spinUpSeconds: 31 }, '暖機時間'],
      [{ endFadeSeconds: -1 }, '結束淡出'],
      [{ daily: [{ start: '8:00', end: '09:00' }] }, 'HH:MM'],
      [{ daily: [{ start: '24:00', end: '24:00' }] }, 'HH:MM'],
      [{ daily: [{ start: '22:00', end: '02:00' }] }, '跨午夜'],
      [{ daily: [{ start: '18:00', end: '20:00' }, { start: '19:30', end: '21:00' }] }, '重疊'],
      [{ daily: Array.from({ length: 9 }, () => ({ start: '00:00', end: '01:00' })) }, '最多 8 段'],
      [{ dates: [{ date: '2026-02-30', windows: [] }] }, '有效的日期'],
      [{ dates: [{ date: '', windows: [] }] }, '（空白）'],
      [{ dates: [{ date: '2026-11-05', windows: [] }, { date: '2026-11-05', windows: [] }] }, '重複'],
    ]
    for (const [overrides, message] of cases) {
      expect(scheduleProblems(schedule(overrides)).join('\n')).toContain(message)
    }
  })

  it('parses times', () => {
    expect(timeToMinutes('18:30')).toBe(1110)
    expect(timeToMinutes('24:00')).toBeNull()
    expect(timeToMinutes('24:00', true)).toBe(1440)
  })

  it('normalizes order like the backend', () => {
    const raw = schedule({
      motors: [...schedule().motors].reverse(),
      daily: [{ start: '20:00', end: '21:00' }, { start: '09:00', end: '10:00' }],
      dates: [{ date: '2026-12-01', windows: [] }, { date: '2026-11-05', windows: [] }],
    })
    const normalized = normalizeSchedule(raw)
    expect(normalized.motors.map((motor) => motor.unitId)).toEqual([1, 2, 3, 4, 5])
    expect(normalized.daily.map((window) => window.start)).toEqual(['09:00', '20:00'])
    expect(normalized.dates.map((entry) => entry.date)).toEqual(['2026-11-05', '2026-12-01'])
  })
})

describe('schedule status', () => {
  it('formats show times relative to the backend day', () => {
    expect(formatShowTime('2026-11-04T18:00', '2026-11-04T12:00:00')).toBe('18:00')
    expect(formatShowTime('2026-11-05T14:00', '2026-11-04T12:00:00')).toBe('11/5 14:00')
  })

  it('counts down from the response time', () => {
    expect(phaseRemainingSeconds(status(), 0)).toBe(90)
    expect(phaseRemainingSeconds(status(), 30_000)).toBe(60)
    expect(phaseRemainingSeconds(status(), 200_000)).toBe(0)
    expect(phaseRemainingSeconds(status({ phaseEndsAt: null }), 0)).toBeNull()
  })

  it('describes each phase', () => {
    expect(describeStatus(status(), 0)).toBe('表演中 · 第 2 輪，剩 1:30，20:00 結束')
    expect(describeStatus(status({ phase: 'rest', phaseEndsAt: '2026-11-04T18:40:00' }), 0)).toBe('休息中 · 10:00後暖機開始下一輪，20:00 結束')
    expect(describeStatus(status({ phase: 'spinup', round: 2, phaseEndsAt: '2026-11-04T18:30:03' }), 0)).toBe('暖機中 · 3 秒後開始第 3 輪，20:00 結束')
    expect(describeStatus(status({ phase: 'off', window: null }), 0)).toBe('時段外 · 下一場 11/5 18:00')
    expect(describeStatus(status({ phase: 'off', window: null, nextShowAt: null }), 0)).toBe('時段外 · 之後沒有排定的時段')
    expect(describeStatus(status({ phase: 'ending', window: null }), 0)).toBe('結束中 · 馬達停止、燈光淡出 · 下一場 11/5 18:00')
    expect(describeStatus(status({ phase: 'disabled', running: false }), 0)).toBe('排程關閉')
    expect(describeStatus(status({ phase: null, running: false }), 0)).toContain('--api-only')
  })
})

describe('schedule API', () => {
  it('reads and saves through the same-origin API path', async () => {
    const state = { revision: 1, schedule: schedule() }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => state })
    vi.stubGlobal('fetch', fetchMock)
    expect(await getBackendSchedule()).toEqual(state)
    expect(fetchMock).toHaveBeenCalledWith('/api/schedule', { cache: 'no-store' })
    await saveBackendSchedule(schedule())
    expect(fetchMock).toHaveBeenLastCalledWith('/api/schedule', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(schedule()),
    })
  })

  it('returns null when the backend predates timed shows', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'not found' }) }))
    expect(await getBackendSchedule()).toBeNull()
  })
})
