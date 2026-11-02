import type { EffectParameterDefinition, UnitVariation, UnitVariationDistribution } from './contract'
import { unitPalettePosition } from './randomFill'

// 各燈台在起訖值之間的位置（0–1）：依序、跳著排（同隨機填滿）、或固定種子隨機。
// Position (0..1) of a unit between from and to: in order, skipping (as random-fill), or fixed-seed random.
export function unitVariationPosition(
  distribution: UnitVariationDistribution,
  unitIndex: number,
  unitCount: number,
): number {
  if (unitCount <= 1) return 0
  if (distribution === 'skip') return unitPalettePosition(unitIndex, unitCount)
  if (distribution === 'random') {
    let state = (Math.imul(unitIndex + 1, 0x9e3779b1) ^ 0x85ebca6b) >>> 0
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
  return unitIndex / (unitCount - 1)
}

// 數值對齊參數的刻度並夾在允許範圍內。 / The value snaps to the parameter's step and stays within its range.
export function unitVariationValue(
  definition: EffectParameterDefinition,
  variation: UnitVariation,
  unitIndex: number,
  unitCount: number,
): number {
  const position = unitVariationPosition(variation.distribution, unitIndex, unitCount)
  const raw = variation.from + (variation.to - variation.from) * position
  const snapped = definition.min + Math.round((raw - definition.min) / definition.step) * definition.step
  return Math.min(definition.max, Math.max(definition.min, Number(snapped.toFixed(6))))
}
