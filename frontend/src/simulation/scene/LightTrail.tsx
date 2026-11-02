import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { WeatherState } from '../../backendApi'
import {
  createEffectContext,
  getEffectCompletion,
  ignoresWeatherTiming,
  presetForUnit,
  sampleEffect,
  withWeatherPalette,
  type EffectPreset,
  type RgbColor,
} from '../../effects'
import { moonCorrectionGains } from '../../hardware'
import {
  ARC_CLEARANCE,
  ARC_RADIUS,
  buildSemicircleLedPositions,
} from '../../preview3d/geometry'
import {
  buildUnitLayouts,
  buildTemporalSamples,
  controllerFrameAtTime,
  normalizedAngle,
  retimeRotor,
  rotorAngle,
  signedRpm,
  simulatedUnknownPhase,
  unitRelativeHeightAtPhase,
  type RotorSegment,
  type SceneMode,
  type SimulationSettings,
  type UnitMotor,
} from '../model'
import { layerUnitWeight, resolveSequenceFrame, type CompiledSequence, type SequenceFrame, type SequenceLayer } from '../sequence'
import { frontFacingBrightness } from './facing'
import { SimulatedSemicircleUnit } from './SimulatedSemicircleUnit'

type LedPoint = {
  position: readonly [number, number, number]
  normal: readonly [number, number, number]
  ledIndex: number
  arcIndex: number
}

function buildLedPoints(ledCount: number): LedPoint[] {
  const arcs = [
    buildSemicircleLedPositions(ARC_RADIUS, ledCount, 'xy', -ARC_CLEARANCE),
    buildSemicircleLedPositions(ARC_RADIUS, ledCount, 'zy', ARC_CLEARANCE),
  ]
  return arcs.flatMap((arc, arcIndex) => arc.map((position, ledIndex) => ({
    position,
    normal: arcIndex === 0
      ? [position[0] / ARC_RADIUS, position[1] / ARC_RADIUS, 0] as const
      : [0, position[1] / ARC_RADIUS, position[2] / ARC_RADIUS] as const,
    ledIndex,
    arcIndex,
  })))
}

const RUNNING: UnitMotor = { speed: 'max', direction: 'cw' }

type Diagnostics = {
  angleDegrees: number
  controllerFrame: number
  globalFrame: number
  cyclePhase: number
  simulationTime: number
  /** 選取那台目前的帶號轉速。 / The selected unit's current signed rpm. */
  rpm: number
}

type LightTrailProps = {
  settings: SimulationSettings
  weather: WeatherState | null
  effectPreset: EffectPreset
  sequence: CompiledSequence | null
  sequenceRevision: number
  paused: boolean
  resetToken: number
  sceneMode: SceneMode
  selectedUnit: number
  showStructure: boolean
  onSelectUnit: (unitIndex: number) => void
  onDiagnostics: (diagnostics: Diagnostics) => void
  syncFrame?: (() => number | null) | null
  /** Frame the clock jumps to on reset (resetToken or sequenceRevision change). */
  startFrame?: number
  /** 後端單色測試：每台一色或 null（照常）。 / Backend unit colour test: one color or null per unit. */
  unitColors?: (RgbColor | null)[] | null
  /** 每台的馬達狀態（依 unit index）；缺的視為全速順轉。 / Motor state per unit index; missing units run at max/cw. */
  motors: UnitMotor[]
  /** 全速時套用 LongN 月亮校正。 / Apply LongN moon correction at max speed. */
  moonCorrection: boolean
}

function playbackAt(
  sequence: CompiledSequence | null,
  preset: EffectPreset,
  globalFrame: number,
): SequenceFrame {
  if (sequence) return resolveSequenceFrame(sequence, globalFrame)!
  return {
    stepIndex: 0,
    complete: false,
    layers: [{
      preset, stepIndex: 0, localFrame: globalFrame, elapsedFrame: globalFrame,
      cycleFrames: null, sourceFrame: globalFrame, weight: 1,
    }],
  }
}

