export type SemicirclePlane = 'xy' | 'zy'

export type Point3 = readonly [x: number, y: number, z: number]

export const LEDS_PER_ARC = 156
export const ARC_RADIUS = 2.5
export const ARC_CLEARANCE = 0.035

export function semicirclePoint(
  radius: number,
  progress: number,
  plane: SemicirclePlane,
  normalOffset = 0,
): Point3 {
  const angle = Math.PI * Math.min(1, Math.max(0, progress))
  const across = -Math.cos(angle) * radius
  const height = Math.sin(angle) * radius

  return plane === 'xy'
    ? [across, height, normalOffset]
    : [normalOffset, height, across]
}

export function buildSemicircleLedPositions(
  radius: number,
  count: number,
  plane: SemicirclePlane,
  normalOffset = 0,
): Point3[] {
  const safeCount = Math.max(1, Math.floor(count))

  return Array.from({ length: safeCount }, (_, index) => {
    const progress = safeCount === 1 ? 0.5 : index / (safeCount - 1)
    return semicirclePoint(radius, progress, plane, normalOffset)
  })
}
