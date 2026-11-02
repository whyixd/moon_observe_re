# 40 FPS Rotating LED Effect：硬體可行性與實作規劃

> 硬體可行性歷史文件；其中的 backend 階段與 WLED 控制方案不代表現行實作。現行實作請見 [backend README](../README.md)。

## Confirmed architecture

- 一台 Raspberry Pi 5 2GB 產生 LED content，透過 wired Ethernet / Art-Net 控制 9 個 units。
- 每個 unit 使用一台 Gledopto GL-C-616WL（ESP32/WLED Ethernet controller）。
- 每個半圓有 156 顆燈（燈帶密度 144 LED/m），兩個半圓接收相同訊號；backend 每組只需一份 156 像素 frame。GL-C-616WL 提供 GPIO16、GPIO2 兩路 addressable data output，實際使用單路訊號分岔或雙路鏡像於 commissioning 確認。
- 每個 unit 的 SAMD21 只負責 relay、motor power sequence、PWM 與 motor safety。
- Motor target 為 360 RPM，LED network update 固定為 40 FPS。
- 不再要求呈現清晰 POV square；目標改為利用動態模糊、sample-and-hold 與 temporal aliasing 形成可設計的視覺效果。

> 原始 `led_spin_display_codex_spec.md` 保留作為 requirement history，其中的 high-angular-resolution square POV 不再是 acceptance criterion。

## Feasibility conclusion

新目標可行。40 FPS 是 WLED realtime streaming 文件所描述的合理 operating point；在每台 GL-C-616WL 控制 1–3 Art-Net universes 的前提下，Raspberry Pi、Gigabit Ethernet 與 ESP32/WLED 不再需要承擔 kHz 級 frame rate。

效果的核心不是「每個角度精準換圖」，而是讓一個 LED frame 保持 25 ms，同時 rotor 連續旋轉。每次 Art-Net update 之間，rotor 會旋轉 54°，因此每個 frame 會形成寬廣的弧形/扇形光跡。實際 RPM error、controller latency 與 unit phase difference 可成為效果的一部分，也可在 simulator 內參數化。

軟體模擬可在無硬體時高可信度驗證 geometry、frame cadence、aliasing、相對亮度、camera exposure blur 與多 unit choreography；但無法取代最終硬體對 absolute brightness、LED electrical timing、brush signal integrity、真實 camera sensor response、mechanical vibration 與安全性的驗證。

## 40 FPS / 360 RPM kinematics

```text
rotation_rate       = 360 RPM = 6 revolutions/s = 2160°/s
controller_period   = 1 / 40 FPS = 25 ms
angle_per_frame     = 2160°/s * 0.025 s = 54°
frames_per_rotation = 40 / 6 = 6.6667
```

因為 54° 與 360° 的 greatest common divisor 是 18°，在理想的 360 RPM / 40 FPS 下會出現：

- 20 個 discrete update phases；
- 20 frames = 0.5 seconds；
- 0.5 seconds 內 rotor 完成 3 revolutions；
- 第 21 frame 回到相同 nominal angular phase。

這個 20-phase / 3-revolution cycle 是新的主要設計單位。實際 RPM 若不是精確 360，cycle 會緩慢漂移並形成 beat/moire，simulator 應允許設定 RPM error 與 jitter。

## Art-Net load at the new target

RGB ArtDmx 每個 universe 使用 510 channels，可容納 170 RGB pixels。每組目前規劃 156 個邏輯像素，兩個半圓共用同一份資料，因此只需 1 個 universe、每 frame 468 channels；9 組於 40 FPS 共 360 packets/s。WLED 文件支援多 universe，並建議在約 40 FPS 時使用不超過 3 universes 作為流暢 streaming 的實務範圍。

```text
packets_per_second = 40 FPS * 9 units * universes_per_unit
```

| Universes per unit | RGB pixels per unit | Total ArtDmx packets/s | DMX payload bandwidth |
| ---: | ---: | ---: | ---: |
| 1 | 170 | 360 | 1.47 Mbit/s |
| 2 | 340 | 720 | 2.95 Mbit/s |
| 3 | 510 | 1,080 | 4.42 Mbit/s |

表中是每個 universe 以 512-byte payload 計算的容量上限示例，並非目前 156 像素的實際封包長度。現行配置每個封包為 468 DMX bytes，9 組於 40 FPS 的 DMX payload 約 1.35 Mbit/s（不含 Art-Net/UDP/IP/Ethernet overhead）。主要驗證點是 GL-C-616WL 的實際 WLED build、共用訊號輸出 timing、跨 unit skew 與 timeout behavior。

