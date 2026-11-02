import { EFFECT_SCHEMA_VERSION, effectTimeSeconds, type EffectModule } from './contract'
import { rainRing } from './rain'

const TAU = Math.PI * 2
const cycle = (value: number) => value - Math.floor(value)

export const sineSwell: EffectModule = {
  completion: { label: '亮度波完成一次移動', frames: (p, fps) => fps / (p.speedHz ?? 0.3) },
  manifest: { schemaVersion: EFFECT_SCHEMA_VERSION, id: 'sine-swell', label: '流光波',
    description: '整條燈帶點亮，一道 sine 亮度波沿半圓從一端流向另一端。',
    parameters: [
      { key: 'speedHz', label: '移動頻率', unit: 'Hz', min: 0.05, max: 2, step: 0.05, defaultValue: 0.3 },
      { key: 'waveCount', label: '波數', unit: '波', min: 0.5, max: 6, step: 0.5, defaultValue: 1 },
      { key: 'depth', label: '亮度起伏', unit: '比例', min: 0.1, max: 1, step: 0.05, defaultValue: 0.6 },
    ] },
  sample(context, parameters) {
    const phase = TAU * (
      (parameters.waveCount ?? 1) * context.normalizedStripPosition
      - (parameters.speedHz ?? 0.3) * effectTimeSeconds(context)
    )
    // 波谷亮度 = 1 - depth，波峰 = 1。 / Trough is 1 - depth, crest is full brightness.
    const brightness = 1 - (parameters.depth ?? 0.6) * (0.5 - 0.5 * Math.cos(phase))
    return { r: brightness, g: brightness, b: brightness }
  },
  // 雨天：只留波峰細環；燈帶位置差兩倍才是半徑差。 / Rain: only the crest ring; radius distance is twice the strip distance.
  rain(context, parameters) {
    const waveCount = parameters.waveCount ?? 1
    const wave = waveCount * context.normalizedStripPosition - (parameters.speedHz ?? 0.3) * effectTimeSeconds(context)
    return rainRing(2 * (cycle(wave + 0.5) - 0.5) / waveCount, context.ledCount)
  },
}
