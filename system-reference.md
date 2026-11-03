# Moon Observe（LongN）系統參考（給 agents）

> 從程式碼整理（2026-11-03，`master`）。各段標出**權威來源檔案**，文件與程式不一致時以程式為準；改動行為後請同步更新此文件。移植計畫、決策與現場測試紀錄見 [`PLAN.md`](PLAN.md)。

專案概觀：把 Moon Observe 的效果系統（effect engine、串接、天氣、控制頁）接到 **LongN** 的硬體上。一台 Windows 10 電腦執行 Python 後端，把效果算成影格，用 Art-Net 送到 **5 台** LongN 控制盒；每台控制盒驅動一組旋轉的雙半圓燈（每條半圓 **152 顆** RGB LED）和一顆馬達。同一個後端程序也提供 React 前端頁面與 JSON API；前端是 3D 模擬器兼控制台。LongN 原本的 Processing 程式（`LongN/`）只作為硬體對照，不再使用。

```text
瀏覽器 ──HTTP JSON（同源 /api，輪詢）──▶ Python 後端（Windows 服務 :8765）──Art-Net UDP（Ethernet 2.0.0.99）──▶ 5 × LongN 控制盒
                                              │                                                       2.0.0.101–105
                                              └─ 背景執行緒 ──HTTPS（Wi-Fi）──▶ Open-Meteo                U0 → DMX（馬達）
                                                                                                         U1 → SPI（LED）
```

---

## 1. Effect engine

### 1.1 雙實作、同一規格

| 角色 | 位置 |
|---|---|
| **規格與參考實作（TypeScript）** | `frontend/src/effects/`（`contract.ts` 型別、`index.ts` 註冊與 `sampleEffect`、每個效果一個檔、`rain.ts`、`color.ts`、`unitVariation.ts`） |
| **後端移植（純 Python）** | `backend/moon_observe_backend/effects.py`（全部效果在 `_brightness`／`_rain_brightness` 兩個大函式中以 `if effect == ...` 分派） |
| 一致性測試 | `frontend/scripts/generateBackendVectors.ts` 用前端程式產生 `backend/fixtures/effects_v2.json`；`backend/tests/test_effects.py`、`test_sequence.py` 比對 |

兩邊必須逐值一致：

- 四捨五入一律用 `floor(x + 0.5)`（對齊 JS `Math.round`，**不是** Python 的銀行家捨入）。
- 亂數使用相同的 xorshift32 / 固定種子（`_random_ranks`、`_random32`、`hash01`、`unit_turn` 種子 1009）。
- 參數範圍、預設值、step 兩邊各有一份：前端在各效果 `manifest.parameters`；後端在 `PARAMETERS`（min, max, default, integer）與 `PARAMETER_STEPS`。
- 上限隨燈數而定的參數，兩邊共用同一張 `LED_COUNT_BOUNDS` 表（前端 `parameterMax()`、後端 `parameter_max()`）：`periodic-leds` 的 `litCount` ≤ 燈數、`darkGap` ≤ 燈數 − 1，`random-leds` 的 `litCount` ≤ 燈數；`unitVariation` 的 from／to 也受同樣限制。參數表上的固定上限是 170（`MAX_LED_COUNT`，一個 universe 放得下的燈數）。
- `effects_v2.json` 有兩組資料：參考系統的 156 顆 × 9 台（頂層欄位），以及 LongN 的 152 顆 × 5 台（`longn` 區塊，含貼著上限的參數）。兩組都要逐 byte 相同。

### 1.2 核心模型：純函式、以影格為時間

效果是**純函式**，不碰 React／Three.js／瀏覽器時間：

```
sampleEffect(preset, context, elapsedFrame, raining) -> RGB（各通道 0–1）
```

- 時間 = `controllerFrame / controllerFps`（Art-Net 影格，預設 40 FPS），**不是**渲染時間；LED 為 sample-and-hold。
- 輸出 = `顏色 × 亮度`。效果只決定亮度（`brightness()` 或 `sample()` 的最大通道），顏色由 preset 的 `color` 決定（`rain()` 存在且下雨時改用雨天亮度）。
- 幾何：每台一條半圓 152 顆 LED，index 0 與 151 是兩腳、75／76 是頂點（兩條交叉的半圓吃同一份資料）。效果不知道月亮校正與亮度，那是硬體層（第 2 節）的事。

`EffectSampleContext`（Python 為 `EffectContext` dataclass）：

| 欄位 | 意義 |
|---|---|
| `controllerFrame` | 該 unit 的影格（已加上多雲錯開 `frameOffset`、已依次數播放取餘數） |
| `globalControllerFrame` | 未加 offset 的共同影格，供跨 unit 編排（如逐月） |
| `controllerFps` | 通常 40 |
| `ledIndex` / `ledCount` | 0..151 / 152（`render.pixels`） |
| `normalizedStripPosition` | `ledIndex/(ledCount-1)`，一端 0、另一端 1 |
| `normalizedRadius` | `abs(strip*2-1)`，頂點 0、兩腳 1 |
| `unitIndex` / `unitCount` | 0-based / 通常 5（`render.unit_count`） |
| `unitRelativeY`、`unitPhaseProjection` | 依各台目前轉速估計的旋轉相位（無回授，見 1.5），只有 `world-upper-half` 使用 |

