import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { OrbitControls as ThreeOrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import {
  ARC_CLEARANCE,
  ARC_RADIUS,
  buildSemicircleLedPositions,
  LEDS_PER_ARC,
  semicirclePoint,
  type SemicirclePlane,
} from './geometry'

const LED_SPACING = Math.PI * ARC_RADIUS / (LEDS_PER_ARC - 1)
const TUBE_RADIUS = LED_SPACING * 0.22
const HOUSING_RADIUS = LED_SPACING * 0.44
const LIGHT_RADIUS = LED_SPACING * 0.32
const GLOW_RADIUS = LED_SPACING * 0.55
const TAU = Math.PI * 2

class SemicircleCurve extends THREE.Curve<THREE.Vector3> {
  constructor(
    private readonly radius: number,
    private readonly plane: SemicirclePlane,
    private readonly normalOffset: number,
  ) {
    super()
  }

  getPoint(progress: number, target = new THREE.Vector3()) {
    const [x, y, z] = semicirclePoint(
      this.radius,
      progress,
      this.plane,
      this.normalOffset,
    )
    return target.set(x, y, z)
  }
}

function CameraControls() {
  const { camera, gl, size } = useThree()
  const controls = useMemo(
    () => new ThreeOrbitControls(camera, gl.domElement),
    [camera, gl.domElement],
  )

  useEffect(() => {
    controls.enableDamping = true
    controls.dampingFactor = 0.075
    controls.minDistance = 4
    controls.maxDistance = 30
    controls.target.set(0, 1.05, 0)
    controls.update()
    return () => controls.dispose()
  }, [controls])

  useEffect(() => {
    const aspect = size.width / Math.max(1, size.height)
    const distanceScale = Math.max(1, 0.9 / aspect)
    camera.position.set(
      5.8 * distanceScale,
      3.8 * distanceScale,
      6.4 * distanceScale,
    )
    controls.update()
  }, [camera, controls, size.width, size.height])

  useFrame(() => controls.update())
  return null
}

type LedInstancesProps = {
  ledsOn: boolean
  animateLights: boolean
}

function LedInstances({ ledsOn, animateLights }: LedInstancesProps) {
  const housingRef = useRef<THREE.InstancedMesh>(null)
  const lightRef = useRef<THREE.InstancedMesh>(null)
  const glowRef = useRef<THREE.InstancedMesh>(null)
  const color = useMemo(() => new THREE.Color(), [])
  const leds = useMemo(() => {
    const first = buildSemicircleLedPositions(
      ARC_RADIUS,
      LEDS_PER_ARC,
      'xy',
      -ARC_CLEARANCE,
    )
    const second = buildSemicircleLedPositions(
      ARC_RADIUS,
      LEDS_PER_ARC,
      'zy',
      ARC_CLEARANCE,
    )

    return [
      ...first.map((position, index) => ({
        position,
        progress: index / (LEDS_PER_ARC - 1),
        arc: 0,
      })),
      ...second.map((position, index) => ({
        position,
        progress: index / (LEDS_PER_ARC - 1),
        arc: 1,
      })),
    ]
  }, [])

  useLayoutEffect(() => {
    if (!housingRef.current || !lightRef.current || !glowRef.current) return
    const matrix = new THREE.Matrix4()

    leds.forEach(({ position, arc }, index) => {
      matrix.makeTranslation(position[0], position[1], position[2])
      housingRef.current!.setMatrixAt(index, matrix)

      const lightOffset = HOUSING_RADIUS * 0.65
      matrix.makeTranslation(
        position[0] + (arc === 0 ? position[0] / ARC_RADIUS * lightOffset : 0),
        position[1] + position[1] / ARC_RADIUS * lightOffset,
        position[2] + (arc === 1 ? position[2] / ARC_RADIUS * lightOffset : 0),
      )
      lightRef.current!.setMatrixAt(index, matrix)
      glowRef.current!.setMatrixAt(index, matrix)
    })
    housingRef.current.instanceMatrix.needsUpdate = true
    lightRef.current.instanceMatrix.needsUpdate = true
    glowRef.current.instanceMatrix.needsUpdate = true
  }, [leds])

  useFrame(({ clock }) => {
    if (!lightRef.current || !glowRef.current) return
    const elapsed = clock.elapsedTime

    leds.forEach(({ progress, arc }, index) => {
      if (animateLights) {
        const direction = arc === 0 ? 1 : -1
        const hue = THREE.MathUtils.euclideanModulo(
          progress * 0.9 + direction * elapsed * 0.24 + arc * 0.5,
          1,
        )
        color.setHSL(hue, 1, 0.52, THREE.SRGBColorSpace)
      } else {
        color.setRGB(1, 1, 1)
      }
      lightRef.current!.setColorAt(index, color)
      glowRef.current!.setColorAt(index, color)
    })
    if (lightRef.current.instanceColor) {
      lightRef.current.instanceColor.needsUpdate = true
    }
    if (glowRef.current.instanceColor) {
      glowRef.current.instanceColor.needsUpdate = true
    }
  })

  return (
    <>
      <instancedMesh
        ref={housingRef}
        args={[undefined, undefined, leds.length]}
        castShadow
      >
        <sphereGeometry args={[HOUSING_RADIUS, 10, 8]} />
        <meshStandardMaterial
          color={'#26313a'}
          metalness={0.62}
          roughness={0.28}
        />
      </instancedMesh>
      <instancedMesh
        ref={lightRef}
        args={[undefined, undefined, leds.length]}
        visible={ledsOn}
      >
        <sphereGeometry args={[LIGHT_RADIUS, 10, 8]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh
        ref={glowRef}
        args={[undefined, undefined, leds.length]}
        visible={ledsOn}
      >
        <sphereGeometry args={[GLOW_RADIUS, 10, 8]} />
        <meshBasicMaterial
          color={'#ffffff'}
          transparent
          opacity={0.25}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </instancedMesh>
    </>
  )
}

type SemicircleUnitProps = {
  rotationRpm: number
  ledsOn: boolean
  animateLights: boolean
}

export function SemicircleUnit({
  rotationRpm,
  ledsOn,
  animateLights,
}: SemicircleUnitProps) {
  const unitRef = useRef<THREE.Group>(null)
  const firstCurve = useMemo(
    () => new SemicircleCurve(ARC_RADIUS, 'xy', -ARC_CLEARANCE),
    [],
  )
  const secondCurve = useMemo(
    () => new SemicircleCurve(ARC_RADIUS, 'zy', ARC_CLEARANCE),
    [],
  )

  useFrame((_, delta) => {
    if (unitRef.current) {
      unitRef.current.rotation.y += delta * rotationRpm * TAU / 60
    }
  })

  return (
    <>
      <CameraControls />
      <group ref={unitRef}>
        <mesh castShadow receiveShadow>
          <tubeGeometry args={[firstCurve, 192, TUBE_RADIUS, 8, false]} />
          <meshStandardMaterial
            color={'#72808d'}
            metalness={0.78}
            roughness={0.24}
          />
        </mesh>
        <mesh castShadow receiveShadow>
          <tubeGeometry args={[secondCurve, 192, TUBE_RADIUS, 8, false]} />
          <meshStandardMaterial
            color={'#586775'}
            metalness={0.72}
            roughness={0.3}
          />
        </mesh>

        <LedInstances ledsOn={ledsOn} animateLights={animateLights} />

        <mesh position={[0, -0.12, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[0.46, 0.58, 0.24, 48]} />
          <meshStandardMaterial
            color={'#1b232c'}
            metalness={0.68}
            roughness={0.34}
          />
        </mesh>
        <mesh position={[0, 0.025, 0]} castShadow>
          <cylinderGeometry args={[0.19, 0.19, 0.08, 40]} />
          <meshStandardMaterial
            color={'#93a1ad'}
            metalness={0.85}
            roughness={0.2}
          />
        </mesh>
      </group>
    </>
  )
}