## Proposed visual effects

### 1. Sector smear

每個 25 ms frame 固定一組 radial LED colors/length。Rotor 在 frame hold 期間旋轉 54°，自然產生扇形光跡。可以逐 frame 改變 radial length，形成呼吸、花瓣或波紋。

### 2. Twenty-phase loop

為 20 個 update phases 設計固定 palette/shape sequence，0.5 秒後重複。這能產生可預測的三圈合成圖形，不要求每圈單獨閉合。

### 3. Temporal color mixing

相鄰 frames 使用不同 RGB colors；camera exposure 或人眼 persistence 會將其混合。Simulator 必須在線性 HDR color space 累積，再 tone-map 到 display，避免直接在 sRGB 相加造成錯誤。

### 4. Multi-unit phase choreography

9 個 units 可配置固定 time offset 或 palette offset，例如每 unit 相差 1/9 cycle。Baseline 不要求 rotor mechanically phase-locked；若需要可重複的空間同步，再加入 Hall/encoder telemetry。

### 5. Controlled drift

在 simulator 中加入 ±RPM error、frame jitter、per-controller latency 和 packet drop，預覽實機可能出現的緩慢 rotation、beat 與不規則 blur，並找出視覺上仍可接受的參數區間。

避免快速高對比 strobe 作為預設效果；frontend 應對高閃爍 preset 顯示 photosensitivity warning。

## GL-C-616WL configuration baseline

| 項目 | Baseline |
| --- | --- |
| Network | Wired Ethernet；固定 DHCP reservation 或 static mapping |
| WLED mode | Art-Net input、Multi RGB |
| Update rate | 40 FPS / 25 ms |
| Universe budget | Target ≤ 3 universes/controller |
| Outputs | 兩個半圓共用 156 像素訊號；GPIO16/GPIO2 的實際接法與鏡像方式於 commissioning 確認 |
| LED type | 必須記錄 exact chipset、color order、RGB/RGBW |
| Timeout | 已選擇 resume WLED local effect；preset/亮度/timeout 留待 P4 決定並實測 |
| ArtSync | 未確認，不列為 baseline dependency |
| Power | 5/12/24 V 依 strip；15 A total、10 A max/channel，另驗證 fuse/wire/brush |

Raspberry Pi 每 25 ms 建立同一 logical tick 的 9-unit frame batch。即使沒有 ArtSync，也應在最短時間內連續送出各 node 的 packets，並記錄 send span。Simulator 用 `controllerLatencyMs`、`interUnitSkewMs` 與 `frameJitterMs` 模擬這些差異。

## Phase synchronization policy

新的 baseline 不要求 rotor phase feedback：

- LED effect 依 wall-clock 40 FPS 執行；
- 每個 motor 以 SAMD21 維持 nominal 360 RPM；
- unit 間 phase drift 被視為可接受或刻意使用的視覺變化。

如果未來的效果要求「每次播放都在同一機械角度出現」或 9 units 鎖相，才加入 Hall/encoder 與 timestamped RPM/index telemetry。這是 optional upgrade，不阻擋第一版軟體模擬與 40 FPS effect design。

## Backend modules

```text
backend
├── config           # Units, WLED IPs, universes, pixels, outputs, safety limits
├── patterns         # 20-phase loops, radial profiles, palettes
├── renderer         # Pattern tick -> per-unit pixel buffers
├── scheduler        # 40 FPS absolute-deadline loop
├── artnet           # ArtDmx encode/send, sequence and timeout handling
├── diagnostics      # Send span, jitter, drops, node/WLED health
├── simulation_io    # Shared preset/schema export for frontend simulator
└── api              # Frontend configuration/diagnostics boundary
```

Backend 與 simulator 共用 JSON-compatible schema，不共用 WebGL/React code。Frontend effect contract 目前使用 `schemaVersion`、stable `effectId`、numeric `parameters` 與 v2 `color`（純色或 gradient），effect time 固定由 `controllerFrame / controllerFps` 推導。Backend 應依相同 normalized diameter coordinate 與 golden vectors 實作 pure renderer，確保 simulator preview 與 Raspberry Pi ArtDmx payload 對同一 tick 產生相同 pixel values。

## Revised implementation phases

以下階段是早期可行性規劃，已由目前的最小 Art-Net backend 取代；現行實作請見 [backend README](../README.md)。

### Phase 0 — Freeze display parameters

