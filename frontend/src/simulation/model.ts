import { LEDS_PER_ARC, type Point3 } from '../preview3d/geometry'

export const TAU = Math.PI * 2

export type SimulationSettings = {
  rpm: number
  controllerFps: number
  exposureMs: number
  persistenceMs: number
  temporalSamples: number
  ledCount: number
  unitPhaseStepDegrees: number
  unitFrameOffsetStep: number
}

export type SceneMode = 'single' | 'nine'

export const NINE_UNIT_SPACING = 2.912
// Unit 5 sits this high above Units 1/9; the row follows a circular arc.
export const NINE_UNIT_ARCH_HEIGHT = 4.8

export type UnitLayout = {
  index: number
  x: number
  y: number
  scale: number
  phaseOffsetRadians: number
  tiltXRadians: number
  yawRadians: number
  frameOffset: number
}

export type TemporalSample = {
  timeSeconds: number
  weight: number
}

export const DEFAULT_SETTINGS: SimulationSettings = {
  rpm: 360,
  controllerFps: 40,
  exposureMs: 25,
  persistenceMs: 45,
  temporalSamples: 64,
  ledCount: LEDS_PER_ARC,
  unitPhaseStepDegrees: 40,
  unitFrameOffsetStep: 2,
}

export function buildUnitLayouts(
  sceneMode: SceneMode,
  phaseStepDegrees: number,
  frameOffsetStep: number,
): UnitLayout[] {
  if (sceneMode === 'single') {
    return [{
      index: 0,
      x: 0,
      y: 0,
      scale: 1,
      phaseOffsetRadians: 0,
      tiltXRadians: Math.PI / 2,
      yawRadians: 0,
      frameOffset: 0,
    }]
  }

  const unitScale = 0.18
  const halfWidth = 4 * NINE_UNIT_SPACING
  const archRadius = (halfWidth ** 2 + NINE_UNIT_ARCH_HEIGHT ** 2) / (2 * NINE_UNIT_ARCH_HEIGHT)

  return Array.from({ length: 9 }, (_, index) => ({
    index,
    x: (index - 4) * NINE_UNIT_SPACING,
    y: nineUnitArchY((index - 4) * NINE_UNIT_SPACING, archRadius),
    scale: unitScale,
    phaseOffsetRadians: (index * phaseStepDegrees * Math.PI) / 180,
    tiltXRadians: Math.PI / 2,
    yawRadians: (4 - index) * Math.PI / 4,
    frameOffset: index * frameOffsetStep,
  }))
}

function nineUnitArchY(x: number, archRadius: number): number {
  return Math.sqrt(archRadius ** 2 - x ** 2) - (archRadius - NINE_UNIT_ARCH_HEIGHT)
}

export function rotationsPerSecond(rpm: number): number {
  return rpm / 60
}

export function angleAtTime(
  timeSeconds: number,
  rpm: number,
  initialPhase = 0,
): number {
  return initialPhase + timeSeconds * rotationsPerSecond(rpm) * TAU
}

export function normalizedAngle(angle: number): number {
  return ((angle % TAU) + TAU) % TAU
}

export function controllerFrameAtTime(
  timeSeconds: number,
  fps: number,
  offsetSeconds = 0,
): number {
  if (fps <= 0) return 0
  return Math.max(0, Math.floor((timeSeconds + offsetSeconds) * fps))
}

export function degreesPerControllerFrame(rpm: number, fps: number): number {
  if (fps <= 0) return 0
  return (rpm * 6) / fps
}

export function controllerFrameStartTime(
  frame: number,
  fps: number,
  frameOffset = 0,
): number {
  if (fps <= 0) return 0
  return Math.max(0, (frame - frameOffset) / fps)
}

export function simulatedUnknownPhase(unitIndex: number, resetToken: number): number {
  const hash = (
    Math.imul(unitIndex + 1, 0x9e3779b1) ^
    Math.imul(resetToken + 1, 0x85ebca6b)
  ) >>> 0
  return (hash / 0x100000000) * TAU
}

export function unitRelativeHeightAtPhase(
  position: Point3,
  phaseCosine: number,
  phaseSine: number,
  tiltCosine: number,
  tiltSine: number,
  scale: number,
): number {
  const rotatedZ = -phaseSine * position[0] + phaseCosine * position[2]
  return scale * (tiltCosine * position[1] - tiltSine * rotatedZ)
}

export function stripCoordinate(
  ledIndex: number,
  ledCount: number,
  halfLength: number,
): number {
  if (ledCount <= 1) return 0
  return -halfLength + (ledIndex / (ledCount - 1)) * halfLength * 2
}

export function buildTemporalSamples(
  nowSeconds: number,
  exposureMs: number,
  persistenceMs: number,
  sampleCount: number,
): TemporalSample[] {
  const count = Math.max(1, Math.floor(sampleCount))
  const exposureSeconds = Math.max(0, exposureMs) / 1000
  const persistenceSeconds = Math.max(0, persistenceMs) / 1000
  const historySeconds = exposureSeconds + persistenceSeconds * 4

  if (historySeconds === 0 || count === 1) {
    return [{ timeSeconds: nowSeconds, weight: 1 }]
  }

  const samples = Array.from({ length: count }, (_, index) => {
    const age = historySeconds * (index / (count - 1))
    const persistenceAge = Math.max(0, age - exposureSeconds)
    const weight =
      persistenceAge === 0
        ? 1
        : Math.exp(-persistenceAge / Math.max(persistenceSeconds, 1e-6))

    return {
      timeSeconds: nowSeconds - age,
      weight,
    }
  })

  const weightSum = samples.reduce((sum, sample) => sum + sample.weight, 0)
  return samples.map((sample) => ({
    ...sample,
    weight: sample.weight / weightSum,
  }))
}
