import { EFFECT_SCHEMA_VERSION, type EffectModule } from './contract'
import { randomRanks } from './randomLeds'

const DEFAULTS = { fadeInSeconds: 0, holdSeconds: 1, fadeOutSeconds: 1, gapSeconds: 0.2 }
// 洗牌種子，與其他效果的燈點洗牌分開。 / Shuffle seed, kept apart from the per-LED shuffles of other effects.
const SHUFFLE_SEED = 1009

type Timing = { fadeIn: number; hold: number; fadeOut: number; slot: number }

// 每次亮起一台 = 淡入 + 全亮停留 + 淡出 + 全暗，各取整數影格。
// One unit's turn = fade in + hold + fade out + dark gap, each in whole frames.
function timing(parameters: Readonly<Record<string, number>>, fps: number): Timing {
  const frames = (key: keyof typeof DEFAULTS) => Math.max(0, Math.round((parameters[key] ?? DEFAULTS[key]) * fps))
  const fadeIn = frames('fadeInSeconds')
  const hold = frames('holdSeconds')
  const fadeOut = frames('fadeOutSeconds')
  return { fadeIn, hold, fadeOut, slot: Math.max(1, fadeIn + hold + fadeOut + frames('gapSeconds')) }
}

// 第 round 輪中，這台輪到第幾個。每輪九台各亮一次、順序隨機（固定種子）；
// 若這輪第一台與上一輪最後一台相同，交換這輪前兩台，避免同一台連續亮兩次。
// This unit's turn within a round: every unit once per round in a fixed-seed random order. When a round
// would start with the unit that ended the previous one, its first two turns swap so no unit lights twice in a row.
export function unitTurn(round: number, unitIndex: number, unitCount: number): number {
  if (unitCount <= 2) return unitIndex
  const ranks = randomRanks(round, SHUFFLE_SEED, unitCount)
  const rank = ranks[unitIndex]
  if (round === 0) return rank
  const previous = randomRanks(round - 1, SHUFFLE_SEED, unitCount)
  const first = ranks.indexOf(0)
  if (previous[first] !== unitCount - 1) return rank
  return rank === 0 ? 1 : rank === 1 ? 0 : rank
}

export const unitRandom: EffectModule = {
  completion: {
    label: '每台各隨機亮起一次',
    frames: (parameters, fps, unitCount) => timing(parameters, fps).slot * Math.max(1, unitCount),
  },
  manifest: {
    schemaVersion: EFFECT_SCHEMA_VERSION,
    id: 'unit-random',
    label: '隨機單台',
    description: '一次只有一台全亮：隨機選一台亮起、停留後淡出，再換另一台，同一台不會連續亮兩次；每輪九台各亮一次，順序每輪重新隨機。九台共用同一個時間表，不受天氣的多雲錯開與雨天線條影響。',
    parameters: [
      { key: 'fadeInSeconds', label: '淡入', unit: 's', min: 0, max: 5, step: 0.1, defaultValue: DEFAULTS.fadeInSeconds },
      { key: 'holdSeconds', label: '全亮停留', unit: 's', min: 0, max: 10, step: 0.1, defaultValue: DEFAULTS.holdSeconds },
      { key: 'fadeOutSeconds', label: '淡出', unit: 's', min: 0, max: 10, step: 0.1, defaultValue: DEFAULTS.fadeOutSeconds },
      { key: 'gapSeconds', label: '換台前全暗', unit: 's', min: 0, max: 5, step: 0.1, defaultValue: DEFAULTS.gapSeconds },
    ],
  },
  ignoresWeatherTiming: true,

  sample(context, parameters) {
    const units = Math.max(1, context.unitCount)
    const { fadeIn, hold, fadeOut, slot } = timing(parameters, context.controllerFps)
    const frame = Math.max(0, context.controllerFrame)
    const turn = Math.floor(frame / slot)
    const round = Math.floor(turn / units)
    if (unitTurn(round, Math.min(Math.max(0, context.unitIndex), units - 1), units) !== turn - round * units) {
      return { r: 0, g: 0, b: 0 }
    }
    const elapsed = frame - turn * slot
    const brightness = elapsed < fadeIn ? (elapsed + 1) / fadeIn
      : elapsed < fadeIn + hold ? 1
        : elapsed < fadeIn + hold + fadeOut ? 1 - (elapsed - fadeIn - hold + 1) / fadeOut
          : 0
    return { r: brightness, g: brightness, b: brightness }
  },
}
