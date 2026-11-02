import { SPECTRUM } from './color'
import {
  EFFECT_SCHEMA_VERSION,
  mixRgb,
  scaleRgb,
  type EffectModule,
} from './contract'

export const spectrumCycle: EffectModule = {
  completion: {
    label: '完成 20 個控制器影格的光譜循環',
    frames: () => 20,
  },
  manifest: {
    schemaVersion: EFFECT_SCHEMA_VERSION,
    id: 'spectrum-cycle',
    label: 'Spectrum cycle / 光譜循環',
    description: '保留原始 20-frame 色彩循環，作為相容性基準。',
    parameters: [],
  },

  brightness(context, colorMode) {
    const spatialBrightness = 0.42 + 0.58 * Math.sin(Math.PI * context.normalizedStripPosition)
    if (colorMode === 'gradient') return spatialBrightness
    const phase = (context.controllerFrame % 20) / 20
    return spatialBrightness * (0.7 + 0.3 * Math.cos(2 * Math.PI * phase))
  },
  gradientPosition(context, axis, colorCount) {
    const framePhase = (context.controllerFrame % 20) / 20
    const position = axis === 'radius' ? context.normalizedRadius : context.normalizedStripPosition
    return framePhase + position * 1.8 / colorCount
  },
  loopGradient: true,

  sample(context) {
    const stripPhase = context.normalizedStripPosition
    const framePhase = (context.controllerFrame % 20) / 20
    const palettePosition =
      (framePhase * SPECTRUM.length + stripPhase * 1.8) % SPECTRUM.length
    const paletteIndex = Math.floor(palettePosition)
    const nextIndex = (paletteIndex + 1) % SPECTRUM.length
    const color = mixRgb(
      SPECTRUM[paletteIndex],
      SPECTRUM[nextIndex],
      palettePosition - paletteIndex,
    )
    const brightness = 0.42 + 0.58 * Math.sin(Math.PI * stripPhase)

    return scaleRgb(color, brightness)
  },
}
