import { EFFECT_SCHEMA_VERSION, type EffectModule } from './contract'

const DEFAULTS = { stepSeconds: 0.5, fadeSeconds: 0, gapSeconds: 0.5, holdSeconds: 2, endDarkSeconds: 0.5 }

type Timing = { step: number; fade: number; gap: number; hold: number; endDark: number; inward: number; cycle: number }

// 各段長度取整數影格。一輪 = 由左至右 N 步 + 全暗 + 兩側向內 ⌈N/2⌉ 步 + 中間停留 + 全暗。
// Whole-frame stages; one round = N steps left to right + dark gap + ⌈N/2⌉ inward steps + centre hold + dark.
function timing(parameters: Readonly<Record<string, number>>, fps: number, unitCount: number): Timing {
  const frames = (key: keyof typeof DEFAULTS, min: number) =>
    Math.max(min, Math.round((parameters[key] ?? DEFAULTS[key]) * fps))
  const units = Math.max(1, unitCount)
  const step = frames('stepSeconds', 1)
  const fade = Math.min(step, frames('fadeSeconds', 0))
  const gap = frames('gapSeconds', 0)
  const hold = frames('holdSeconds', 0)
  const endDark = frames('endDarkSeconds', 0)
  const inward = Math.ceil(units / 2)
  return { step, fade, gap, hold, endDark, inward, cycle: (units + inward) * step + gap + hold + endDark }
}

// [start, end) 全亮；有淡入淡出時在 start 起淡入、在 end 起淡出，與相鄰一步交叉。
// Lit over [start, end); with a fade it rises from start and falls from end, crossing the neighbouring step.
function pulse(frame: number, start: number, end: number, fade: number): number {
  if (fade === 0) return frame >= start && frame < end ? 1 : 0
  if (frame < start) return 0
  if (frame < start + fade) return (frame - start + 1) / fade
  if (frame < end) return 1
  if (frame < end + fade) return 1 - (frame - end + 1) / fade
  return 0
}

export const unitChase: EffectModule = {
  completion: {
    label: '由左至右、兩側向內到中間停留後全暗',
    frames: (parameters, fps, unitCount) => timing(parameters, fps, unitCount).cycle,
  },
  manifest: {
    schemaVersion: EFFECT_SCHEMA_VERSION,
    id: 'unit-chase',
    label: '逐台巡行',
    description: '一次只有一台全亮，由左至右逐台移動（下一台亮起時前一台熄滅），到最右後全暗；再由兩側同時向內一對一對移動，最後停在中間那台，停留後全暗再重新開始。九台共用同一個時間表，不受天氣的多雲錯開與雨天線條影響。',
    parameters: [
      { key: 'stepSeconds', label: '每步時間', unit: 's', min: 0.1, max: 5, step: 0.1, defaultValue: DEFAULTS.stepSeconds },
      { key: 'fadeSeconds', label: '切換淡入淡出', unit: 's', min: 0, max: 2, step: 0.05, defaultValue: DEFAULTS.fadeSeconds },
      { key: 'gapSeconds', label: '兩段之間全暗', unit: 's', min: 0, max: 5, step: 0.1, defaultValue: DEFAULTS.gapSeconds },
      { key: 'holdSeconds', label: '中間停留', unit: 's', min: 0, max: 30, step: 0.5, defaultValue: DEFAULTS.holdSeconds },
      { key: 'endDarkSeconds', label: '結尾全暗', unit: 's', min: 0, max: 10, step: 0.1, defaultValue: DEFAULTS.endDarkSeconds },
    ],
  },
  ignoresWeatherTiming: true,

  sample(context, parameters) {
    const units = Math.max(1, context.unitCount)
    const { step, fade, gap, hold, cycle } = timing(parameters, context.controllerFps, units)
    const frame = ((Math.max(0, context.controllerFrame) % cycle) + cycle) % cycle
    const unit = Math.min(Math.max(0, context.unitIndex), units - 1)
    // 由左至右：第 unit 步。 / Left to right: step `unit`.
    const outward = pulse(frame, unit * step, (unit + 1) * step, fade)
    // 兩側向內：第 k 步點亮 k 與 N-1-k，最後一步加上中間停留。
    // Inward: step k lights k and N-1-k; the last step also holds.
    const pair = Math.min(unit, units - 1 - unit)
    const inwardStart = units * step + gap + pair * step
    const last = pair === Math.ceil(units / 2) - 1
    const inward = pulse(frame, inwardStart, inwardStart + step + (last ? hold : 0), fade)
    const brightness = Math.max(outward, inward)
    return { r: brightness, g: brightness, b: brightness }
  },
}
