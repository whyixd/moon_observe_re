import { EFFECT_SCHEMA_VERSION, effectTimeSeconds, type EffectModule } from './contract'

const BLACK = { r: 0, g: 0, b: 0 }
const WHITE = { r: 1, g: 1, b: 1 }

export const periodicLeds: EffectModule = {
  completion: {
    label: '亮點沿半圓完成一圈',
    frames: (parameters, fps) => fps * (parameters.periodSeconds ?? 4),
  },
  manifest: {
    schemaVersion: EFFECT_SCHEMA_VERSION,
    id: 'periodic-leds',
    label: '落雨',
    description: '每條半圓點亮指定數量的單點，相鄰亮點固定間隔暗點，整組亮點依設定週期沿半圓循環移動。',
    parameters: [
      {
        key: 'litCount',
        label: '亮點數',
        unit: '顆 / 半圓',
        min: 1,
        max: 156,
        step: 1,
        defaultValue: 12,
      },
      {
        key: 'darkGap',
        label: '暗點間隔',
        unit: '顆',
        min: 0,
        max: 155,
        step: 1,
        defaultValue: 12,
      },
      {
        key: 'periodSeconds',
        label: '移動週期',
        unit: '秒 / 圈',
        min: 0.01,
        max: 20,
        step: 0.01,
        defaultValue: 4,
      },
    ],
  },

  sample(context, parameters) {
    const litCount = Math.max(
      1,
      Math.min(context.ledCount, Math.round(parameters.litCount ?? 12)),
    )
    const darkGap = Math.max(
      0,
      Math.min(context.ledCount - 1, Math.round(parameters.darkGap ?? 12)),
    )
    const periodSeconds = Math.max(0.01, parameters.periodSeconds ?? 4)
    const offset = Math.floor(
      (effectTimeSeconds(context) / periodSeconds) * context.ledCount,
    ) % context.ledCount
    const spacing = darkGap + 1
    const relativeIndex = (context.ledIndex - offset + context.ledCount) % context.ledCount
    const litIndex = relativeIndex / spacing

    return Number.isInteger(litIndex) && litIndex < litCount
      ? WHITE
      : BLACK
  },
}
