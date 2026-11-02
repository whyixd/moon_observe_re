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
import {
  ARC_CLEARANCE,
  ARC_RADIUS,
  buildSemicircleLedPositions,
  LEDS_PER_ARC,
} from '../../preview3d/geometry'
import {
  angleAtTime,
  buildUnitLayouts,
  buildTemporalSamples,
  controllerFrameAtTime,
  normalizedAngle,
  simulatedUnknownPhase,
  unitRelativeHeightAtPhase,
  type SceneMode,
  type SimulationSettings,
} from '../model'
import { layerUnitWeight, resolveSequenceFrame, type CompiledSequence, type SequenceFrame, type SequenceLayer } from '../sequence'
import { frontFacingBrightness } from './facing'
import { SimulatedSemicircleUnit } from './SimulatedSemicircleUnit'

const ARC_POSITIONS = [
  buildSemicircleLedPositions(ARC_RADIUS, LEDS_PER_ARC, 'xy', -ARC_CLEARANCE),
  buildSemicircleLedPositions(ARC_RADIUS, LEDS_PER_ARC, 'zy', ARC_CLEARANCE),
]
const LED_POINTS = ARC_POSITIONS.flatMap((arc, arcIndex) =>
  arc.map((position, ledIndex) => ({
    position,
    normal: arcIndex === 0
      ? [position[0] / ARC_RADIUS, position[1] / ARC_RADIUS, 0]
      : [0, position[1] / ARC_RADIUS, position[2] / ARC_RADIUS],
    ledIndex,
    arcIndex,
  })),
)
const TRAIL_POINTS = LED_POINTS.filter(
  ({ ledIndex }) => ledIndex % 4 === 0 || ledIndex === LEDS_PER_ARC - 1,
)