`EffectModule`（`contract.ts`）可選欄位：`completion`（一個自然週期的影格數）、`brightness`、`gradientPosition`、`unitGradientPosition`、`loopGradient`、`rain`、`ignoresWeatherTiming`。

### 1.3 EffectPreset v2（JSON 格式）

```json
{
  "schemaVersion": 2,
  "effectId": "center-out-sine",
  "parameters": { "speedHz": 0.35 },
  "color": {
    "mode": "gradient",
    "axis": "radius",
    "colors": [{ "r": 0.2, "g": 0.92, "b": 1 }, { "r": 0.66, "g": 0.28, "b": 1 }],
    "axisChange": { "to": "strip", "atSeconds": 4, "blendSeconds": 1, "repeat": false },
    "weatherPalette": false
  },
  "unitVariation": { "parameter": "speedHz", "from": 0.2, "to": 1, "distribution": "linear" }
}
```

- `color.mode`：`solid`（`color: {r,g,b}`）或 `gradient`（`axis` + 2–8 個均分色點）。
- `axis`：`strip`（一腳到另一腳）、`radius`（頂點到腳）、`unit`（每台取一個純色）。`spectrum-cycle`、`color-breathing`、`twenty-beat` 的漸層會循環（loop）並隨時間位移；`random-fill` 不論 axis 都是每台一個純色（`unit_palette_position`，以與 unit 數互質、接近一半的步長跳色）。
- `axisChange`（選填，只限漸層）：自效果／段落開始第 `atSeconds` 秒起以 `blendSeconds` 漸變到 `to`；`repeat` 來回交替。秒數 0–3600。
- `weatherPalette: false`（選填）：天氣啟用時仍用自己的顏色。省略 = 套用天氣色盤。
- `unitVariation`（選填）：各台的某個參數各取固定值，`linear`／`skip`／`random`（固定種子），值對齊參數 step。`FIXED_PARAMETERS` 列出不可變化的參數。以次數播放時週期取最慢一台。
- 驗證：`effects.validate_preset(value, led_count)`（多餘欄位、超出範圍、超過燈數上限都會拒絕）；正規化輸出：`preset_to_json`。

### 1.4 效果清單

| effectId | 中文名 | 有週期（可用次數播放） | 雨天線條 |
|---|---|---|---|
| `spectrum-cycle` | 光譜循環 | 20 影格 | – |
| `center-out-sine` | 中心擴散 | ✓ | 只留波峰細環 |
| `moving-rings` | 往返光環 | ✓ | – |
| `sequential-center-fill` | 逐月（Unit 1→N 由中心填滿） | ✓ | 同心條紋 |
| `periodic-leds` | 落雨 | ✓ | – |
| `random-leds` | 隨機亮點 | – | – |
| `world-upper-half` | 空間上方 1/3 圓 | – | – |
| `reverse-tide` | 逆向聚潮 | ✓ | 同心條紋 |
| `wide-rings` | 寬幅同心環 | ✓ | 每帶內外兩條邊線 |
| `comet-tail` | 漸層彗尾 | ✓ | 細環彗頭＋稀疏雨絲尾 |
| `stardust-cloud` | 星塵雲 | – | 雨絲 |
| `color-breathing` | 色彩吐納 | – | 同心條紋 |
| `sector-smear` | 扇區疊影 | 8 影格 | – |
| `twenty-beat` | 二十拍萬花筒 | 20 影格 | – |
| `sine-swell` | 流光波 | ✓ | 只留波峰細環 |
| `random-fill` | 隨機填滿 | ✓ | 已亮的燈閃雨絲 |
| `full-on` | 全亮 | – | 滿版雨絲 |
| `unit-chase` | 逐台巡行 | ✓ | 不適用 |
| `unit-random` | 隨機單台 | ✓ | 不適用 |
| `roulette-ring` | 輪盤收束 | ✓ | 不適用 |

- 週期：前端 `getEffectCompletion`，後端 `completion_frames`（`None` = 無週期，串接只能以時間播放）。
- `unit-chase`、`unit-random`、`roulette-ring` 是**整台為單位**的效果：`ignoresWeatherTiming` / `WEATHER_TIMING_FREE`，各台共用時間表，不套用多雲錯開、沒有雨天版本、參數不可逐台變化。
- 各效果的詳細行為見 `frontend/src/effects/README.md`。雨天常數 `RAIN_LINES = {stripeSpacing: 6, streakFrames: 2, sparseDensity: 0.18, denseDensity: 0.45}`（`rain.ts` 與 `effects.py` 同值）。

### 1.5 後端每影格渲染流程

權威來源：`output.py:stream` → `renderer.py:render_frame` / `sequence.py:render_sequence_frame` → `effects.py:sample_effect` → `hardware.py:build_payload`。

