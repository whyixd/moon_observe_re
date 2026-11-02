import { EFFECT_SCHEMA_VERSION, type EffectModule } from './contract'

const BLACK = { r: 0, g: 0, b: 0 }
const CENTER_FADE_RADIUS = 0.2

export const worldUpperHalf: EffectModule = {
  manifest: {
    schemaVersion: EFFECT_SCHEMA_VERSION,
    id: 'world-upper-half',
    label: '空間上方 1/3 圓',
    description: '無角度回授模擬：每次點亮從圓周到圓心的半條燈帶，靠近圓心逐漸變暗；只在該半條朝向上方的 120° 旋轉區間內點亮。',
    parameters: [],
  },

  sample(context) {
    const projection = context.unitPhaseProjection
    const onUpperSide = projection * (0.5 - context.normalizedStripPosition) > 0
    if (Math.abs(projection) <= 0.5 || !onUpperSide) return BLACK
    const t = Math.min(1, context.normalizedRadius / CENTER_FADE_RADIUS)
    const brightness = t * t * (3 - 2 * t)
    return { r: brightness, g: brightness, b: brightness }
  },
}