// 與後端 render_frame 相同：依段落週期循環後加上各台錯開。
// Mirrors backend render_frame: wrapped per step cycle, then shifted by the unit offset.
// 各燈台參數不同時，循環依該台自己的週期。 / With per-unit values, the wrap uses this unit's own cycle.
function layerControllerFrame(
  layer: SequenceLayer,
  preset: EffectPreset,
  fps: number,
  unitCount: number,
  frameOffset: number,
): number {
  const frame = layer.elapsedFrame
  const cycle = layer.cycleFrames === null || preset === layer.preset
    ? layer.cycleFrames
    : getEffectCompletion(preset, fps, unitCount)?.frames ?? layer.cycleFrames
  return (cycle === null ? frame : frame % cycle) + frameOffset
}


function playbackColor(
  frame: SequenceFrame,
  unitIndex: number,
  unitCount: number,
  sample: (layer: SequenceLayer, index: number) => RgbColor,
): RgbColor {
  const result = { r: 0, g: 0, b: 0 }
  for (const [index, layer] of frame.layers.entries()) {
    const weight = layerUnitWeight(layer, unitIndex, unitCount)
    if (weight <= 0) continue
    const color = sample(layer, index)
    result.r += color.r * weight
    result.g += color.g * weight
    result.b += color.b * weight
  }
  return result
}