1. 主迴圈依實際時鐘計算 `due = floor(elapsed * fps)`，追上進度後渲染（不補送漏掉的影格）。
2. 讀 `SequenceStore.snapshot()` →（mode, compiled, generation）。generation 改變（儲存串接、套用單一效果、restart API）或天氣 generation 改變 → `playback_start_frame = frame`，從第 0 影格重播。
3. 呼叫 `WeatherStore.advance(...)`（造訪計時、在段落邊界套用延後的天氣分類），再取天氣 snapshot。
4. 讀 `MotorStore.snapshot()`（每台 speed／direction）與 `HardwareStore.moon_correction()`；API 的變更從下一格生效。每台的**虛擬轉角**依該台目前的 rpm 累加（stop 為 0、ccw 為負），作為 `world-upper-half` 的相位估計（`virtualPhaseRadians`，`render_frame` 的 `rpm=0`）。
5. 對每個 unit（一個 target）算一次、送到它的每個 universe：
   - `frameOffset = (unitId-1) * cloud_step`（僅 `cloudy`）。
   - 單色測試中 → 整條填測試色；否則串接模式用 `render_sequence_frame`，單一效果用 `render_frame`。
   - `render_frame`：套 `unitVariation`（`preset_for_unit`）→ 依次數播放時 `frame % cycle` → 加 offset（整台效果除外）→ 若天氣有色盤且 `weatherPalette` 未關，**只換顏色**（漸層效果保留自己的 axis 與 axisChange；純色效果改用色盤的 axis）→ 逐顆 `sample_effect(..., raining)`。
   - `build_payload`（第 2 節）：月亮校正 → 色序與亮度 → 512 bytes，含馬達的速度與方向 channel。
6. 結束（正常結束、Ctrl+C、SIGTERM、Windows 服務停止，或例外）時，每個 universe 送**兩次**全 0（燈全暗、馬達停），再關閉 client。

### 1.6 串接（Sequence）

權威來源：`backend/moon_observe_backend/sequence.py`、`frontend/src/simulation/sequence.ts`（兩者同邏輯）。

- 段落 `playback`：`{"kind":"count","count":1..100}`（需有週期）或 `{"kind":"time","seconds":(0,3600]}`。
- 段落 `transition`：`cut`／`fade-black`／`crossfade`／`unit-fade-black`，`seconds` 0–10。**第 i 段的 transition 用在「第 i 段 → 第 i+1 段」**，佔用下一段開頭的影格。
  - `crossfade`：兩層權重線性交叉。
  - `fade-black`：前半淡出、後半淡入。
  - `unit-fade-black`：前半逐台淡出（`unit_fade_weight`），後半一起淡入。
- `ending`：`hold`（停在最後畫面）、`loop`（最後一段的 transition 接回第一段）、`fade-black`（`seconds` 淡出至黑）。
- 編譯後每段有 `start`、`duration`、`cycle`、`transition_frames`；渲染時最多兩層（outgoing + current）加權相加。最多 64 段。
- 串接**不控制馬達**：轉速與方向只能從 API／控制頁手動設定。

### 1.7 新增效果的檢查清單

1. 前端：`frontend/src/effects/<name>.ts`（`EffectModule`），在 `contract.ts` 的 `EffectId` union 與 `index.ts` 的 `EFFECTS` 註冊；需要時加 `defaultEffectColor`（`color.ts`）、`FIXED_PARAMETERS`、`LED_COUNT_BOUNDS`。
2. 後端 `effects.py`：`EFFECT_IDS`、`PARAMETERS`、`PARAMETER_STEPS`（非整數參數）、`FIXED_PARAMETERS`、`LED_COUNT_BOUNDS`、`_brightness`、`completion_frames`、需要時 `_rain_brightness`、`_axis_color`、`default_preset`、`WEATHER_TIMING_FREE`。
3. `frontend/scripts/generateBackendVectors.ts` 的 `ids` 加入新 ID，重新產生 `backend/fixtures/effects_v2.json`（`npx vite-node scripts/generateBackendVectors.ts --write`）。
4. 前後端測試：`cd frontend && npm test`；`cd backend && uv run --locked python -m unittest discover -s tests -v`。
5. 更新 `frontend/src/effects/README.md` 與本文件的效果表。

---

## 2. LongN 硬體對應

權威來源：`backend/moon_observe_backend/hardware.py`（純函式）、`motor.py`（執行時狀態）、`config.py`（`[hardware]`、`[motor]`）；對照 `LongN/Artnet.pde`、`LongN/Video.pde`，golden test 在 `backend/tests/test_hardware.py`。

### 2.1 每台的 Art-Net 封包

每台每影格一包 **512 bytes**，同一包送到該台的每個 universe（LongN 控制盒的 U0 驅動 DMX → 馬達，U1 驅動 SPI → LED）：

| Channel（1 起算） | 內容 |
|---|---|
| 1–456 | 152 顆 × 3 bytes，色序 `GRB`；值 = `floor(clamp01(c × brightness) × 255 + 0.5)`，`brightness` 預設 0.4 |
| 457 | 馬達速度：`stop` 0、`mid` 60、`max` 230 |
| 458 | 馬達方向：`cw` 0、`ccw` 255 |
| 459–512 | 0 |

- 色序可為 `RGB`／`RBG`／`GRB`／`GBR`／`BRG`／`BGR`；兩個馬達 channel 可以移動，但不能和 LED 重疊，也不能相同（`pixels × 3 < min(兩個 channel)`）。
- 和 LongN 的差異：LongN 只有 76 個顏色、前後鏡像成 152；這裡 152 顆各自計算。亮度 1.0 時與 LongN 逐 byte 相同；亮度 0.4 加月亮校正時每個 channel 只會比 LongN 多 0 或 1（LongN 先四捨五入再整數截斷，這裡只捨入一次）。
- **需要現場確認**：index 0 是否在腳端、色序、cw／ccw 與實際轉向。

### 2.2 月亮校正

只在**該台全速（`max`）而且開關打開**時套用（LongN 只在 turnningMode 2 時做）：兩腳往頂點對稱計算，`from_foot = min(i, n-1-i)`、`from_apex = (n-1)//2 - from_foot`：