type Diagnostics = {
  angleDegrees: number
  controllerFrame: number
  globalFrame: number
  cyclePhase: number
  simulationTime: number
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
}: LightTrailProps) {
  const rotorRefs = useRef<Array<THREE.Group | null>>([])
  const lightRefs = useRef<Array<THREE.InstancedMesh | null>>([])
  const glowRefs = useRef<Array<THREE.InstancedMesh | null>>([])
  const simulationTime = useRef(0)
  const diagnosticAccumulator = useRef(0)
  const color = useMemo(() => new THREE.Color(), [])
  const worldPosition = useMemo(() => new THREE.Vector3(), [])
  const worldNormal = useMemo(() => new THREE.Vector3(), [])
  const unitLayouts = useMemo(
    () => buildUnitLayouts(
      sceneMode,
      settings.unitPhaseStepDegrees,
      weather?.category ? weather.frameStep : settings.unitFrameOffsetStep,
    ),
    [sceneMode, settings.unitFrameOffsetStep, settings.unitPhaseStepDegrees, weather?.category, weather?.frameStep],
  )

  const pointCount =
    TRAIL_POINTS.length * settings.temporalSamples * unitLayouts.length
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
    nextGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 9)
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
    () => Array.from({ length: 9 }, (_, index) => simulatedUnknownPhase(index, resetToken)),
    [resetToken],
  )
  useEffect(() => () => geometry.dispose(), [geometry])
  // 重設時從指定影格開始（預設 0）。 / A reset starts from the given frame (0 by default).
  useEffect(() => {
    // 加一點點避免浮點誤差讓 floor 落到前一格。 / A hair over so flooring never lands on the previous frame.
    simulationTime.current = startFrame ? (startFrame + 1e-6) / settings.controllerFps : 0
  }, [resetToken, sequenceRevision])

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

    for (const unit of unitLayouts) {
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
      const estimatedPhase = unit.phaseOffsetRadians + unknownPhases[unit.index]

      for (const sample of samples) {
        const angle = angleAtTime(
          sample.timeSeconds,
          settings.rpm,
          unit.phaseOffsetRadians,
        )
        const cosine = Math.cos(angle)
        const sine = Math.sin(angle)
        const globalFrame = controllerFrameAtTime(
          sample.timeSeconds,
          settings.controllerFps,
        )
        const playback = playbackAt(sequence, effectPreset, globalFrame)
        const heldPhases = playback.layers.map((layer) => {
          const heldAngle = angleAtTime(
            layer.sourceFrame / settings.controllerFps,
            settings.rpm,
            estimatedPhase,
          )
          return { cosine: Math.cos(heldAngle), sine: Math.sin(heldAngle) }
        })

        for (const { position, normal, ledIndex, arcIndex } of TRAIL_POINTS) {
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
          positions[cursor + 2] = unit.scale * (
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

          const effectColor = testColor ?? playbackColor(playback, unit.index, unitLayouts.length, (layer, layerIndex) => sampleWeatherEffect(
            layer,
            createEffectContext(
              layerFrame(layer),
              settings.controllerFps,
              ledIndex,
              LEDS_PER_ARC,
              unit.index,
              unitLayouts.length,
              layer.localFrame,
              layer.preset.effectId === 'world-upper-half'
                ? unitRelativeHeightAtPhase(
                  position, heldPhases[layerIndex].cosine, heldPhases[layerIndex].sine,
                  tiltCosine, tiltSine, unit.scale,
                )
                : positions[cursor + 1] - unit.y,
              arcIndex === 0 ? -heldPhases[layerIndex].sine : heldPhases[layerIndex].cosine,
            ),
          ))
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

      const rotor = rotorRefs.current[unit.index]
      if (rotor) {
        rotor.rotation.y = normalizedAngle(
          angleAtTime(now, settings.rpm, unit.phaseOffsetRadians),
        )
      }

      const lights = lightRefs.current[unit.index]
      const glow = glowRefs.current[unit.index]
      if (rotor && lights && glow) {
        rotor.updateWorldMatrix(true, false)
        const globalFrame = controllerFrameAtTime(now, settings.controllerFps)
        const playback = playbackAt(sequence, effectPreset, globalFrame)
        const heldPhases = playback.layers.map((layer) => {
          const heldAngle = angleAtTime(
            layer.sourceFrame / settings.controllerFps,
            settings.rpm,
            estimatedPhase,
          )
          return { cosine: Math.cos(heldAngle), sine: Math.sin(heldAngle) }
        })
        for (let ledIndex = 0; ledIndex < LEDS_PER_ARC; ledIndex += 1) {
          for (let arcIndex = 0; arcIndex < ARC_POSITIONS.length; arcIndex += 1) {
            const instanceIndex = arcIndex * LEDS_PER_ARC + ledIndex
            const { position, normal } = LED_POINTS[instanceIndex]
            worldPosition.set(...position).applyMatrix4(rotor.matrixWorld)
            const effectColor = testColor ?? playbackColor(playback, unit.index, unitLayouts.length, (layer, layerIndex) => sampleWeatherEffect(
              layer,
              createEffectContext(
                layerFrame(layer),
                settings.controllerFps,
                ledIndex,
                LEDS_PER_ARC,
                unit.index,
                unitLayouts.length,
                layer.localFrame,
                layer.preset.effectId === 'world-upper-half'
                  ? unitRelativeHeightAtPhase(
                    position, heldPhases[layerIndex].cosine, heldPhases[layerIndex].sine,
                    tiltCosine, tiltSine, unit.scale,
                  )
                  : worldPosition.y - unit.y,
                arcIndex === 0 ? -heldPhases[layerIndex].sine : heldPhases[layerIndex].cosine,
              ),
            ))
            worldNormal.set(normal[0], normal[1], normal[2])
              .transformDirection(rotor.matrixWorld)
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
      const frame = controllerFrameAtTime(
        now,
        settings.controllerFps,
        selectedLayout.frameOffset / settings.controllerFps,
      )
      onDiagnostics({
        angleDegrees:
          (normalizedAngle(angleAtTime(
            now,
            settings.rpm,
            selectedLayout.phaseOffsetRadians,
          )) * 180) / Math.PI,
        controllerFrame: frame,
        globalFrame: controllerFrameAtTime(now, settings.controllerFps),
        cyclePhase: frame % 20,
        simulationTime: now,
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
          size={sceneMode === 'nine' ? 1.6 : 2.2}
          sizeAttenuation={false}
          toneMapped={false}
        />
      </points>
      {unitLayouts.map((unit) => (
        <SimulatedSemicircleUnit
          key={unit.index}
          unit={unit}
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
