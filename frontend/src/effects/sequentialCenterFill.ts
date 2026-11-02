import {
  EFFECT_SCHEMA_VERSION,
  clamp01,
  globalEffectTimeSeconds,
  type EffectModule,
} from './contract'
import { rainStripe } from './rain'

const BLACK = { r: 0, g: 0, b: 0 }
const WHITE = { r: 1, g: 1, b: 1 }

export const sequentialCenterFill: EffectModule = {
  completion: {
    label: '所有 Unit 完成由中心向外點亮',
    frames: (parameters, fps, unitCount) => {
      const expansion = parameters.expansionSeconds ?? 2.5
      const hold = parameters.holdSeconds ?? 0.4
      return Math.ceil(((Math.max(1, unitCount) - 1) * (expansion + hold) + expansion) * fps) + 1
    },
  },
  manifest: {
    schemaVersion: EFFECT_SCHEMA_VERSION,
    id: 'sequential-center-fill',
    label: '逐月',
    description: '從 Unit 1 起逐組由中心向外點亮；已亮起的組別保持全亮，直到九組全部點亮。',
    parameters: [
      {
        key: 'expansionSeconds',
        label: 'Expansion duration',
        unit: 's / unit',
        min: 0.5,
        max: 8,
        step: 0.25,
        defaultValue: 2.5,
      },
      {
        key: 'holdSeconds',
        label: 'Full hold',
        unit: 's',
        min: 0,
        max: 2,
        step: 0.1,
        defaultValue: 0.4,
      },
    ],
  },

  sample(context, parameters) {
    const expansionSeconds = Math.max(0.01, parameters.expansionSeconds ?? 2.5)
    const holdSeconds = Math.max(0, parameters.holdSeconds ?? 0.4)
    const stageSeconds = expansionSeconds + holdSeconds
    const unitCount = Math.max(1, context.unitCount)
    const time = Math.max(0, globalEffectTimeSeconds(context))
    const activeUnit = Math.min(Math.floor(time / stageSeconds), unitCount - 1)

    if (context.unitIndex < activeUnit) return WHITE
    if (context.unitIndex > activeUnit) return BLACK

    const stageTime = time - activeUnit * stageSeconds
    const progress = clamp01(stageTime / expansionSeconds)
    const radialPixelStep = context.ledCount <= 1
      ? 1
      : 2 / (context.ledCount - 1)
    const lightFront = progress * (1 + radialPixelStep)
    const brightness = clamp01(
      (lightFront - context.normalizedRadius) / radialPixelStep,
    )

    return {
      r: brightness,
      g: brightness,
      b: brightness,
    }
  },
  // 雨天：填滿過程不變，只亮同心條紋。 / Rain: same fill, only the concentric stripes light.
  rain: (context, _parameters, base) => base() * rainStripe(context),
}