- 靠腳 15 顆：增益 `(from_foot + 1) / 15`（1/15 → 1）。
- 靠頂點 7 顆：增益 `0.3 + 0.7 × from_apex / 7`（0.3 → 1）。
- 其他為 1。

開關預設由 `[hardware] moon_correction` 決定，執行時可用 `PUT /api/hardware` 切換（只在記憶體）。前端模擬器用 `frontend/src/hardware.ts` 套用同樣的增益（不模擬亮度 40%）。

### 2.3 馬達

- 每台的 speed（`stop`／`mid`／`max`）與 direction（`cw`／`ccw`）只能從 `PUT /api/motor` 手動設定；串接與效果不會改變轉速。
- 只存在記憶體：後端啟動時一律 `stop`、`cw`。
- `[motor] rpm = { mid = 130, max = 500 }` 只用於模擬器與相位估計；`max` 由使用者提供，`mid` 依 60／230 比例估計。
- 控制盒收不到 Art-Net 時**不會**自己停馬達，目前不做額外保護；只保證程式結束時送全 0。

---

## 3. 前端架構及 UI 排版

### 3.1 技術與入口

- React 18 + TypeScript + Vite 6；3D 用 three 0.180 + `@react-three/fiber` 8；測試 vitest（node 環境）；`scripts/screenshot.mjs` 用 Playwright 截圖。
- 沒有狀態管理函式庫、沒有 router、沒有 CSS 框架。
- Vite 多頁面（`vite.config.ts` 的 `rollupOptions.input`）：

| HTML | 進入點 | 用途 |
|---|---|---|
| `index.html` | `src/main.tsx` → `App.tsx` | 主模擬器＋控制台 |
| `palette.html` | `src/palette/main.tsx` → `PaletteApp.tsx` | 天氣溫度色盤編輯（`/palette.html`） |
| `3d.html` | `src/preview3d/main.tsx` → `Preview3DApp.tsx` | 單組實體幾何預覽 |

### 3.2 目錄

```text
frontend/src/
├── App.tsx                 # 主頁所有狀態（useState/useRef）、API 呼叫、輪詢、本地／後端馬達狀態；把 props 傳給 ControlPanel
├── backendApi.ts           # 所有 /api 呼叫與回應型別（唯一的 fetch 集中處）
├── hardware.ts             # 月亮校正增益（與後端 hardware.moon_correction_gain 相同）
├── playbackProgress.ts     # 由 /api/playback 推算目前後端影格（liveBackendFrame）
├── styles.css              # 全站唯一樣式表（純 CSS class）
├── components/
│   ├── ControlPanel.tsx    # 右側分頁面板（含 Slider、ColorInput、UnitVariationEditor、AxisChangeEditor）
│   ├── MotorPanel.tsx      # 馬達面板：全部＋每台〔停｜中速｜全速〕〔順｜逆〕、月亮校正開關
│   ├── SequenceEditor.tsx  # 串接編輯（模擬模式）
│   ├── SavedSequenceView.tsx # 後端已儲存串接唯讀檢視（後端控制模式）
│   ├── PlaybackProgress.tsx  # 後端播放進度
│   ├── UnitColorTestPanel.tsx # 單色測試
│   ├── WeatherPanel.tsx    # 天氣狀態、手動測試、造訪
│   └── GradientEditor.tsx  # 漸層色點編輯
├── effects/                # Effect engine（見第 1 節）
├── simulation/
│   ├── model.ts            # SimulationSettings、馬達型別與 RotorSegment、LongN 排列、轉角／影格換算、時間取樣
│   ├── sequence.ts         # 串接編譯與解析（與後端同邏輯）
│   └── scene/              # SimulationCanvas（R3F Canvas、取景）、LightTrail（每影格取樣與殘影）、SimulatedSemicircleUnit、AxisGuide
├── palette/                # 色盤頁
└── preview3d/              # 幾何預覽頁與共用幾何（LEDS_PER_ARC = 152，離線預設）
```

### 3.3 狀態與模式

- **控制模式**（header 的分段按鈕）：
  - `模擬`：3D 畫面播放瀏覽器內編輯中的效果／串接，可自由調整。馬達用本地狀態，預設全速順轉。
  - `後端控制`：讀 `/api/state`，可套用效果、控制馬達與月亮校正、重播；3D 畫面改為**鏡像後端實際輸出**（已儲存的串接或已套用的效果），時間跟隨 `/api/playback`，每台照 `/api/playback` 的 `motor`（沒有在播放時用 `/api/state`）轉。
- 燈數、台數、FPS、mid／max rpm 從後端 `output` 讀取（啟動時讀 `/api/sequence`，切到後端控制時讀 `/api/state`）；離線預設 152 顆 × 5 台、40 FPS、130／500 rpm。
- 串接編輯器在模擬模式可用，啟動時自動載入後端 `sequence.json`；`sequenceDirty` 比對 JSON 字串判斷是否未儲存。
- 天氣狀態從後端取得後，在前端**本地**套用到模擬（色盤、多雲 frameStep、雨天線條），算法與後端相同。
- 物理分頁設定（mid／max rpm、FPS、曝光、殘影、取樣數、相位差）只存在記憶體；連上後端時由後端覆蓋並鎖定。

### 3.4 主頁排版