- 確認每條 strip 的 exact chipset、RGB/RGBW、pixel count、voltage、color order。
- 確認兩半圓的訊號分配方式與接線方向，以及每 unit 的單一 universe map。
- 記錄 9 台 GL-C-616WL 的 MAC/IP、hardware revision 與 WLED version。
- 定義 simulator camera、exposure、persistence 與 default scene dimensions。

Exit criteria：硬體設定與 simulator preset schema 均有版本化範例。

### Phase 1 — No-hardware simulator MVP

- 實作 360 RPM continuous rotation 與獨立的 40 FPS LED sample-and-hold clock。
- 顯示單一 radial LED strip、sector smear 與 20-phase loop。
- 提供 camera exposure integration、afterimage decay、bloom、RPM/frame controls。
- 使用 deterministic fixed timestep，輸出 repeatable screenshots。

Exit criteria：角度與 cadence unit tests 通過；0.5 秒後 nominal phase 正確重合；截圖能清楚顯示 54° frame sectors。

### Phase 2 — Effect authoring

- 實作 radial length、palette、20-frame sequence 與 9-unit offsets。
- 加入 frame jitter、RPM error、controller latency、drop simulation。
- 建立至少三個 reference presets：sector fan、temporal color mix、multi-unit wave。
- 匯出/匯入 versioned JSON preset。

Exit criteria：相同 seed/preset 產生相同 reference frames，且能比較 ideal 與 degraded mode。

### Phase 3 — Raspberry Pi 40 FPS renderer

- 以 simulator golden vectors 實作 pure backend pattern renderer。
- 建立 monotonic-clock 40 FPS scheduler 與 ArtDmx encoder。
- 提供 dry-run/packet-capture mode，不需要 controllers 即可驗證 universe payload、sequence 與 send cadence。
- 記錄 p50/p95/p99 scheduler jitter 與每 tick batch send span。

Exit criteria：長時間 dry-run 維持 40 FPS，payload 與 simulator golden vectors 一致。

### Phase 4 — Hardware commissioning and calibration

- 接一台 GL-C-616WL，驗證 wired Art-Net、156 像素映射、color order、兩半圓共用訊號與 timeout。
- 用 camera 實拍 stationary/rotating effect，校正 simulator exposure、bloom 與 brightness response。
- 漸進擴展至 3、9 units。

Exit criteria：simulation-to-camera difference 有記錄並形成 calibration preset。此階段不阻擋無硬體 effect prototyping，但仍是正式 deployment 前必要驗證。

## No-hardware acceptance criteria

- Simulator 明確分離 continuous rotor time 與 40 FPS controller time。
- 360 RPM / 40 FPS 時每 controller frame 對應 54° rotation。
- Nominal phase 在 20 frames / 0.5 s / 3 revolutions 後重複。
- Camera mode 以 exposure-window temporal samples 做 radiance integration。
- Persistence mode 使用可調 exponential decay，並清楚標示為視覺模型而非醫學生理模型。
- 可調整 shutter、RPM、FPS、jitter、drop、latency、LED count、radial profile 與 palette。
- 支援 single unit 與 9-unit layout。
- 相同 preset、seed、time 產生 deterministic image。
- 能匯出 screenshot、preset JSON；video export 可在第二階段加入。

## What simulation can and cannot prove

| 可在無硬體驗證 | 仍需硬體驗證 |
| --- | --- |
| Kinematics、54° sampling、20-phase cycle | GL-C-616WL actual packet/output latency |
| Pattern、palette、relative blur、camera composition | Absolute luminance、LED color calibration |
| Network jitter/drop sensitivity scenarios | Brush signal integrity、power/current behavior |
| 9-unit timing offsets and choreography | Motor vibration、RPM regulation、mechanical safety |
| Backend/simulator payload equivalence | Real camera rolling shutter/noise until calibrated |

## Sources

- [Gledopto GL-C-616WL official product page](https://gledopto.com/h-pd-86.html)
- [WLED official Art-Net/E1.31 documentation](https://github.com/wled/WLED/wiki/E1.31-DMX)
- [Art-Net 4 specification](https://art-net.org.uk/art-net-specification/)
- [Raspberry Pi 5 official specification](https://www.raspberrypi.com/products/raspberry-pi-5/)

## Rollback

本文件改變的是 display product goal 與規劃，不修改 SAMD21 runtime。若恢復 high-resolution POV square 需求，必須重新打開 kHz controller/phase-synchronization feasibility，不得直接沿用本 40 FPS baseline。
