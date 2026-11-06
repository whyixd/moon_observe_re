import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBackendSchedule, saveBackendSchedule, type ScheduleDocument, type ScheduleStatus } from '../src/backendApi'
import { describeStatus, formatShowTime, normalizeSchedule, phaseRemainingSeconds, scheduleProblems, timeToMinutes } from '../src/schedule'

afterEach(() => vi.unstubAllGlobals())

function schedule(overrides: Partial<ScheduleDocument> = {}): ScheduleDocument {
  return {
    schemaVersion: 3,
    enabled: true,
    spinUpSeconds: 5,
    motors: [1, 2, 3, 4, 5].map((unitId) => ({ unitId, speed: 'max' as const, direction: 'cw' as const })),
    daily: [{ start: '18:00', end: '20:00', mode: 'continuous' as const }],
    dates: [],
    ...overrides,
  }
}

function status(overrides: Partial<ScheduleStatus> = {}): ScheduleStatus {
  return {
    now: '2026-11-04T18:30:00',
    running: true,
    phase: 'run',
    mode: 'continuous',
    round: null,
    phaseEndsAt: null,
    window: { start: '2026-11-04T18:00', end: '2026-11-04T20:00', mode: 'continuous' },
    today: [{ start: '18:00', end: '20:00', mode: 'continuous' as const }],
    nextShowAt: '2026-11-05T18:00',
    motorStartAt: null,
    ...overrides,
  }
}

describe('schedule validation', () => {
  it('accepts the default shape and 24:00 ends', () => {
    expect(scheduleProblems(schedule())).toEqual([])
    expect(scheduleProblems(schedule({ daily: [{ start: '22:00', end: '24:00', mode: 'continuous' as const }] }))).toEqual([])
    expect(scheduleProblems(schedule({ daily: [{ start: '18:00', end: '19:00', mode: 'continuous' as const }, { start: '19:00', end: '20:00', mode: 'continuous' as const }] }))).toEqual([])
    expect(scheduleProblems(schedule({ dates: [{ date: '2026-11-10', windows: [] }] }))).toEqual([])
  })

  it('matches the backend rules', () => {
    const cases: [Partial<ScheduleDocument>, string][] = [
      [{ spinUpSeconds: 31 }, '提前啟動'],
      [{ spinUpSeconds: -1 }, '提前啟動'],
      [{ spinUpSeconds: Number.NaN }, '提前啟動'],
      [{ daily: [{ start: '18:00', end: '20:00', mode: 'cycle' }] }, '休息時間'],
      [{ daily: [{ start: '18:00', end: '20:00', mode: 'cycle', restMinutes: 1.5 }] }, '休息時間'],
      [{ daily: [{ start: '18:00', end: '20:00', mode: 'cycle', restMinutes: 241 }] }, '休息時間'],
      [{ daily: [{ start: '8:00', end: '09:00', mode: 'continuous' }] }, 'HH:MM'],
      [{ daily: [{ start: '24:00', end: '24:00', mode: 'continuous' as const }] }, 'HH:MM'],
      [{ daily: [{ start: '22:00', end: '02:00', mode: 'continuous' as const }] }, '跨午夜'],
      [{ daily: [{ start: '18:00', end: '20:00', mode: 'continuous' as const }, { start: '19:30', end: '21:00', mode: 'continuous' as const }] }, '重疊'],
      [{ daily: Array.from({ length: 9 }, () => ({ start: '00:00', end: '01:00', mode: 'continuous' as const })) }, '最多 8 段'],
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
      daily: [{ start: '20:00', end: '21:00', mode: 'continuous' as const }, { start: '09:00', end: '10:00', mode: 'continuous' as const }],
      dates: [{ date: '2026-12-01', windows: [] }, { date: '2026-11-05', windows: [] }],
    })
    const normalized = normalizeSchedule(raw)
    expect(normalizeSchedule(schedule({ daily: [{ start: '09:00', end: '10:00', mode: 'continuous', restMinutes: 5 }] })).daily)
      .toEqual([{ start: '09:00', end: '10:00', mode: 'continuous' }])
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
    const finishing = status({ phase: 'finishing', phaseEndsAt: '2026-11-04T18:31:30' })
    expect(phaseRemainingSeconds(finishing, 0)).toBe(90)
    expect(phaseRemainingSeconds(finishing, 30_000)).toBe(60)
    expect(phaseRemainingSeconds(finishing, 200_000)).toBe(0)
    expect(phaseRemainingSeconds(status(), 0)).toBeNull()
  })

  it('describes each phase', () => {
    expect(describeStatus(status(), 0)).toBe('馬達運轉中 · 持續時段 18:00–20:00（結束時播完當輪才停）')
    expect(describeStatus(status({ window: { start: '2026-11-04T22:00', end: '2026-11-05T00:00', mode: 'continuous' } }), 0))
      .toBe('馬達運轉中 · 持續時段 22:00–11/5 00:00（結束時播完當輪才停）')
    expect(describeStatus(status({ phase: 'spinup', now: '2026-11-04T17:59:55', phaseEndsAt: '2026-11-04T17:59:58' }), 0))
      .toBe('馬達暖機 · 3 秒後燈光進入新一輪 · 持續時段 18:00–20:00')
    expect(describeStatus(status({ phase: 'finishing', window: null, now: '2026-11-04T20:00:10', phaseEndsAt: '2026-11-04T20:02:10' }), 0))
      .toBe('收尾中 · 時段已結束，2:00後播完這一輪馬達停止')
    expect(describeStatus(status({ phase: 'off', window: null, motorStartAt: '2026-11-05T17:57:40' }), 0))
      .toBe('時段外 · 馬達停止、燈光照常 · 下一場 11/5 18:00，馬達約 11/5 17:57 啟動')
    expect(describeStatus(status({ phase: 'off', window: null, nextShowAt: null }), 0)).toBe('時段外 · 馬達停止、燈光照常 · 之後沒有排定的時段')
    const cycleWindow = { start: '2026-11-04T18:00', end: '2026-11-04T20:00', mode: 'cycle' as const, restMinutes: 10 }
    expect(describeStatus(status({ phase: 'play', mode: 'cycle', round: 2, window: cycleWindow, phaseEndsAt: '2026-11-04T18:31:30' }), 0))
      .toBe('表演中 · 第 2 輪，剩 1:30 · 循環時段 18:00–20:00')
    expect(describeStatus(status({ phase: 'rest', mode: 'cycle', round: 2, window: cycleWindow, phaseEndsAt: '2026-11-04T18:40:00' }), 0))
      .toBe('休息中 · 馬達停、燈光照常 · 10:00後暖機開始下一輪 · 循環時段 18:00–20:00')
    expect(describeStatus(status({ phase: 'spinup', mode: 'cycle', round: 2, window: cycleWindow, phaseEndsAt: '2026-11-04T18:30:05' }), 0))
      .toBe('馬達暖機 · 5 秒後燈光從第 1 段播放第 3 輪 · 循環時段 18:00–20:00')
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