```text
.app-shell.simulator-shell（整頁固定 100dvh，flex column）
├── header.app-header：h1「Moon Observe Simulator」 ｜ 分段按鈕〔模擬｜後端控制〕
└── section.workspace（CSS grid：minmax(0,1fr) ｜ minmax(300px,360px)）
    ├── .viewport-panel（左）
    │   ├── .viewport-toolbar：〔暫停/繼續〕〔重設時間〕｜〔單組｜全部〕｜ unit 1–N 選擇 ｜ ☐骨架
    │   └── .canvas-wrap
    │       ├── <SimulationCanvas>（R3F）
    │       ├── .viewport-caption：效果名 · FPS · 第 n 台 rpm 順／逆（或停止）·（後端輸出／本地模擬）·（單色測試中）
    │       └── .diagnostics（6 欄 grid）：Rotor° · Frame · Phase · °/frame · Exposure · Time（都以選取的那台計算）
    └── section.controls（右，ControlPanel）
        ├── .control-tabs（role=tablist）：效果｜色彩｜串接｜後端｜天氣*｜物理
        └── .control-tabpanel（面板內捲動）
```

`*` 天氣分頁只在後端已設定 `[weather]` 時出現。直向螢幕或寬度 ≤ 900px：`.workspace` 改為單欄、上下兩列（`1.15fr / 1fr`）。

各分頁內容：

| 分頁 | 內容 |
|---|---|
| 效果 | Effect 下拉選單、參數 Slider（由 manifest 自動產生，上限依燈數）、`random-leds` 點亮時間模式、各燈台不同數值（unitVariation）、效果說明 |
| 色彩 | 天氣啟用時：顏色來源〔天氣色盤｜自訂顏色〕、漸層方向、中途切換方向、目前天氣色票、`<details>` 備援顏色；否則：〔純色｜漸層〕、色彩／漸層編輯 |
| 串接 | 模擬模式：`SequenceEditor`（段落清單、增刪複製移動、播放規則、轉場、結尾、儲存／重新載入）；後端控制模式：`SavedSequenceView`（唯讀＋從頭播放） |
| 後端 | 播放進度；後端控制模式下：連線狀態（控制器數、燈數 × 台數、版本）、重新讀取／套用、重新播放〔串接｜單一效果〕、`MotorPanel`（送到後端，顯示實際 DMX 值）、單色測試 |
| 天氣 | `WeatherPanel`：目前天氣與來源、手動測試天氣（類別＋氣溫，10 分鐘）、立即造訪／結束造訪、色盤頁連結 |
| 物理 | 模擬模式下的 `MotorPanel`（只影響 3D 畫面）、Mid speed、Max speed、Controller rate、Camera exposure、Visual persistence、Temporal samples；「全部」視角時另有 Unit phase step、Effect frame step（有天氣時停用） |

### 3.5 視覺樣式慣例

- 深色主題：背景 `#080b11`、文字 `#eef4fb`、主色按鈕 `#65d9f8`（深色字）、焦點外框 `#ffba49`、錯誤 `#ff9d91`。
- 共用 class：`button.secondary`（次要）、`button.active`（選中）、`.segmented-control`（等寬按鈕 grid，預設 2 欄）、`.button-row`、`.control-field`（label + 值）、`.control-label`、`.control-note`（小字說明）、`.color-controls`（帶上邊框的區塊）、`.motor-row`（馬達面板的一列）。
- 新 UI 沿用以上 class，不引入 CSS-in-JS 或 UI 套件；介面文字為繁體中文，物理參數保留英文標籤。
- 無障礙：分頁用 `role=tablist/tab/tabpanel`，切換按鈕用 `aria-pressed`，按鈕群組用 `role=group` + `aria-label`，狀態訊息用 `role=status`/`alert`。

### 3.6 3D 模擬重點

- `LightTrail.useFrame`：模擬時間累加 `delta`；在曝光 + 殘影時間窗內取 `temporalSamples` 個時間點，每點計算轉角（連續）與 controller frame（離散，floor），再取樣效果 → 呈現 sample-and-hold 與動態模糊。
- 每台一段等速轉動（`RotorSegment`），轉速改變時從當下角度接續；`world-upper-half` 的相位估計 = 該影格起點的轉角 + 模擬的未知起始相位（與後端每台累加的做法一致）。
- 「全部」視角的排列是 LongN `Simulation.pde:calcMotorPosition` 推廣到 N 台（`model.ts:longnUnitPlacement`）：Processing 的 X 右、Y 朝觀眾、Z 上（初始相機 `rotateX(PI/2)`）換成 three.js 的 x、y 上、z 朝觀眾；各台頂點方向 = `rotateZ(Angle)`，比例照 LongN 的 LED_RADIUS 35 對 X 間距 297.5。5 台的頂點依序朝左、左後、右後、右前、正前（看起來是一組月相）。**需要現場確認**。
- 相機依各台範圍自動取景（`SimulationCanvas.tsx:CameraFraming`）。
- 跟隨後端：與 `liveBackendFrame` 差超過 2 影格才對齊，避免抖動。

---

## 4. 前後端連線方式

### 4.1 傳輸

- **同源 HTTP + JSON REST，以 `fetch` 呼叫，沒有 WebSocket/SSE**；即時性靠輪詢。
- 正式環境：後端 `ThreadingHTTPServer`（標準函式庫，`control.py:make_server`）在 `0.0.0.0:8765` 同時提供 `frontend/dist` 靜態檔與 `/api/*`。頁面寫死相對路徑 `/api/...`，**無 CORS、無驗證、無 token**，僅限受信任區網（Windows 防火牆只在私人網路開放 8765）。
- 開發環境：`npm run dev`，Vite 把 `/api` 代理到 `http://127.0.0.1:8765`；後端可用 `--api-only` 不送 Art-Net。
- 前端 API 用法全部集中在 `frontend/src/backendApi.ts`；錯誤時讀回應的 `{"error": "..."}`。

