import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import {
  ARC_CLEARANCE,
  ARC_RADIUS,
  buildSemicircleLedPositions,
  LEDS_PER_ARC,
  semicirclePoint,
  type SemicirclePlane,
} from '../../preview3d/geometry'
import type { SceneMode, UnitLayout } from '../model'

const LED_SPACING = Math.PI * ARC_RADIUS / (LEDS_PER_ARC - 1)
const TUBE_RADIUS = LED_SPACING * 0.22
const HOUSING_RADIUS = LED_SPACING * 0.44
const LIGHT_RADIUS = LED_SPACING * 0.32
const GLOW_RADIUS = LED_SPACING * 0.55

class SemicircleCurve extends THREE.Curve<THREE.Vector3> {
  constructor(
    private readonly plane: SemicirclePlane,
    private readonly normalOffset: number,
  ) {
    super()
  }

  getPoint(progress: number, target = new THREE.Vector3()) {
    const [x, y, z] = semicirclePoint(
      ARC_RADIUS,
      progress,
      this.plane,
      this.normalOffset,
    )
    return target.set(x, y, z)
  }
}

const LED_LAYOUT = [
  ...buildSemicircleLedPositions(
    ARC_RADIUS, LEDS_PER_ARC, 'xy', -ARC_CLEARANCE,
  ).map((position) => ({ position, arc: 0 })),
  ...buildSemicircleLedPositions(
    ARC_RADIUS, LEDS_PER_ARC, 'zy', ARC_CLEARANCE,
  ).map((position) => ({ position, arc: 1 })),
]

type SimulatedSemicircleUnitProps = {
  unit: UnitLayout
  sceneMode: SceneMode
  selected: boolean
  showStructure: boolean
  onSelectUnit: (unitIndex: number) => void
  onRotor: (node: THREE.Group | null) => void
  onLights: (node: THREE.InstancedMesh | null) => void
  onGlow: (node: THREE.InstancedMesh | null) => void
}

export function SimulatedSemicircleUnit({
  unit,
  sceneMode,
  selected,
  showStructure,
  onSelectUnit,
  onRotor,
  onLights,
  onGlow,
}: SimulatedSemicircleUnitProps) {
  const housingRef = useRef<THREE.InstancedMesh | null>(null)
  const lightRef = useRef<THREE.InstancedMesh | null>(null)
  const glowRef = useRef<THREE.InstancedMesh | null>(null)
  const firstCurve = useMemo(
    () => new SemicircleCurve('xy', -ARC_CLEARANCE),
    [],
  )
  const secondCurve = useMemo(
    () => new SemicircleCurve('zy', ARC_CLEARANCE),
    [],
  )

  useLayoutEffect(() => {
    if (!lightRef.current || !glowRef.current) return
    const matrix = new THREE.Matrix4()
    const black = new THREE.Color(0, 0, 0)
    const lightOffset = HOUSING_RADIUS * 0.65

    LED_LAYOUT.forEach(({ position, arc }, index) => {
      matrix.makeTranslation(position[0], position[1], position[2])
      housingRef.current?.setMatrixAt(index, matrix)

      matrix.makeTranslation(
        position[0] + (arc === 0 ? position[0] / ARC_RADIUS * lightOffset : 0),
        position[1] + position[1] / ARC_RADIUS * lightOffset,
        position[2] + (arc === 1 ? position[2] / ARC_RADIUS * lightOffset : 0),
      )
      lightRef.current!.setMatrixAt(index, matrix)
      glowRef.current!.setMatrixAt(index, matrix)
      lightRef.current!.setColorAt(index, black)
      glowRef.current!.setColorAt(index, black)
    })

    if (housingRef.current) housingRef.current.instanceMatrix.needsUpdate = true
    lightRef.current.instanceMatrix.needsUpdate = true
    glowRef.current.instanceMatrix.needsUpdate = true
    if (lightRef.current.instanceColor) lightRef.current.instanceColor.needsUpdate = true
    if (glowRef.current.instanceColor) glowRef.current.instanceColor.needsUpdate = true
  }, [showStructure])

  const count = LED_LAYOUT.length

  return (
    <group
      position={[unit.x, unit.y, 0]}
      rotation-y={unit.yawRadians}
      onClick={(event) => {
        event.stopPropagation()
        onSelectUnit(unit.index)
      }}
    >
      {selected && showStructure && (
        <mesh
          position={[0, ARC_RADIUS * unit.scale + (sceneMode === 'nine' ? 0.13 : 0.38), 0]}
          rotation-z={Math.PI}
        >
          <coneGeometry args={sceneMode === 'nine' ? [0.06, 0.12, 3] : [0.16, 0.32, 3]} />
          <meshBasicMaterial color="#65d9f8" side={THREE.DoubleSide} />
        </mesh>
      )}
      <group ref={onRotor} scale={unit.scale} rotation-x={unit.tiltXRadians}>
        {showStructure && (
          <>
            <mesh castShadow>
              <tubeGeometry args={[firstCurve, 192, TUBE_RADIUS * (sceneMode === 'nine' ? 3 : 1), 8, false]} />
              <meshStandardMaterial color="#8da3b8" metalness={0.58} roughness={0.32} />
            </mesh>
            <mesh castShadow>
              <tubeGeometry args={[secondCurve, 192, TUBE_RADIUS * (sceneMode === 'nine' ? 3 : 1), 8, false]} />
              <meshStandardMaterial color="#72879a" metalness={0.58} roughness={0.35} />
            </mesh>
            <instancedMesh ref={housingRef} args={[undefined, undefined, count]}>
              <sphereGeometry args={[HOUSING_RADIUS, 10, 8]} />
              <meshStandardMaterial color="#26313a" metalness={0.62} roughness={0.28} />
            </instancedMesh>
          </>
        )}
        <instancedMesh
          ref={(node) => {
            lightRef.current = node
            onLights(node)
          }}
          args={[undefined, undefined, count]}
        >
          <sphereGeometry args={[LIGHT_RADIUS, 10, 8]} />
          <meshBasicMaterial toneMapped={false} />
        </instancedMesh>
        <instancedMesh
          ref={(node) => {
            glowRef.current = node
            onGlow(node)
          }}
          args={[undefined, undefined, count]}
        >
          <sphereGeometry args={[GLOW_RADIUS, 10, 8]} />
          <meshBasicMaterial
            color="#ffffff"
            transparent
            opacity={0.25}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            toneMapped={false}
          />
        </instancedMesh>
        {showStructure && (
          <>
            <mesh position={[0, -0.12, 0]} castShadow>
              <cylinderGeometry args={[0.46, 0.58, 0.24, 48]} />
              <meshStandardMaterial color="#1b232c" metalness={0.68} roughness={0.34} />
            </mesh>
            <mesh position={[0, 0.025, 0]} castShadow>
              <cylinderGeometry args={[0.19, 0.19, 0.08, 40]} />
              <meshStandardMaterial color="#93a1ad" metalness={0.85} roughness={0.2} />
            </mesh>
          </>
        )}
      </group>
    </group>
  )
}
