import { useState } from 'react'
import { Canvas } from '@react-three/fiber'
import * as THREE from 'three'
import { SemicircleUnit } from './SemicircleUnit'
import { LEDS_PER_ARC } from './geometry'

function PreviewScene({
  rotationRpm,
  ledsOn,
  animateLights,
}: {
  rotationRpm: number
  ledsOn: boolean
  animateLights: boolean
}) {
  return (
    <Canvas
      shadows
      dpr={[1, 1.75]}
      camera={{ position: [5.8, 3.8, 6.4], fov: 42, near: 0.1, far: 80 }}
      gl={{
        antialias: true,
        powerPreference: 'high-performance',
        toneMapping: THREE.ACESFilmicToneMapping,
      }}
      onCreated={({ gl }) => {
        gl.setClearColor('#05070b')
        gl.outputColorSpace = THREE.SRGBColorSpace
      }}
    >
      <fog attach={'fog'} args={['#05070b', 10, 22]} />
      <hemisphereLight args={['#b9d8ff', '#17120e', 1.25]} />
      <directionalLight
        position={[4, 7, 5]}
        intensity={3.1}
        color={'#e8f4ff'}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
      />
      <directionalLight
        position={[-4, 3, -3]}
        intensity={1.4}
        color={'#547dff'}
      />

      <SemicircleUnit
        rotationRpm={rotationRpm}
        ledsOn={ledsOn}
        animateLights={animateLights}
      />

      <gridHelper
        args={[12, 24, '#263748', '#151e28']}
        position={[0, -0.245, 0]}
      />
      <mesh
        position={[0, -0.255, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
      >
        <planeGeometry args={[30, 30]} />
        <meshStandardMaterial
          color={'#080c11'}
          metalness={0.12}
          roughness={0.88}
        />
      </mesh>
    </Canvas>
  )
}

export function Preview3DApp() {
  const [rotationRpm, setRotationRpm] = useState(3)
  const [ledsOn, setLedsOn] = useState(true)
  const [animateLights, setAnimateLights] = useState(false)

  return (
    <main className={'preview-shell'}>
      <header className={'preview-header'}>
        <div>
          <p className={'eyebrow'}>Moon Observe / isolated study</p>
          <h1>Semicircle Cross 3D Preview</h1>
          <p className={'subtitle'}>
            兩個垂直平面的半圓支架，各自平均配置 {LEDS_PER_ARC} 顆 LED。
          </p>
        </div>
        <a className={'back-link'} href={'/'}>
          返回原模擬器
        </a>
      </header>

      <section className={'preview-stage'}>
        <div className={'canvas-panel'}>
          <PreviewScene
            rotationRpm={rotationRpm}
            ledsOn={ledsOn}
            animateLights={animateLights}
          />
          <div className={'interaction-hint'}>
            Drag to orbit · Scroll to zoom · Right-drag to pan
          </div>
        </div>

        <aside className={'preview-controls'}>
          <div>
            <p className={'eyebrow'}>Prototype controls</p>
            <h2>3D 檢視設定</h2>
          </div>

          <label className={'range-control'}>
            <span>
              Turntable speed
              <output>{rotationRpm.toFixed(1)} RPM</output>
            </span>
            <input
              type={'range'}
              min={0}
              max={360}
              step={1}
              value={rotationRpm}
              onChange={(event) => setRotationRpm(Number(event.target.value))}
            />
          </label>

          <label className={'toggle-control'}>
            <span>
              <strong>LED power</strong>
              <small>點亮全部 {LEDS_PER_ARC * 2} 顆燈點</small>
            </span>
            <input
              type={'checkbox'}
              checked={ledsOn}
              onChange={(event) => setLedsOn(event.target.checked)}
            />
          </label>
          <label className={'toggle-control'}>
            <span>
              <strong>LED animation</strong>
              <small>沿兩個半圓反向流動的彩虹色</small>
            </span>
            <input
              type={'checkbox'}
              checked={animateLights}
              disabled={!ledsOn}
              onChange={(event) => setAnimateLights(event.target.checked)}
            />
          </label>

          <dl className={'model-facts'}>
            <div><dt>Geometry</dt><dd>2 semicircle tubes</dd></div>
            <div><dt>Orientation</dt><dd>XY × ZY</dd></div>
            <div><dt>LED layout</dt><dd>{LEDS_PER_ARC} + {LEDS_PER_ARC} instances</dd></div>
            <div><dt>LED state</dt><dd>{ledsOn ? 'On' : 'Off'}</dd></div>
            <div><dt>Diameter</dt><dd>5.0 relative units</dd></div>
          </dl>

          <p className={'assumption-note'}>
            此頁使用相對尺寸，兩個半圓在交會處保留少量 clearance。
            原本的旋轉光跡模擬器保持獨立，尚未共用 effect preset。
          </p>
        </aside>
      </section>
    </main>
  )
}
