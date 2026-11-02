import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { SceneMode } from '../model'

const AXIS_LENGTH = 0.85
const AXES = [
  { label: 'X', color: '#ff5555', endpoint: [AXIS_LENGTH, 0, 0] },
  { label: 'Y', color: '#55ff55', endpoint: [0, AXIS_LENGTH, 0] },
  { label: 'Z', color: '#5599ff', endpoint: [-0.2, -0.2, AXIS_LENGTH] },
] as const

function createAxisLabel(label: string, color: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const context = canvas.getContext('2d')

  if (context) {
    context.fillStyle = 'rgba(5, 7, 11, 0.9)'
    context.fillRect(8, 8, 112, 112)
    context.strokeStyle = color
    context.lineWidth = 8
    context.strokeRect(12, 12, 104, 104)
    context.fillStyle = color
    context.font = 'bold 78px Arial'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(label, 64, 69)
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

export function AxisGuide({ sceneMode }: { sceneMode: SceneMode }) {
  const helperRef = useRef<THREE.AxesHelper>(null)
  const labels = useMemo(
    () => AXES.map(({ label, color }) => createAxisLabel(label, color)),
    [],
  )

  useEffect(
    () => () => labels.forEach((texture) => texture.dispose()),
    [labels],
  )

  useEffect(() => {
    const material = helperRef.current?.material
    if (!material) return
    for (const item of Array.isArray(material) ? material : [material]) {
      item.depthTest = false
      item.depthWrite = false
    }
  }, [])

  return (
    <group position={sceneMode === 'nine' ? [-3.5, -0.7, 2.3] : [-2.5, -0.3, 1.8]}>
      <axesHelper ref={helperRef} args={[AXIS_LENGTH]} />
      {AXES.map(({ label, endpoint }, index) => (
        <sprite key={label} position={endpoint} scale={[0.3, 0.3, 1]}>
          <spriteMaterial
            map={labels[index]}
            transparent
            depthTest={false}
            depthWrite={false}
            toneMapped={false}
          />
        </sprite>
      ))}
    </group>
  )
}