### 4.2 API 一覽

| Method | Path | Body / 回應 | 說明 |
|---|---|---|---|
| GET | `/api/state` | `{revision, preset, motor, hardware, output}`（見下） | 目前單一效果、馬達、硬體與輸出設定；`revision` 只計算 preset 的變更 |
| PUT | `/api/preset` | EffectPreset v2 → 完整 state | 寫入 `preset.json` 並切到單一效果模式 |
| PUT | `/api/motor` | `{"unitIds"?: [1..N], "speed"?: "stop"\|"mid"\|"max", "direction"?: "cw"\|"ccw"}` → 完整 state | 至少給 speed 或 direction；省略 `unitIds` = 全部；沒給的欄位維持原值。只存在記憶體 |
| PUT | `/api/hardware` | `{"moonCorrection": bool}` → 完整 state | 月亮校正開關，只存在記憶體 |
| GET | `/api/sequence` | `{revision, sequence, playbackMode, output:{fps,pixels,unitCount,motorRpm}}` | 讀串接 |
| PUT | `/api/sequence` | Sequence v1 | 原子覆寫 `sequence.json`，切回串接模式並從頭播放 |
| PUT | `/api/playback/restart` | `{"source":"sequence"\|"single"}` | 從第 0 影格重播，不改檔 |
| GET | `/api/playback` | `{active:false}` 或 `{active, mode, restart, fps, ageMs, frame, motor:[{speed,direction}×N], ...}` | 輸出迴圈目前位置；串接含 step/transition/ending，單一含 cycle；單色測試時附 `unitColors` |
| GET | `/api/weather` | 天氣 snapshot（見 6.4）或 `{"enabled":false}` | |
| PUT/DELETE | `/api/weather/override` | `{"category":"clear"\|"cloudy"\|"rain","temperatureC":-100..70}` | 手動測試天氣 10 分鐘（直接影響實機） |
| PUT/DELETE | `/api/weather/visit` | `{"index": n}` | 立即造訪／結束造訪 |
| GET/PUT | `/api/weather/palette` | Palette v1 | 讀／原子覆寫色盤 |
| GET/PUT/DELETE | `/api/test/units` | `{"colors":[{r,g,b}\|null × unitCount],"seconds":1..86400\|null}` | 單色測試，只在記憶體 |

`/api/state` 的三個區塊：

```text
motor:    {revision, channels:{speed:457, direction:458},
           levels:{speeds:{stop,mid,max}, directions:{cw,ccw}, rpm:{mid,max}},
           units:[{unitId, speed, direction, value, directionValue, rpm} × N]}
hardware: {colorOrder, brightness, moonCorrection, moonCorrectionDefault, pixels}
output:   {fps, pixels, unitCount, motorRpm:{mid,max}, sourceIp, targets:[{unitId, ip, universes}]}
```

PUT 規則：`Content-Type` 必須 `application/json`（否則 415）；Body 大小上限依路徑（preset 16 KiB、sequence 256 KiB、palette 16 KiB、units 4 KiB、motor 256 B、hardware 64 B、其餘 64–256 B，超過或空的 413）；驗證失敗 422 `{"error"}`；寫檔失敗 500；功能未啟用（如沒設 `[weather]`）回 404。成功回 200 與新狀態。參考系統的 `{"enabled": bool}` 馬達命令已移除（422）。

### 4.3 輪詢與同步

| 什麼 | 頻率 | 位置 |
|---|---|---|
| `/api/playback` | 每 1 秒（頁面隱藏時暫停；套用／儲存／馬達命令後立即重新輪詢） | `App.tsx` |
| `/api/weather` | 每 5 秒 | `App.tsx`、`PaletteApp.tsx` |
| `/api/test/units` | 測試期間依剩餘時間 | `UnitColorTestPanel.tsx` |
| `/api/state` + `/api/sequence` | 切到後端控制、按重新讀取，或 `/api/playback` 的 `restart` 計數改變時 | `App.tsx` |

- 前端在兩次輪詢之間用 `fps` 與 `ageMs` 自行推進後端影格（`playbackProgress.ts:liveBackendFrame`）；超過 `PLAYBACK_STALE_MS = 5000` 視為過期。
- 天氣 `generation` 改變 → 前端模擬也從頭播放（對齊後端重播）。
- 版本相容：前端把某些 API 的 404 視為「舊版後端沒有此功能」（`getBackendPlayback`、`getUnitColorTest` 回 `null`），新增 API 時沿用此模式。

### 4.4 後端對硬體

- Art-Net 只用 `stupidartnet==1.6.0`：每個 (target, universe) 一個 `StupidArtnet(ip, universe & 0x0F, 512, fps, source_address)`，`set_net(universe >> 8)`、`set_subnet((universe >> 4) & 0x0F)`；每影格對每個 universe 送一包，沒有接收確認。
- `artnet.source_ip`（現場為 `2.0.0.99`）把送出綁在 Ethernet；沒有綁定時，網路線一拔，送往 2.0.0.x（公網位址）的封包會改走 Wi-Fi 的預設閘道。
- 停止處理（`stopping.py`）：SIGINT、SIGTERM、SIGBREAK 都轉成一次 KeyboardInterrupt（之後的停止要求忽略），繼承來的「忽略 SIGINT」也會被蓋掉；Windows 上另外呼叫 `SetConsoleCtrlHandler(None, False)` 重新打開 Ctrl+C。WinSW 停止服務時送 Ctrl+C，已在現場電腦確認會送出全 0。

