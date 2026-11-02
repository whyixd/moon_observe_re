# LED Motion Simulator Plan

## Purpose

建立可完全離線執行的 browser simulator，在沒有 Raspberry Pi、GL-C-616WL、LED strip 與 motor hardware 時，預覽 Moon Observe 在以下條件下的視覺結果：

- 360 RPM continuous rotation
- 40 FPS / 25 ms Art-Net/WLED LED updates
- Gledopto GL-C-616WL sample-and-hold behavior
- Single unit 或 9-unit scene
- Camera motion blur、exposure、bloom 與可調式 visual persistence
- RPM error、network jitter、controller latency、packet drop 與 unit phase offset

Simulator 的目標是 effect previsualization、parameter exploration 與 deterministic regression，不聲稱完全取代硬體/相機 calibration。

## Technology decision

「React 或 Vercel」不是同一層級的選項：React 是 UI library，Vercel 是 hosting/deployment platform；若使用 Vercel application framework，實際比較對象是 React/Vite 與 Next.js。

| 選項 | 優點 | 缺點 | 適合度 |
| --- | --- | --- | --- |
| React + TypeScript + Vite | Client-only 結構直接、HMR 快、static build、WebGL/browser API 無 SSR boundary、可部署到任何 static host | 不內建 server routes、auth 或 database | 最適合 simulator MVP |
| Next.js + React + Vercel | Routing、server components、API/server integration、Vercel deployment 體驗完整 | Three.js 必須放在 Client Component；SSR 對 WebGL scene 幫助有限；增加 hydration/runtime boundary；cloud functions 無法直接存取本地 Art-Net LAN | 未來有帳號/雲端專案管理時再評估 |
| Plain Three.js without React | 最少 abstraction、完全掌控 render loop | Controls、preset editor、multi-panel UI 與狀態管理較難維護 | 適合 isolated rendering prototype，不作主架構 |

### Selected stack

- React + TypeScript + Vite
- `three`
- `@react-three/fiber` as the React renderer for Three.js
- Optional `@react-three/drei` for camera/control helpers
- Three.js `EffectComposer`、render targets、bloom/tone mapping
- Custom temporal accumulation pass for exposure-accurate blur
- Vitest for math/schema unit tests
- Playwright for deterministic visual regression

Vercel 保留為 optional static hosting：Vite production build 可直接部署，不把 simulation correctness 綁定 Vercel runtime。若未來加入登入、雲端 preset sharing 或 public gallery，再評估 Next.js migration。

## Why React Three Fiber

React Three Fiber 是 Three.js 的 React renderer；scene objects 可拆成 reusable components，而 frame updates 仍透過 render loop 執行。適合將 `Rotor`、`LedStrip`、`UnitArray`、`CameraRig`、`TemporalAccumulator` 與 control panels 分開維護。

React state 不應在每個 temporal sub-sample 更新。High-frequency rotation、sample accumulation 與 GPU uniforms 使用 refs/render-loop state；React 只處理 user controls、preset changes 和 diagnostics，避免每 frame component rerender。

## Simulation model

### Independent clocks

Simulator 必須維持三個不同時間尺度：

```text
physicalTime       continuous; drives rotor angle
controllerFrame    floor((physicalTime + controllerOffset) * 40)
displayFrame       browser requestAnimationFrame / offline export timestep
```

```text
rotorAngle(t) = initialPhase + 2π * (RPM / 60) * t
ledState(t)   = pattern[controllerFrame(t)]
```

LED state 在一個 25 ms controller interval 內保持不變，但 rotor angle 持續變化。不可把 rotor rotation 也量化為 40 FPS，否則會遺失最重要的 54° motion streak。

### Camera exposure integration

Camera mode 模擬單張 frame 在 shutter interval 內接收的 radiance：

```text
image = (1 / sampleCount) * Σ renderScene(exposureStart + sampleTime[i])
```

每個 sample 使用該時刻的 continuous rotor angle 與 40 FPS held LED state，render 到 HDR offscreen target，再以 additive accumulation 合成。Default 可使用 16–32 samples/realtime preview；reference/offline mode 使用 64–128 samples。

### Visual persistence mode

人眼殘影不是單一固定 shutter。Simulator 提供 artistic persistence model：

```text
history(t) = currentRadiance + history(t - dt) * exp(-dt / persistenceTau)
```

Three.js `AfterimagePass` 可作 MVP/reference，但 production simulator 應使用 delta-time-aware custom pass，避免 browser FPS 改變殘影長度。UI 必須標示這是 adjustable perceptual model，不是精確的人眼醫學模型。

### Light rendering

- LEDs 使用 `InstancedMesh`、billboard sprites 或 point-based emissive geometry，避免每 pixel 一個 React component。
- 使用 linear color/HDR render target 累積 radiance。
- Temporal accumulation 後套用 bloom，再執行 tone mapping 與 sRGB output conversion。
- Ambient/environment light 與 LED emission 分離，提供 dark-room、gallery、camera modes。
- Dynamic blur 由 temporal integration 產生，不只套用一般 screen-space blur。

## Scene modes

### Single unit

- Side/front/perspective camera
- 可顯示 rotor、兩條穿過圓心的 diameter strips、rotation axis 與 54° sector guides
- Ideal vs blurred split view
- Current controller frame、angle、cycle phase diagnostics

### Nine units

- 3×3 或依實際 installation coordinates 排列
- Per-unit initial phase、RPM error、latency、drop seed
- Global pattern 與 unit offsets
- Aggregate view 和 selected-unit inspection

### Debug overlays

