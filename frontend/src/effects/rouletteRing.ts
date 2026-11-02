import { EFFECT_SCHEMA_VERSION, clamp01, type EffectModule } from './contract'

const DEFAULTS = {
  sweeps: 4,
  startStepFrames: 2,
  endStepSeconds: 0.6,
  holdSeconds: 1,
  dimSeconds: 3,
  spreadStepSeconds: 0.15,
  ringHoldSeconds: 2,
  glitchSeconds: 1.2,
  glitchSpreadSeconds: 2,
  flickerFrames: 2,
  endDarkSeconds: 0.5,
}

type Timing = {
  /** 第 k 台亮起的影格（共 steps + 1 個位置）；最後一個位置是中間那台。 / Frame each chase position starts; the last is the centre unit. */
  starts: number[]
  path: number[]
  centre: number
  dimStart: number
  dim: number
  spreadStart: number
  spreadStep: number
  glitchStart: number
  glitch: number
  glitchSpread: number
  flicker: number
  cycle: number
}

let cached: { key: string; timing: Timing } | undefined

// 固定種子的 0..1 雜湊（32 位元整數運算，前後端可一致）。 / Fixed-seed hash to 0..1 (32-bit integer math, portable).
export function hash01(round: number, unit: number, salt: number): number {
  let state = (Math.imul(round + 1, 0x9e3779b1) ^ Math.imul(unit + 1, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35)) >>> 0
  state = Math.imul(state ^ (state >>> 16), 0x7feb352d) >>> 0
  state = Math.imul(state ^ (state >>> 15), 0x846ca68b) >>> 0
  state = (state ^ (state >>> 16)) >>> 0
  return state / 0x100000000
}

// 輪盤路徑：從第 1 台開始左右來回 sweeps 趟，再走到中間那台停下；每步時間由快到慢（等比）。
// Roulette path: from unit 1, bounce `sweeps` times, then run to the centre unit; step times grow geometrically.
export function rouletteTiming(parameters: Readonly<Record<string, number>>, fps: number, unitCount: number): Timing {
  const value = (key: keyof typeof DEFAULTS) => parameters[key] ?? DEFAULTS[key]
  const key = [fps, unitCount, ...Object.keys(DEFAULTS).map((name) => value(name as keyof typeof DEFAULTS))].join(':')
  if (cached?.key === key) return cached.timing
  const units = Math.max(1, unitCount)
  const centre = Math.floor((units - 1) / 2)
  const sweeps = Math.max(0, Math.round(value('sweeps')))
  const path = [0]
  let direction = 1
  for (let sweep = 0; sweep < sweeps && units > 1; sweep += 1) {
    for (let move = 0; move < units - 1; move += 1) path.push(path[path.length - 1] + direction)
    direction = -direction
  }
  while (path[path.length - 1] !== centre) path.push(path[path.length - 1] + (centre > path[path.length - 1] ? 1 : -1))

  // 起始每步以影格為單位（至少 1 格）；之後每步各自取整數影格、等比拉長到最後每步，且不會比前一步短。
  // The first step is in frames (at least one); each later step is whole frames growing geometrically to the
  // last step, never shorter than the step before.
  const first = Math.max(1, Math.round(value('startStepFrames')))
  const last = Math.max(first, Math.round(Math.max(0, value('endStepSeconds')) * fps))
  const steps = path.length - 1
  const starts = [0]
  let previous = first
  for (let step = 0; step < steps; step += 1) {
    const length = steps === 1 ? last : Math.max(previous, Math.round(first * (last / first) ** (step / (steps - 1))))
    previous = length
    starts.push(starts[starts.length - 1] + length)
  }
  const frames = (name: keyof typeof DEFAULTS) => Math.max(0, Math.round(value(name) * fps))
  const dimStart = starts[steps] + frames('holdSeconds')
  const dim = Math.max(1, frames('dimSeconds'))
  const spreadStart = dimStart + dim
  const spreadStep = frames('spreadStepSeconds')
  const glitchStart = spreadStart + spreadStep * Math.max(centre, units - 1 - centre) + frames('ringHoldSeconds')
  const glitch = Math.max(1, frames('glitchSeconds'))
  const glitchSpread = frames('glitchSpreadSeconds')
  const flicker = Math.max(1, Math.round(value('flickerFrames')))
  const result = {
    starts, path, centre, dimStart, dim, spreadStart, spreadStep, glitchStart, glitch, glitchSpread, flicker,
    cycle: glitchStart + glitchSpread + glitch + frames('endDarkSeconds'),
  }
  cached = { key, timing: result }
  return result
}

