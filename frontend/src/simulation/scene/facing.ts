const FRONT_FADE_COSINE = 0.2

export function frontFacingBrightness(
  normalX: number,
  normalY: number,
  normalZ: number,
  pointX: number,
  pointY: number,
  pointZ: number,
  cameraX: number,
  cameraY: number,
  cameraZ: number,
): number {
  const viewX = cameraX - pointX
  const viewY = cameraY - pointY
  const viewZ = cameraZ - pointZ
  const distance = Math.hypot(viewX, viewY, viewZ)
  if (distance === 0) return 0

  const cosine = (
    normalX * viewX + normalY * viewY + normalZ * viewZ
  ) / distance
  return Math.max(0, Math.min(1, cosine / FRONT_FADE_COSINE))
}
