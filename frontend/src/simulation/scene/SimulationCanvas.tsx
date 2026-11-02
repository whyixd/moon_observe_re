import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { OrbitControls as ThreeOrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { EffectPreset } from '../../effects'
import type { WeatherState } from '../../backendApi'
import { ARC_RADIUS } from '../../preview3d/geometry'
import { buildUnitLayouts, type SceneMode, type SimulationSettings } from '../model'
import type { CompiledSequence } from '../sequence'
import { AxisGuide } from './AxisGuide'
import { LightTrail, type Diagnostics } from './LightTrail'

type SimulationCanvasProps = {
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
  /** Live output frame to follow (fractional), or null to run the local clock. */
  syncFrame?: (() => number | null) | null
  /** Frame the clock jumps to on reset. */
  startFrame?: number
  /** Backend unit colour test: one color or null per unit. */
  unitColors?: (import('../../effects').RgbColor | null)[] | null
}

function CameraFraming({ sceneMode }: Pick<SimulationCanvasProps, 'sceneMode'>) {
  const { camera, gl, size } = useThree()
  const controls = useMemo(
    () => new ThreeOrbitControls(camera, gl.domElement),
    [camera, gl.domElement],
  )

  useEffect(() => {
    controls.enableDamping = true
    controls.dampingFactor = 0.075
    controls.minDistance = 3
    controls.maxDistance = 100
    return () => controls.dispose()
  }, [controls])

  useEffect(() => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return
    if (sceneMode === 'nine') {
      const aspect = Math.max(size.width / Math.max(size.height, 1), 0.1)
      const verticalFov = THREE.MathUtils.degToRad(camera.fov)
      const rowDistance = 12.32 / (Math.tan(verticalFov / 2) * aspect)
      const distance = Math.max(9, rowDistance * 1.12)
      camera.position.set(0, distance * 0.28, distance)
      controls.target.set(0, 2.4, 0)
    } else {
      const aspect = Math.max(size.width / Math.max(size.height, 1), 0.1)
      const distanceScale = Math.max(1, 0.9 / aspect)
      camera.position.set(
        5.8 * distanceScale,
        3.8 * distanceScale,
        6.4 * distanceScale,
      )
      controls.target.set(0, 1.05, 0)
    }
    controls.update()
  }, [camera, controls, sceneMode, size.height, size.width])

  useFrame(() => controls.update())
  return null
}

export function SimulationCanvas(props: SimulationCanvasProps) {
  const floorY = Math.min(
    ...buildUnitLayouts(props.sceneMode, 0, 0).map(
      (unit) => unit.y - ARC_RADIUS * unit.scale,
    ),
  ) - (props.sceneMode === 'nine' ? 0.1 : 0.25)

  return (
    <Canvas
      aria-label="旋轉 LED 3D 模擬畫面；XYZ 軸：X 紅色、Y 綠色、Z 藍色"
      shadows
      camera={{ position: [5.8, 3.8, 6.4], fov: 42, near: 0.1, far: 150 }}
      dpr={[1, 1.75]}
      gl={{
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
        toneMapping: THREE.ACESFilmicToneMapping,
      }}
      onCreated={({ gl }) => {
        gl.setClearColor('#05070b')
        gl.outputColorSpace = THREE.SRGBColorSpace
      }}
    >
      <CameraFraming sceneMode={props.sceneMode} />
      <fog attach="fog" args={['#05070b', 40, 100]} />
      <hemisphereLight args={['#b9d8ff', '#17120e', 1.25]} />
      <directionalLight
        position={[4, 7, 5]}
        intensity={3.1}
        color="#e8f4ff"
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
      />
      <directionalLight
        position={[-4, 3, -3]}
        intensity={1.4}
        color="#547dff"
      />
      <LightTrail {...props} />
      {props.showStructure && (
        <>
          <AxisGuide sceneMode={props.sceneMode} />
          <gridHelper
            args={[30, 60, '#263748', '#151e28']}
            position={[0, floorY + 0.01, 0]}
          />
          <mesh
            position={[0, floorY, 0]}
            rotation={[-Math.PI / 2, 0, 0]}
            receiveShadow
          >
            <planeGeometry args={[60, 60]} />
            <meshStandardMaterial color="#080c11" metalness={0.12} roughness={0.88} />
          </mesh>
        </>
      )}
    </Canvas>
  )
}