export const rouletteRing: EffectModule = {
  completion: {
    label: '輪盤停在中間、由圓心變暗後外圈擴散再淡出',
    frames: (parameters, fps, unitCount) => rouletteTiming(parameters, fps, unitCount).cycle,
  },
  manifest: {
    schemaVersion: EFFECT_SCHEMA_VERSION,
    id: 'roulette-ring',
    label: '輪盤收束',
    description: '像輪盤一樣，一次只有一台全亮，從第 1 台開始左右來回移動，由快漸漸變慢，最後停在中間那台；停留後由圓心向圓周逐顆變暗，只留最外圈一顆燈，再由中間向兩側快速點亮每台最外圈的一顆燈，停留後各台外圈依隨機順序（可互相重疊）不規則閃爍、越閃越暗後關閉，再重新開始。九台共用同一個時間表，不受天氣的多雲錯開與雨天線條影響。',
    parameters: [
      { key: 'sweeps', label: '來回趟數', unit: '趟', min: 0, max: 20, step: 1, defaultValue: DEFAULTS.sweeps },
      { key: 'startStepFrames', label: '起始每步', unit: '影格', min: 1, max: 40, step: 1, defaultValue: DEFAULTS.startStepFrames },
      { key: 'endStepSeconds', label: '最後每步', unit: 's', min: 0.05, max: 3, step: 0.05, defaultValue: DEFAULTS.endStepSeconds },
      { key: 'holdSeconds', label: '停下後停留', unit: 's', min: 0, max: 10, step: 0.1, defaultValue: DEFAULTS.holdSeconds },
      { key: 'dimSeconds', label: '由圓心變暗', unit: 's', min: 0.5, max: 20, step: 0.5, defaultValue: DEFAULTS.dimSeconds },
      { key: 'spreadStepSeconds', label: '外圈擴散每台', unit: 's', min: 0, max: 2, step: 0.05, defaultValue: DEFAULTS.spreadStepSeconds },
      { key: 'ringHoldSeconds', label: '外圈停留', unit: 's', min: 0, max: 30, step: 0.5, defaultValue: DEFAULTS.ringHoldSeconds },
      { key: 'glitchSeconds', label: '每台閃爍時間', unit: 's', min: 0.1, max: 10, step: 0.1, defaultValue: DEFAULTS.glitchSeconds },
      { key: 'glitchSpreadSeconds', label: '閃爍開始分散', unit: 's', min: 0, max: 10, step: 0.1, defaultValue: DEFAULTS.glitchSpreadSeconds },
      { key: 'flickerFrames', label: '閃爍切換', unit: '影格', min: 1, max: 20, step: 1, defaultValue: DEFAULTS.flickerFrames },
      { key: 'endDarkSeconds', label: '結尾全暗', unit: 's', min: 0, max: 10, step: 0.1, defaultValue: DEFAULTS.endDarkSeconds },
    ],
  },
  ignoresWeatherTiming: true,

  sample(context, parameters) {
    const units = Math.max(1, context.unitCount)
    const t = rouletteTiming(parameters, context.controllerFps, units)
    const round = Math.floor(Math.max(0, context.controllerFrame) / t.cycle)
    const frame = Math.max(0, context.controllerFrame) - round * t.cycle
    const unit = Math.min(Math.max(0, context.unitIndex), units - 1)
    const off = { r: 0, g: 0, b: 0 }
    let brightness = 0

    if (frame < t.dimStart) {
      // 輪盤：找出目前停在哪一台。 / Roulette: which position is lit now.
      let position = t.path.length - 1
      while (position > 0 && t.starts[position] > frame) position -= 1
      if (t.path[position] !== unit) return off
      brightness = 1
    } else {
      // 最外圈：與燈帶兩端距離不到半顆燈。 / Outermost: within half an LED of either strip end.
      const pixelStep = context.ledCount <= 1 ? 1 : 2 / (context.ledCount - 1)
      const outermost = context.normalizedRadius > 1 - pixelStep / 2
      if (frame < t.spreadStart) {
        if (unit !== t.centre) return off
        if (outermost) {
          brightness = 1
        } else {
          // 變暗前緣由圓心走到圓周，越過的燈點在一顆燈的距離內熄滅；最外圈一顆不受影響。
          // The dark front moves from the centre to the rim; each LED it passes goes out within one LED; the outermost stays.
          const front = (frame - t.dimStart + 1) / t.dim
          brightness = clamp01((context.normalizedRadius - front) / pixelStep + 1)
        }
      } else {
        if (!outermost) return off
        const distance = Math.abs(unit - t.centre)
        if (frame < t.spreadStart + distance * t.spreadStep) return off
        // 各台在分散時間內隨機開始閃爍（可互相重疊），閃爍越來越常熄滅，結束後關閉；每輪重新隨機。
        // Each unit starts glitching at a random time within the spread (overlaps allowed), goes dark more and
        // more often, then stays off; re-randomised every round.
        const start = t.glitchStart + Math.floor(hash01(round, unit, 0) * (t.glitchSpread + 1))
        if (frame < start) {
          brightness = 1
        } else if (frame < start + t.glitch) {
          const progress = (frame - start) / t.glitch
          const cell = Math.floor((frame - start) / t.flicker)
          brightness = hash01(round, unit, cell + 1) < 0.85 - 0.75 * progress ? 1 : 0
        }
      }
    }
    return { r: brightness, g: brightness, b: brightness }
  },
}