- Rotor angle and angular velocity
- 40 FPS tick marker
- 20-phase cycle index
- Exposure window
- Held LED frame index
- Simulated Art-Net latency/drop
- Temporal sample count and GPU frame time

## Parameter model

```ts
type SimulationPreset = {
  schemaVersion: 1
  seed: number
  motor: {
    rpm: number
    rpmErrorPct: number
    jitterPct: number
  }
  controller: {
    fps: number
    latencyMs: number
    jitterMs: number
    dropRate: number
  }
  strip: {
    ledCount: number
    diameterLengthM: number
    colorOrder: 'RGB' | 'GRB' | 'RGBW'
    output: 'GPIO16' | 'GPIO2'
  }
  camera: {
    exposureMs: number
    temporalSamples: number
    persistenceMs: number
    bloom: number
    exposure: number
  }
  pattern: {
    id: string
    frames: number
    palette: string[]
    unitPhaseOffsets: number[]
  }
}
```

Frontend 與 backend 共享 JSON schema/golden fixtures，不共享 TypeScript runtime implementation。Backend 可使用相同 schema 的 language-neutral subset。

## Suggested source structure

```text
frontend/
├── src/
│   ├── app/                  # Layout, routing-free SPA shell
│   ├── effects/              # Backend-syncable pure effect modules
│   ├── simulation/
│   │   ├── clock/            # Rotor/controller/display time model
│   │   ├── scene/            # Rotor, LED strip, unit array
│   │   ├── rendering/        # HDR targets, exposure accumulation, bloom
│   │   └── diagnostics/      # Overlays and metrics
│   ├── controls/             # Parameter panels and presets
│   ├── schema/               # Versioned JSON types/validation
│   └── export/               # Screenshot, preset and later video export
├── tests/
│   ├── unit/                 # Kinematics, 40 FPS hold, deterministic seeds
│   └── visual/               # Playwright reference screenshots
└── public/presets/           # Versioned sample effects
```

## Accuracy levels

### Realtime preview

- Target browser rendering：60 FPS
- Temporal samples：8–32 depending on GPU
- Adaptive quality：reduce samples/resolution before changing physics clocks
- Used for parameter tuning and live controls

### Reference render

- Fixed deterministic timestep
- Temporal samples：64–128
- Fixed resolution、seed、camera and tone mapping
- Used for screenshot baselines and effect approval

### Future calibration mode

- Import real camera exposure/FPS and lens settings
- Match filmed hardware reference with simulator sliders
- Optional rolling-shutter model and measured GL-C-616WL latency distribution

## Feasibility and limitations

### High-confidence simulation

- 360 RPM kinematics
- 25 ms LED state hold
- 54°/frame sector width
- 20-frame/3-revolution nominal cycle
- Pattern geometry and multi-unit timing offsets
- Camera exposure integration under an ideal global shutter
- Sensitivity to synthetic jitter/drop/RPM error

### Approximate until calibrated

- Bloom radius and absolute brightness
- Human visual persistence
- LED spectral/color response
- Camera tone mapping、lens flare、noise and rolling shutter

### Cannot replace hardware tests

- GL-C-616WL actual output latency/drop behavior
- Electrical brush data integrity
- Power delivery/current/thermal behavior
- Rotor balance、vibration and safety

Simulation therefore satisfies the goal of no-hardware **effect design and review**, but not final deployment certification.

## Verification plan

### Unit tests

- `angle(25 ms, 360 RPM) = 54°`
- `phase(frame 20) = phase(frame 0)` under ideal conditions
- LED frame changes only on 25 ms boundaries
- Exposure samples crossing a controller boundary use both LED states correctly
- Seeded jitter/drop produces deterministic events
- JSON schema round-trip preserves preset values

### Visual regression

- No blur / zero exposure reference
- 25 ms exposure showing a 54° held-color sector
- Exposure crossing two Art-Net frames
- 20-phase temporal color mix
- Nine-unit wave with fixed offsets
- Degraded mode with deterministic jitter/drop

### Performance gates

- Realtime single-unit preview at 1080p/60 FPS on target development machine
- Nine-unit preview stays interactive using adaptive temporal sample count
- Reference render completes deterministically even if slower than realtime
- No frame-rate-dependent rotor speed or persistence decay

## Delivery phases

### Simulator M0 — Mathematical prototype（implemented）

- React/Vite/R3F scaffold
- One rotor、two full-diameter strips crossing at 90°、360 RPM
- Independent 40 FPS LED clock
- Temporal exposure/persistence preview、basic controls and diagnostics

### Simulator M1 — Motion appearance

- HDR temporal accumulation
- Camera exposure and persistence modes
- Bloom/tone mapping
- Reference screenshot export

### Simulator M2 — Effect authoring

- Independent effect contract and first effect modules（implemented）
- Palette editor、additional diameter-strip profiles
- Preset import/export
- RPM/jitter/drop/latency simulation

### Simulator M3 — Installation preview

- Nine-unit layout
- Per-unit offsets and diagnostics
- Visual regression suite and three approved presets

### Simulator M4 — Optional deployment

- Static production build
- Deploy to Vercel or serve from Raspberry Pi/Nginx
- No cloud dependency for local simulation

## Sources

- [React Three Fiber introduction](https://r3f.docs.pmnd.rs/getting-started/introduction)
- [Three.js post-processing guide](https://threejs.org/manual/pages/post-processing.html)
- [Three.js AfterimagePass](https://threejs.org/docs/pages/AfterimagePass.html)
- [Vite getting started](https://vite.dev/guide/)
- [Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite)
- [Next.js client components](https://nextjs.org/docs/app/getting-started/server-and-client-components)
- [Next.js static export](https://nextjs.org/docs/app/guides/static-exports)
