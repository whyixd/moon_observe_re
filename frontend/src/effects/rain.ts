import { clamp01, type EffectSampleContext } from './contract'
import { hash01 } from './rouletteRing'

// 雨天線條化的固定常數，與後端 RAIN_LINES 一致。 / Fixed rain-line constants; match backend RAIN_LINES.
export const RAIN_LINES = { stripeSpacing: 6, streakFrames: 2, sparseDensity: 0.18, denseDensity: 0.45 }

// 條紋：由外圈往圓心每 6 顆亮 1 顆，兩側對稱，旋轉後是一圈圈同心細環。
// Stripes: one LED in every 6 from the rim inward, mirrored on both sides, so it spins into concentric thin rings.
export function rainStripe(context: EffectSampleContext): number {
  const step = Math.round((1 - context.normalizedRadius) * (context.ledCount - 1) / 2)
  return step % RAIN_LINES.stripeSpacing === 0 ? 1 : 0
}

// 細環：環心半顆 LED 內全亮，往外一顆內線性變暗；總亮度固定為兩顆，移動時不跳格也不忽明忽暗。
// Thin ring: full within half an LED of the ring, fading over the next LED; total energy stays two LEDs, so it
// moves smoothly without pulsing.
export function rainRing(radialDistance: number, ledCount: number): number {
  const pixel = ledCount <= 1 ? 1 : 2 / (ledCount - 1)
  return clamp01(1.5 - Math.abs(radialDistance) / pixel)
}

// 雨絲：每顆 LED 每 2 影格依機率亮一次，旋轉時畫出短弧。 / Streaks: each LED lights per 2-frame cell by chance, drawing short arcs.
export function rainStreak(context: EffectSampleContext, density: number): number {
  if (density <= 0) return 0
  const cell = Math.floor(Math.max(0, context.controllerFrame) / RAIN_LINES.streakFrames)
  return hash01(cell, context.unitIndex, context.ledIndex + 101) < density ? 1 : 0
}