---

## 5. 設定檔儲存方式和格式

### 5.1 檔案總覽

| 檔案 | 格式 | 誰寫入 | 權威驗證 | 進版控 |
|---|---|---|---|---|
| `config.toml` | TOML | 人工編輯 | `config.py:load_config` | 否（範本 `backend/config.example.toml`，即 LongN 現場設定） |
| `preset.json` | EffectPreset v2 JSON | `PUT /api/preset` | `effects.validate_preset` | 否（範本 `backend/preset.example.json`） |
| `sequence.json` | Sequence v1 JSON | `PUT /api/sequence`；不存在時以目前 preset 建立 8 秒單段 | `sequence.validate_sequence` | 否（範本 `backend/sequence.example.json`） |
| `palette.json` | Palette v1 JSON | `PUT /api/weather/palette`；不存在時用內建三段 | `palette.validate_palette` | 否 |

- `preset`、`sequence`、`palette` 路徑寫在 TOML，**相對於 TOML 檔所在目錄**。
- JSON 寫入一律**原子化**：同目錄 `tempfile` → `fsync` → `os.replace`；以 UTF-8、`indent=2`、`ensure_ascii=False` 輸出正規化內容。並發編輯以最後儲存者為準。
- 驗證嚴格：多餘欄位、型別錯誤、超出範圍都拒絕；`run.py --check` 只驗證 TOML/JSON 不送出。
- **只在記憶體、重啟即消失**：馬達狀態（重啟一律停止）、月亮校正開關（重啟回到 config）、單一效果模式（重啟回串接模式）、天氣手動測試、造訪狀態、單色測試。

### 5.2 `config.toml`

```toml
[artnet]
source_ip = "2.0.0.99"     # 選填但現場建議：綁定 Art-Net 網卡

[[artnet.targets]]          # 每台一筆；unit_id 與每個 (ip, universe) 都必須唯一
unit_id = 1
ip = "2.0.0.101"
universes = [0, 1]          # 1..4 個，0..32767；也可寫單一 universe = 0（二選一）
# … unit 2–5：2.0.0.102–105

[render]
preset = "preset.json"      # 必填
sequence = "sequence.json"  # 預設 sequence.json
fps = 40                    # 1..120，預設 40
pixels = 152                # 1..170，預設 152；pixels × 3 必須小於兩個馬達 channel
unit_count = 5              # 1..9，預設 5
# unit_id = 1               # 只有單一 target 的舊寫法（[artnet] ip/universe）才用

[hardware]                  # 整段與各欄位都選填，預設即 LongN
color_order = "GRB"         # RGB/RBG/GRB/GBR/BRG/BGR
brightness = 0.4            # 0..1
moon_correction = true      # 開機時的月亮校正開關

[motor]                     # 整段與各欄位都選填，預設即 LongN
speed_channel = 457         # 1..512，1 起算
direction_channel = 458
speeds = { stop = 0, mid = 60, max = 230 }   # 0..255，必須剛好這三個 key
directions = { cw = 0, ccw = 255 }
rpm = { mid = 130, max = 500 }               # 0..10000，只用於模擬與相位估計

[weather]                   # 整段選填；省略即停用天氣
latitude = 25.0330
longitude = 121.5654
interval_minutes = 15       # 1..1440
cloud_step = 6              # 4..8，多雲時每 unit 的影格錯開
palette = "palette.json"    # 預設 TOML 同目錄的 palette.json

[[weather.visits]]          # 最多 24 個
name = "東京"               # 1..40 字
latitude = 35.6762
longitude = 139.6503
```

只接受 `[artnet]`、`[render]`，以及選填的 `[hardware]`、`[motor]`、`[weather]`；未知欄位會報錯。參考系統的 `render.rpm` 已移除（寫了會報錯），rpm 改在 `[motor].rpm`。

### 5.3 Sequence v1

```json
{
  "schemaVersion": 1,
  "ending": { "kind": "hold" },
  "steps": [
    {
      "id": 1,
      "preset": { "schemaVersion": 2, "effectId": "center-out-sine", "parameters": { "speedHz": 0.35 }, "color": { "mode": "solid", "color": { "r": 1, "g": 1, "b": 1 } } },
      "playback": { "kind": "count", "count": 1 },
      "transition": { "kind": "crossfade", "seconds": 0.5 }
    }
  ]
}
```

- `ending`：`{"kind":"hold"}`、`{"kind":"loop"}`、`{"kind":"fade-black","seconds": 1影格..10}`；舊檔沒有 `ending` 時視為 `hold`。
- `steps`：1–64 段；`id` 為不重複正整數；四個欄位缺一不可。規則見 1.6。

### 5.4 Palette v1

```json
{
  "schemaVersion": 1,
  "axis": "radius",
  "bands": [
    { "belowC": 18,   "colors": [{ "r": 0.14, "g": 0.27, "b": 0.67 }, { "r": 0.45, "g": 0.85, "b": 1 }] },
    { "belowC": 28,   "colors": [ ... ] },
    { "belowC": null, "colors": [ ... ] }
  ]
}
```

