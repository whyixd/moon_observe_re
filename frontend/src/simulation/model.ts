import { ARC_RADIUS, LEDS_PER_ARC, type Point3 } from '../preview3d/geometry'

export const TAU = Math.PI * 2

export type MotorSpeed = 'stop' | 'mid' | 'max'
export type MotorDirection = 'cw' | 'ccw'
export type UnitMotor = { speed: MotorSpeed; direction: MotorDirection }
/** 中速與全速的標稱轉速；只用於模擬與相位估計。 / Nominal rpm per speed level, for simulation and phase estimates only. */
export type MotorRpm = { mid: number; max: number }

export const MOTOR_SPEEDS: readonly MotorSpeed[] = ['stop', 'mid', 'max']
export const MOTOR_DIRECTIONS: readonly MotorDirection[] = ['cw', 'ccw']
export const DEFAULT_MOTOR_RPM: MotorRpm = { mid: 130, max: 500 }
export const DEFAULT_UNIT_COUNT = 5

/** 帶正負號的轉速：停止為 0，逆轉為負（與後端相位估計相同）。 / Signed rpm: 0 when stopped, negative for ccw (as the backend estimate). */
export function signedRpm(motor: UnitMotor, rpm: MotorRpm): number {
  if (motor.speed === 'stop') return 0
  return rpm[motor.speed] * (motor.direction === 'cw' ? 1 : -1)
}

/** 本地套用馬達命令，規則與後端 /api/motor 相同：省略 unitIds 為全部，沒給的欄位不變。
 * Apply a motor command locally with the backend's /api/motor rules (no unitIds = all; omitted fields stay). */
export function applyMotorCommand(
  motors: UnitMotor[],
  command: { unitIds?: number[]; speed?: MotorSpeed; direction?: MotorDirection },
): UnitMotor[] {
  const targets = new Set(command.unitIds ?? motors.map((_, index) => index + 1))
  return motors.map((motor, index) => targets.has(index + 1)
    ? { speed: command.speed ?? motor.speed, direction: command.direction ?? motor.direction }
    : motor)
}

export type SimulationSettings = {
  motorRpm: MotorRpm
  controllerFps: number
  exposureMs: number
  persistenceMs: number
  temporalSamples: number
  ledCount: number
  unitCount: number
  unitPhaseStepDegrees: number
  unitFrameOffsetStep: number
}

export type SceneMode = 'single' | 'all'

export type UnitLayout = {
  index: number
  x: number
  y: number
  z: number
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
  motorRpm: DEFAULT_MOTOR_RPM,
  controllerFps: 40,
  exposureMs: 25,
  persistenceMs: 45,
  temporalSamples: 64,
  ledCount: LEDS_PER_ARC,
  unitCount: DEFAULT_UNIT_COUNT,
  unitPhaseStepDegrees: 40,
  unitFrameOffsetStep: 2,
}

// LongN/Simulation.pde 的常數（Processing 單位）。 / Constants from LongN/Simulation.pde (Processing units).
const LONGN = { lowest: 200, highest: 700, ledRadius: 35, zOffset: -160 } as const
export const ALL_UNIT_SCALE = 0.18
// 讓半圓半徑對應 LongN 的 LED_RADIUS。 / Maps LongN's LED_RADIUS onto the arc radius.
const LONGN_TO_WORLD = (ARC_RADIUS * ALL_UNIT_SCALE) / LONGN.ledRadius

/**
 * LongN calcMotorPosition() for any unit count, in Processing world units: X right, Y toward the
 * viewer, Z up (LongN's initial camera is rotateX(PI/2)). `angle` is LongN's rotateZ, which turns each
 * unit's spin axis (the arc apex) within the floor plane. 需要現場確認。 / To be confirmed on site.
 */
export function longnUnitPlacement(index: number, count: number) {
  const middle = (LONGN.lowest + LONGN.highest) / 2
  const radius = (LONGN.highest - LONGN.lowest) / 2
  const depth = LONGN.highest - LONGN.lowest
  const step = Math.PI / (count + 1)
  const span = LONGN.ledRadius * 17
  return {
    x: count <= 1 ? 0 : -span + (2 * span * index) / (count - 1),
    y: -depth * Math.sin((index + 1) * step) + depth / 3,
    z: middle + radius * Math.cos((index + 1) * step + Math.PI) + LONGN.zOffset,
    angle: (count <= 1 ? 0 : (index * (Math.PI * 3) / 2) / (count - 1)) + Math.PI / 2,
  }
}

export function buildUnitLayouts(
  sceneMode: SceneMode,
  unitCount: number,
  phaseStepDegrees: number,
  frameOffsetStep: number,
): UnitLayout[] {
  if (sceneMode === 'single') {
    return [{
      index: 0,
      x: 0,
      y: 0,
      z: 0,
      scale: 1,
      phaseOffsetRadians: 0,
      tiltXRadians: Math.PI / 2,
      yawRadians: 0,
      frameOffset: 0,
    }]
  }

  const count = Math.max(1, Math.floor(unitCount))
  const placements = Array.from({ length: count }, (_, index) => longnUnitPlacement(index, count))
  // 最低的一台坐在 y = 0，前後方向置中。 / The lowest unit sits at y = 0; depth is centered.
  const lowest = Math.min(...placements.map((placement) => placement.z))
  const meanDepth = placements.reduce((sum, placement) => sum + placement.y, 0) / count

  return placements.map((placement, index) => ({
    index,
    // Processing (X, Y toward viewer, Z up) → three.js (x, y up, z toward viewer).
    x: placement.x * LONGN_TO_WORLD,
    y: (placement.z - lowest) * LONGN_TO_WORLD,
    z: (placement.y - meanDepth) * LONGN_TO_WORLD,
    scale: ALL_UNIT_SCALE,
    phaseOffsetRadians: (index * phaseStepDegrees * Math.PI) / 180,
    tiltXRadians: Math.PI / 2,
    // 頂點朝向 (-sin a, 0, cos a)；rotation-y = ψ 把 +z 轉到 (sin ψ, 0, cos ψ)。
    // Apex points to (-sin a, 0, cos a); rotation-y = ψ turns +z to (sin ψ, 0, cos ψ).
    yawRadians: -placement.angle,
    frameOffset: index * frameOffsetStep,
  }))
}

/** One constant-speed stretch of a rotor; the angle extrapolates from (time, angle) at signed rpm. */
export type RotorSegment = { time: number; angle: number; rpm: number }

export function rotorAngle(segment: RotorSegment, timeSeconds: number): number {
  return segment.angle + (timeSeconds - segment.time) * rotationsPerSecond(segment.rpm) * TAU
}

/** Keeps the angle continuous when the speed changes at `timeSeconds`. */
export function retimeRotor(segment: RotorSegment, timeSeconds: number, rpm: number): RotorSegment {
  if (segment.rpm === rpm) return segment
  return { time: timeSeconds, angle: rotorAngle(segment, timeSeconds), rpm }
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
