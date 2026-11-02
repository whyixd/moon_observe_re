import { EFFECT_SCHEMA_VERSION, clamp01, type EffectModule, type EffectSampleContext } from './contract'
import { RAIN_LINES, rainStreak } from './rain'
import { randomRanks } from './randomLeds'

const DEFAULTS = { fillSeconds: 60, acceleration: 2, ledFadeSeconds: 0, holdSeconds: 5, fadeOutSeconds: 3 }

type Timing = { fill: number; acceleration: number; ledFade: number; hold: number; fadeOut: number; cycle: number }

// 各段長度取整數影格，一輪 = 填滿 + 單點淡入 + 全亮停留 + 淡出。 / Whole-frame stages; one round = fill + LED fade + hold + fade out.
function timing(parameters: Readonly<Record<string, number>>, fps: number): Timing {
  const frames = (key: keyof typeof DEFAULTS, min: number) =>
    Math.max(min, Math.round((parameters[key] ?? DEFAULTS[key]) * fps))
  const fill = frames('fillSeconds', 1)
  const ledFade = frames('ledFadeSeconds', 0)
  const hold = frames('holdSeconds', 0)
  const fadeOut = frames('fadeOutSeconds', 0)
  const acceleration = Math.max(1, parameters.acceleration ?? DEFAULTS.acceleration)
  return { fill, acceleration, ledFade, hold, fadeOut, cycle: fill + ledFade + hold + fadeOut }
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b)
}

// 以約半數的互質步長跳著排列 unit，相鄰 unit 在色盤上相隔約一半。
// Stride through the units by a coprime step near half, so neighbours sit about half the palette apart.
export function unitPalettePosition(unitIndex: number, unitCount: number): number {
  if (unitCount <= 1) return 0
  let stride = Math.max(1, Math.floor(unitCount / 2))
  while (stride > 1 && greatestCommonDivisor(stride, unitCount) !== 1) stride -= 1
  return ((unitIndex * stride) % unitCount) / (unitCount - 1)
}

const unitPosition = (context: EffectSampleContext) => unitPalettePosition(context.unitIndex, context.unitCount)

export const randomFill: EffectModule = {
  completion: {
    label: '燈點隨機填滿、停留並淡出',
    frames: (parameters, fps) => timing(parameters, fps).cycle,
  },
  manifest: {
    schemaVersion: EFFECT_SCHEMA_VERSION,
    id: 'random-fill',
    label: '隨機填滿',
    description: '從全暗開始，每次在隨機位置點亮一顆燈點，一開始很慢、越來越快，直到填滿整條燈帶，停留後淡出再重新開始。每組從色盤取一個純色，相鄰組別跳著取色，沒有顏色連續性。',
    parameters: [
      { key: 'fillSeconds', label: '填滿時間', unit: 's', min: 5, max: 300, step: 5, defaultValue: DEFAULTS.fillSeconds },
      { key: 'acceleration', label: '加速程度', unit: '倍', min: 1, max: 4, step: 0.25, defaultValue: DEFAULTS.acceleration },
      { key: 'ledFadeSeconds', label: '單點淡入', unit: 's', min: 0, max: 5, step: 0.25, defaultValue: DEFAULTS.ledFadeSeconds },
      { key: 'holdSeconds', label: '全亮停留', unit: 's', min: 0, max: 30, step: 1, defaultValue: DEFAULTS.holdSeconds },
      { key: 'fadeOutSeconds', label: '淡出時間', unit: 's', min: 0, max: 10, step: 0.5, defaultValue: DEFAULTS.fadeOutSeconds },
    ],
  },

  sample(context, parameters) {
    if (context.ledCount <= 0) return { r: 0, g: 0, b: 0 }
    const { fill, acceleration, ledFade, hold, fadeOut, cycle } = timing(parameters, context.controllerFps)
    const frame = Math.max(0, context.controllerFrame)
    const round = Math.floor(frame / cycle)
    const elapsed = frame - round * cycle
    // 每一輪、每組各自重新洗牌；同組兩條半圓共用順序。 / Reshuffle per round and unit; both arcs share the order.
    const rank = randomRanks(round, context.unitIndex, context.ledCount)[context.ledIndex]
    // 一輪從全暗開始逐顆點亮，已亮數量 = 燈數 × (經過時間 / 填滿時間)^加速程度：一開始慢、後面越來越快，
    // 最後一顆在填滿時間點亮；加速程度 1 為等速。
    // Each round starts dark; lit count = ledCount * (t / fill)^acceleration, so lighting starts slow and speeds up,
    // with the last LED at the fill time. Acceleration 1 is a constant rate.
    const start = Math.floor(fill * ((rank + 1) / context.ledCount) ** (1 / acceleration))
    const lit = elapsed < start ? 0 : ledFade === 0 ? 1 : clamp01((elapsed - start + 1) / ledFade)
    const fadeStart = fill + ledFade + hold
    const out = fadeOut === 0 || elapsed < fadeStart ? 1 : clamp01(1 - (elapsed - fadeStart + 1) / fadeOut)
    const brightness = lit * out
    return { r: brightness, g: brightness, b: brightness }
  },
  // 雨天：點亮順序不變，已亮的燈改閃雨絲，填滿時等於全亮的滿版雨絲。
  // Rain: same order, lit LEDs flash streaks instead, so the filled disc matches full-on's rain.
  rain: (context, _parameters, base) => base() * rainStreak(context, RAIN_LINES.sparseDensity),
  // 不論漸層方向，每組都取一個純色。 / Every axis gives each unit one solid colour.
  gradientPosition: unitPosition,
  unitGradientPosition: unitPosition,
}
