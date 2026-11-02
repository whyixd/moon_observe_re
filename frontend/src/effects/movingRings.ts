import {
  EFFECT_SCHEMA_VERSION,
  clamp01,
  effectTimeSeconds,
  type EffectModule,
} from './contract'

const TAU = Math.PI * 2
const BLACK = { r: 0, g: 0, b: 0 }

export const movingRings: EffectModule = {
  completion: {
    label: '光環完成一次往返',
    frames: (parameters, fps) => fps / (parameters.speedHz ?? 0.25),
  },
  manifest: {
    schemaVersion: EFFECT_SCHEMA_VERSION,
    id: 'moving-rings',
    label: 'Moving rings / 往返光環',
    description: '相鄰純白光環反向往返，各自在不相撞的 radial lane 內移動。',
    parameters: [
      {
        key: 'speedHz',
        label: 'Movement speed',
        unit: 'Hz',
        min: 0.05,
        max: 1.5,
        step: 0.05,
        defaultValue: 0.25,
      },
      {
        key: 'ringCount',
        label: 'Ring count',
        unit: 'rings',
        min: 1,
        max: 6,
        step: 1,
        defaultValue: 3,
      },
    ],
  },

  sample(context, parameters) {
    const speedHz = parameters.speedHz ?? 0.25
    const ringCount = Math.round(parameters.ringCount ?? 3)
    const count = Math.min(6, Math.max(1, ringCount))
    const time = effectTimeSeconds(context)
    const radialPixelStep = context.ledCount <= 1
      ? 1
      : 2 / (context.ledCount - 1)
    const radialPixelOffset = context.ledCount % 2 === 0
      ? radialPixelStep / 2
      : 0
    const laneWidth = 1 / count
    const collisionGap = Math.min(radialPixelStep * 2, laneWidth * 0.5)
    const motion = Math.sin(TAU * speedHz * time)
    let brightness = 0

    for (let ringIndex = 0; ringIndex < count; ringIndex += 1) {
      const laneStart = ringIndex === 0
        ? 0
        : ringIndex * laneWidth + collisionGap / 2
      const laneEnd = ringIndex === count - 1
        ? 1
        : (ringIndex + 1) * laneWidth - collisionGap / 2
      const laneCenter = (laneStart + laneEnd) / 2
      const travel = (laneEnd - laneStart) / 2
      const direction = ringIndex % 2 === 0 ? 1 : -1
      const continuousCenter = laneCenter + direction * travel * motion
      const clampedCenter = Math.max(radialPixelOffset, clamp01(continuousCenter))
      const radialPosition =
        (clampedCenter - radialPixelOffset) / radialPixelStep
      const lowerBand = Math.floor(radialPosition)
      const upperBand = Math.ceil(radialPosition)
      const blend = radialPosition - lowerBand
      const lowerRadius = radialPixelOffset + lowerBand * radialPixelStep
      const upperRadius = radialPixelOffset + upperBand * radialPixelStep
      const tolerance = radialPixelStep * 1e-6

      if (Math.abs(context.normalizedRadius - lowerRadius) <= tolerance) {
        brightness = Math.max(brightness, 1 - blend)
      }
      if (Math.abs(context.normalizedRadius - upperRadius) <= tolerance) {
        brightness = Math.max(brightness, blend)
      }
    }

    if (brightness === 0) return BLACK

    return {
      r: brightness,
      g: brightness,
      b: brightness,
    }
  },
}