export function LightTrail({
  settings,
  weather,
  effectPreset,
  sequence,
  sequenceRevision,
  paused,
  resetToken,
  sceneMode,
  selectedUnit,
  showStructure,
  onSelectUnit,
  onDiagnostics,
  syncFrame = null,
  startFrame = 0,
  unitColors = null,
  motors,
  moonCorrection,
}: LightTrailProps) {
  const rotorRefs = useRef<Array<THREE.Group | null>>([])
  const lightRefs = useRef<Array<THREE.InstancedMesh | null>>([])
  const glowRefs = useRef<Array<THREE.InstancedMesh | null>>([])
  const simulationTime = useRef(0)
  const diagnosticAccumulator = useRef(0)
  const color = useMemo(() => new THREE.Color(), [])
  const worldPosition = useMemo(() => new THREE.Vector3(), [])
  const worldNormal = useMemo(() => new THREE.Vector3(), [])
  const ledCount = settings.ledCount
  const ledPoints = useMemo(() => buildLedPoints(ledCount), [ledCount])
  const trailPoints = useMemo(
    () => ledPoints.filter(({ ledIndex }) => ledIndex % 4 === 0 || ledIndex === ledCount - 1),
    [ledPoints, ledCount],
  )
  const unitLayouts = useMemo(
    () => buildUnitLayouts(
      sceneMode,
      settings.unitCount,
      settings.unitPhaseStepDegrees,
      weather?.category ? weather.frameStep : settings.unitFrameOffsetStep,
    ),
    [sceneMode, settings.unitCount, settings.unitFrameOffsetStep, settings.unitPhaseStepDegrees, weather?.category, weather?.frameStep],
  )
  // 每台一段等速轉動；改變轉速時從當下角度接續。 / One constant-speed stretch per unit, continued from the current angle on a speed change.
  const rotors = useRef<RotorSegment[]>([])

  const pointCount =
    trailPoints.length * settings.temporalSamples * unitLayouts.length
  const geometry = useMemo(() => {
    const nextGeometry = new THREE.BufferGeometry()
    nextGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(pointCount * 3), 3),
    )
    nextGeometry.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array(pointCount * 3), 3),
    )
    nextGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 3, 0), 20)
    return nextGeometry
  }, [pointCount])

  const weatherPreset = useMemo(() => {
    const cache = new WeakMap<EffectPreset, EffectPreset>()
    return (preset: EffectPreset): EffectPreset => {
      if (!weather?.color || !weather.category || preset.color.weatherPalette === false) return preset
      const cached = cache.get(preset)
      if (cached) return cached
      const colored = withWeatherPalette(preset, weather.color)
      cache.set(preset, colored)
      return colored
    }
  }, [weather?.color, weather?.category])

  const unknownPhases = useMemo(
    () => unitLayouts.map((unit) => simulatedUnknownPhase(unit.index, resetToken)),
    [resetToken, unitLayouts],
  )
  useEffect(() => () => geometry.dispose(), [geometry])
  // 重設時從指定影格開始（預設 0）。 / A reset starts from the given frame (0 by default).
  useEffect(() => {
    // 加一點點避免浮點誤差讓 floor 落到前一格。 / A hair over so flooring never lands on the previous frame.
    simulationTime.current = startFrame ? (startFrame + 1e-6) / settings.controllerFps : 0
  }, [resetToken, sequenceRevision])
  // 重設或換排列時轉子回到各自的起始角。 / Rotors restart from their initial angles on reset or a layout change.
  useEffect(() => {
    rotors.current = unitLayouts.map((unit) => ({ time: 0, angle: unit.phaseOffsetRadians, rpm: 0 }))
  }, [resetToken, unitLayouts])

  useFrame(({ camera }, delta) => {
    if (!paused) simulationTime.current += Math.min(delta, 0.1)
    // 跟隨後端時，差超過兩格就對齊後端影格；小誤差照本地時鐘走，避免抖動。
    // When following the backend, snap to its frame once off by more than two frames; small drift runs on the local clock.
    const liveFrame = paused ? null : syncFrame?.() ?? null
    if (liveFrame !== null) {
      const liveTime = liveFrame / settings.controllerFps
      if (Math.abs(simulationTime.current - liveTime) > 2 / settings.controllerFps) simulationTime.current = liveTime
    }
    const now = simulationTime.current
    const samples = buildTemporalSamples(
      now,
      settings.exposureMs,
      settings.persistenceMs,
      settings.temporalSamples,
    )
    const positions = geometry.attributes.position.array as Float32Array
    const colors = geometry.attributes.color.array as Float32Array
    let cursor = 0
    const fps = settings.controllerFps
    // 後端的相位估計在每個輸出影格開始時取樣。 / The backend estimates phase at the start of each output frame.
    const heldPhase = (rotor: RotorSegment, unknownPhase: number, globalFrame: number) => {
      const angle = rotorAngle(rotor, globalFrame / fps) + unknownPhase
      return { cosine: Math.cos(angle), sine: Math.sin(angle) }
    }

    for (const unit of unitLayouts) {
      const motor = motors[unit.index] ?? RUNNING
      const rotor = retimeRotor(
        rotors.current[unit.index] ?? { time: 0, angle: unit.phaseOffsetRadians, rpm: 0 },
        now,
        signedRpm(motor, settings.motorRpm),
      )
      rotors.current[unit.index] = rotor
      const gains = moonCorrectionGains(ledCount, moonCorrection, motor.speed)
      const corrected = (effectColor: RgbColor, ledIndex: number): RgbColor => {
        if (gains === null) return effectColor
        const gain = gains[ledIndex]
        return { r: effectColor.r * gain, g: effectColor.g * gain, b: effectColor.b * gain }
      }
      const raining = weather?.category === 'rain'
      const unitPreset = (layer: SequenceLayer) => presetForUnit(layer.preset, unit.index, unitLayouts.length)
      // 共用時間表的效果不套用各台錯開。 / Shared-schedule effects skip unit offsets.
      const layerFrame = (layer: SequenceLayer) => layerControllerFrame(
        layer, unitPreset(layer), settings.controllerFps, unitLayouts.length,
        ignoresWeatherTiming(layer.preset.effectId) ? 0 : unit.frameOffset,
      )
      const sampleWeatherEffect = (
        layer: SequenceLayer,
        context: ReturnType<typeof createEffectContext>,
      ): RgbColor => sampleEffect(weatherPreset(unitPreset(layer)), context, layer.elapsedFrame, raining)
      const testColor = unitColors?.[unit.index] ?? null
      const tiltCosine = Math.cos(unit.tiltXRadians)
      const tiltSine = Math.sin(unit.tiltXRadians)
      const yawCosine = Math.cos(unit.yawRadians)
      const yawSine = Math.sin(unit.yawRadians)
      const unknownPhase = unknownPhases[unit.index]

      for (const sample of samples) {
        const angle = rotorAngle(rotor, sample.timeSeconds)
        const cosine = Math.cos(angle)
        const sine = Math.sin(angle)
        const globalFrame = controllerFrameAtTime(sample.timeSeconds, fps)
        const playback = playbackAt(sequence, effectPreset, globalFrame)
        const held = heldPhase(rotor, unknownPhase, globalFrame)

        for (const { position, normal, ledIndex, arcIndex } of trailPoints) {
          const [x, y, z] = position
          const rotatedX = cosine * x + sine * z
          const rotatedZ = -sine * x + cosine * z
          const tiltedZ = tiltSine * y + tiltCosine * rotatedZ
          positions[cursor] = unit.x + unit.scale * (
            yawCosine * rotatedX + yawSine * tiltedZ
          )
          positions[cursor + 1] = unit.y + unit.scale * (
            tiltCosine * y - tiltSine * rotatedZ
          )
          positions[cursor + 2] = unit.z + unit.scale * (
            -yawSine * rotatedX + yawCosine * tiltedZ
          )

          const [normalX, normalY, normalZ] = normal
          const rotatedNormalX = cosine * normalX + sine * normalZ
          const rotatedNormalZ = -sine * normalX + cosine * normalZ
          const tiltedNormalZ =
            tiltSine * normalY + tiltCosine * rotatedNormalZ
          const facing = frontFacingBrightness(
            yawCosine * rotatedNormalX + yawSine * tiltedNormalZ,
            tiltCosine * normalY - tiltSine * rotatedNormalZ,
            -yawSine * rotatedNormalX + yawCosine * tiltedNormalZ,
            positions[cursor],
            positions[cursor + 1],
            positions[cursor + 2],
            camera.position.x,
            camera.position.y,
            camera.position.z,
          )
          if (facing === 0) {
            colors[cursor] = 0
            colors[cursor + 1] = 0
            colors[cursor + 2] = 0
            cursor += 3
            continue
          }

          const effectColor = corrected(testColor ?? playbackColor(playback, unit.index, unitLayouts.length, (layer) => sampleWeatherEffect(
            layer,
            createEffectContext(
              layerFrame(layer),
              fps,
              ledIndex,
              ledCount,
              unit.index,
              unitLayouts.length,
              layer.localFrame,
              layer.preset.effectId === 'world-upper-half'
                ? unitRelativeHeightAtPhase(position, held.cosine, held.sine, tiltCosine, tiltSine, unit.scale)
                : positions[cursor + 1] - unit.y,
              arcIndex === 0 ? -held.sine : held.cosine,
            ),
          )), ledIndex)
          color.setRGB(
            effectColor.r,
            effectColor.g,
            effectColor.b,
            THREE.SRGBColorSpace,
          )
          const energy = sample.weight * samples.length * 0.25 * facing
          colors[cursor] = color.r * energy
          colors[cursor + 1] = color.g * energy
          colors[cursor + 2] = color.b * energy
          cursor += 3
        }
      }

      const rotorNode = rotorRefs.current[unit.index]
      if (rotorNode) rotorNode.rotation.y = normalizedAngle(rotorAngle(rotor, now))

      const lights = lightRefs.current[unit.index]
      const glow = glowRefs.current[unit.index]
      if (rotorNode && lights && glow) {
        rotorNode.updateWorldMatrix(true, false)
        const globalFrame = controllerFrameAtTime(now, fps)
        const playback = playbackAt(sequence, effectPreset, globalFrame)
        const held = heldPhase(rotor, unknownPhase, globalFrame)
        for (let ledIndex = 0; ledIndex < ledCount; ledIndex += 1) {
          for (let arcIndex = 0; arcIndex < 2; arcIndex += 1) {
            const instanceIndex = arcIndex * ledCount + ledIndex
            const { position, normal } = ledPoints[instanceIndex]
            worldPosition.set(...position).applyMatrix4(rotorNode.matrixWorld)
            const effectColor = corrected(testColor ?? playbackColor(playback, unit.index, unitLayouts.length, (layer) => sampleWeatherEffect(
              layer,
              createEffectContext(
                layerFrame(layer),
                fps,
                ledIndex,
                ledCount,
                unit.index,
                unitLayouts.length,
                layer.localFrame,
                layer.preset.effectId === 'world-upper-half'
                  ? unitRelativeHeightAtPhase(position, held.cosine, held.sine, tiltCosine, tiltSine, unit.scale)
                  : worldPosition.y - unit.y,
                arcIndex === 0 ? -held.sine : held.cosine,
              ),
            )), ledIndex)
            worldNormal.set(normal[0], normal[1], normal[2])
              .transformDirection(rotorNode.matrixWorld)
            const facing = frontFacingBrightness(
              worldNormal.x,
              worldNormal.y,
              worldNormal.z,
              worldPosition.x,
              worldPosition.y,
              worldPosition.z,
              camera.position.x,
              camera.position.y,
              camera.position.z,
            )
            color.setRGB(
              effectColor.r * facing,
              effectColor.g * facing,
              effectColor.b * facing,
              THREE.SRGBColorSpace,
            )
            lights.setColorAt(instanceIndex, color)
            glow.setColorAt(instanceIndex, color)
          }
        }
        if (lights.instanceColor) lights.instanceColor.needsUpdate = true
        if (glow.instanceColor) glow.instanceColor.needsUpdate = true
      }
    }

    geometry.attributes.position.needsUpdate = true
    geometry.attributes.color.needsUpdate = true
    geometry.setDrawRange(0, cursor / 3)

    diagnosticAccumulator.current += delta
    if (diagnosticAccumulator.current >= 0.1) {
      const selectedLayout = unitLayouts.find(
        (unit) => unit.index === selectedUnit,
      ) ?? unitLayouts[0]
      const selectedRotor = rotors.current[selectedLayout.index]
      const frame = controllerFrameAtTime(
        now,
        fps,
        selectedLayout.frameOffset / fps,
      )
      onDiagnostics({
        angleDegrees: selectedRotor ? (normalizedAngle(rotorAngle(selectedRotor, now)) * 180) / Math.PI : 0,
        controllerFrame: frame,
        globalFrame: controllerFrameAtTime(now, fps),
        cyclePhase: frame % 20,
        simulationTime: now,
        rpm: selectedRotor?.rpm ?? 0,
      })
      diagnosticAccumulator.current = 0
    }
  })

  return (
    <>
      <points geometry={geometry}>
        <pointsMaterial
          vertexColors
          transparent
          opacity={0.45}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          size={sceneMode === 'all' ? 1.6 : 2.2}
          sizeAttenuation={false}
          toneMapped={false}
        />
      </points>
      {unitLayouts.map((unit) => (
        <SimulatedSemicircleUnit
          key={`${unit.index}-${ledCount}`}
          unit={unit}
          ledCount={ledCount}
          sceneMode={sceneMode}
          selected={unit.index === selectedUnit}
          showStructure={showStructure}
          onSelectUnit={onSelectUnit}
          onRotor={(node) => { rotorRefs.current[unit.index] = node }}
          onLights={(node) => { lightRefs.current[unit.index] = node }}
          onGlow={(node) => { glowRefs.current[unit.index] = node }}
        />
      ))}
    </>
  )
}

export type { Diagnostics }