- 1–12 段，`belowC` 嚴格遞增（-100..70），**最後一段必須是 `null`**（涵蓋以上所有氣溫）；每段 2–8 色。
- `axis` 只允許 `strip`／`radius`，且只用於純色效果（漸層效果保留自己的方向）。
- 內建預設（`palette.DEFAULT_PALETTE`）：<18°C 冷色、18–27°C 中性、≥28°C 暖色。

### 5.5 部署位置（Windows）

權威來源：`backend/deploy/README.md`、`backend/deploy/install-release.ps1`。

- 程式：`C:\MoonObserve\releases\<版本>\`，`C:\MoonObserve\current` 是指向使用中版本的 junction；前端 `dist` 與 WinSW 一起打包成 `moon-observe-<版本>-windows.zip`。
- 服務：WinSW（`C:\MoonObserve\service\MoonObserve.exe` + `.xml`），帳號 `NT AUTHORITY\LocalService`、延遲自動啟動、異常結束自動重啟。
- 設定與可寫資料：`C:\ProgramData\MoonObserve\config.toml`（服務唯讀）、`preset\`（服務唯一可寫的設定資料夾）、`logs\`。TOML 的 `render.preset`、`render.sequence`、`weather.palette` 都要指到 `preset\` 底下，否則 API 存檔會失敗；首次安裝產生的 config 已經這樣設定。
- 升級不覆寫 config 與 `preset\`；新設定欄位需手動加入。升級失敗（含新版起不來）會自動回退到前一版。

---

## 6. 天氣資料取得方式

### 6.1 來源

權威來源：`backend/moon_observe_backend/weather.py`。

- [Open-Meteo Forecast API](https://open-meteo.com/en/docs)，免金鑰，標準函式庫 `urllib.request.urlopen`，逾時 8 秒（現場經 Wi-Fi）：

```
GET https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..&current=temperature_2m,weather_code&timezone=auto
```

- 只取回應的 `current` 物件：`weather_code`（int）、`temperature_2m`（需在 -100..70）、`time`（因 `timezone=auto`，是座標當地時間，無時區後綴）。
- **只有後端抓資料**；前端從不直接呼叫 Open-Meteo，而是每 5 秒讀 `/api/weather`。

### 6.2 排程

- `WeatherStore.start()` 開一條 daemon 執行緒，不阻塞 Art-Net 迴圈：
  - 當地天氣：啟動時立即一次，之後每 `interval_minutes`（預設 15）分鐘。
  - 造訪地點：每次迴圈預抓「下一個造訪地點」與「從未成功取得的地點」，並在每小時 **:58** 額外預抓，讓整點切換時有新資料。
- 失敗（網路、JSON、未知代碼、欄位型別）時**保留上一筆有效資料**，錯誤字串放在 snapshot 的 `error`；從未取得資料的造訪地點會被跳過。

### 6.3 分類規則

| weather_code | 類別 | 對效果的影響 |
|---|---|---|
| 0, 1 | `clear` | 各台同相 |
| 2, 3, 45, 48 | `cloudy` | 每台 `frameOffset = (unitId-1) × cloud_step` 影格錯開 |
| 51–57, 61–67, 71–77, 80–86, 95–99（`RAIN_CODES`） | `rain` | 效果改用雨天線條版本（`sample_effect(..., raining=True)`） |

其他代碼視為錯誤。溫度 → 色盤：`gradient_for(temperature, palette)` 取第一個 `temperature < belowC` 的段（最後一段 `null` 兜底），運行時覆蓋畫面顏色，不改寫 preset／sequence。

### 6.4 有效天氣與播放

- 有效來源優先序：**手動測試（override）> 造訪（visit）> 當地（real）**；`source` 欄位為 `override`／`visit`／`local`。
- 有效類別改變（當地更新或手動測試）→ `generation += 1` → 輸出迴圈從頭播放。只有溫度改變時不重播，色盤下一影格即生效。
- 整點造訪：依電腦本地時間（需已校時；現場電腦時區為 Taipei Standard Time），每個整點輪到清單下一個有資料的地點；色盤立即換上不重播，類別效果（多雲錯開／雨天線條）**延後到下一個段落邊界**（單一效果為下一個週期）才套用（`categoryPending`）；持續一輪播放時間後換回當地。手動測試期間跳過該整點。
- `GET /api/weather` snapshot 主要欄位：`enabled, category, temperatureC, weatherCode, observedAt, updatedAt(UTC), frameStep, color(EffectColor 漸層), generation, error, override{category,temperatureC,remainingSeconds}, real{category,temperatureC}, source, visit{name,category,temperatureC,observedAt}, visits{count,next,names}, categoryPending, thresholds`；`startPhases` 為舊前端相容欄位，一律為 0。

### 6.5 前端如何使用

- `App.tsx` 每 5 秒 `getWeatherState()`（`enabled:false` 時為 `null`，天氣分頁隱藏）。
- `LightTrail` 在本地用同一份資料模擬：`frameStep` 決定各台錯開、`category === 'rain'` 開雨天線條、`color` 經 `withWeatherPalette` 套色（遵守 `weatherPalette: false`）；有天氣時物理分頁的 Effect frame step 停用。
- 測試：`backend/tests/test_weather.py` 使用注入的 `fetch` 假資料，不連網。
