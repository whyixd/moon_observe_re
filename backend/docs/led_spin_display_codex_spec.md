# LED Spin Display Prototype Spec

## 1. 專案目標

建立一個**無任何旋轉位置感測器**的簡易 POV（Persistence of Vision）LED Spin Display prototype。

目前硬體條件：

- 馬達固定目標轉速：**360 RPM**
- 等效轉速：**6 RPS**
- 一圈時間：約 **166.67 ms**
- 兩條等長 LED 燈條呈 **90° 十字交叉**
- 兩條 LED 燈條共用**完全相同的控制訊號**
- 無 Hall sensor、encoder、IR sensor、IMU 等位置感測器
- 第一階段只需要顯示簡易幾何圖形
- 優先實作：**純色實心正方形**

---

## 2. 核心原理

旋轉中的 LED 燈條視為一條「徑向掃描線」。

控制器依據時間估算目前角度：

```text
angle = angular_speed × elapsed_time
```

360 RPM：

```text
360 RPM = 6 revolutions / second
1 revolution = 166.67 ms
90° = 41.67 ms
```

因為兩條 LED 相差 90°，且共用相同資料，因此只適合自然顯示具有 **90° 旋轉對稱性**的圖形。

例如：

- 圓
- 同心圓
- 正方形
- 方框
- 十字
- 四瓣對稱圖形

不適合：

- 文字
- 箭頭
- 三角形
- 任意圖片
- 不具有 90° 旋轉對稱性的圖案

---

## 3. 正方形顯示邏輯

以旋轉中心為正方形中心。

假設正方形半邊長為 `a`，當 LED 掃描線位於角度 `theta` 時，從中心到正方形邊界的距離：

```text
r_max = a / max(abs(cos(theta)), abs(sin(theta)))
```

控制每一顆 LED：

```text
if led_radius <= r_max:
    LED = target_color
else:
    LED = off
```

因此：

- 0° 時點亮半徑較短
- 45° 時點亮半徑最長
- 90° 時回到較短
- 每 90° 重複

正方形滿足：

```text
r(theta) = r(theta + 90°)
```

因此兩條相差 90° 且共用相同訊號的 LED 燈條，可以正確形成同一個正方形。

---

## 4. 建議實作方式

不需要建立完整 360° framebuffer。

只需建立一個 **0°～90° 的 radial LUT**。

例如：

```text
LUT[angle_step] = 應點亮到第幾顆 LED
```

流程：

```text
啟動
 ↓
假設馬達已達 360 RPM
 ↓
啟動固定週期 timer
 ↓
根據 elapsed time 計算 0°～90° phase
 ↓
查 LUT
 ↓
更新 LED
 ↓
41.67 ms 後重新循環
```

---

## 5. 建議角度解析度

先以 prototype 為主。

例如：

```text
90° 分成 180 steps
```

則：

```text
step angle = 0.5°
step period = 41.67 ms / 180
            ≈ 231.5 µs
```

也可以依 MCU、LED protocol 與 LED 數量調整：

```text
90 steps  → 1° / step
180 steps → 0.5° / step
360 steps → 0.25° / step
```

目標是確保：

```text
LED update time < step period
```

---

## 6. Firmware 建議結構

```text
main
 ├─ motor/display timing init
 ├─ LED driver init
 ├─ generate_square_lut()
 └─ display loop / timer callback
      ├─ update phase index
      ├─ lookup radial length
      ├─ generate LED buffer
      └─ send LED data
```

建議模組：

```text
config
 ├─ MOTOR_RPM
 ├─ LED_COUNT
 ├─ ANGULAR_STEPS
 ├─ SQUARE_SIZE
 └─ COLOR

geometry
 └─ generate_square_lut()

display
 ├─ phase_index
 ├─ update_frame()
 └─ render_radial_pattern()

led_driver
 └─ send_led_buffer()
```

---

## 7. 時序

360 RPM：

```text
1 revolution = 166.67 ms
1 quarter revolution = 41.67 ms
```

由於正方形每 90° 完全重複，因此顯示 pattern：

```text
period = 41.67 ms
frequency ≈ 24 Hz
```

注意：

- 幾何 pattern 的重複頻率約 24 Hz
- 肉眼仍可能看見 flicker
- 若之後可提高 RPM，顯示穩定度與視覺效果會改善

---

## 8. 無感測器限制

### 8.1 無法知道絕對方向

開機時不知道 rotor 的實際角度。

因此正方形可以穩定形成，但相對地面的角度不固定，例如：

```text
┌─────┐

或

◇
```

兩者都屬正常結果。

目前不需要修正此問題。

---

### 8.2 Phase Drift

Firmware 假設：

```text
motor = exactly 360 RPM
```

如果實際為：

```text
359 RPM
361 RPM
```

則 MCU 推算角度會逐漸和 rotor 實際角度分離。

結果：

- 正方形會緩慢旋轉
- 不一定立即變形

---

### 8.3 RPM Jitter

若瞬時轉速不穩：

```text
358 → 362 → 359 → 361 RPM
```

可能產生：

- 正方形邊緣扭曲
- corner 位置漂動
- 畫面呼吸
- wobble

這是無感測器架構本身的限制。

---

## 9. 第一階段實作範圍

Codex 第一版只需要完成：

1. 固定 360 RPM 時序模型
2. 0°～90° phase generator
3. 正方形 radial LUT
4. 單一純色輸出
5. LED buffer 更新
6. 可調參數：
   - LED 數量
   - 正方形尺寸
   - RGB 顏色
   - RPM
   - angular resolution
7. 提供簡單 debug 模式，可觀察：
   - phase index
   - calculated angle
   - active LED count
   - current frame period

---

## 10. 建議加入的測試模式

### Static radial test

固定點亮前 N 顆 LED：

```text
N = 25%
N = 50%
N = 75%
N = 100%
```

確認 LED indexing 正確。

### Breathing radial test

不考慮旋轉：

```text
short → long → short
```

確認高速 LED 更新正常。

### Square LUT test

輸出：

```text
0°
15°
30°
45°
60°
75°
90°
```

各角度預期的 `r_max` / active LED count。

確認 LUT 對稱：

```text
r(0°) = r(90°)
r(15°) = r(75°)
r(30°) = r(60°)
45° = maximum
```

---

## 11. 後續可能升級

第一版不要實作，但架構預留：

```text
Hall sensor / magnet
```

用途：

- 每圈取得 index
- 修正 phase drift
- 實際量測 RPM

更高階：

```text
quadrature encoder
```

用途：

- 即時角度
- 旋轉方向
- 大幅降低速度變化造成的圖形扭曲

---

## 12. 第一版完成條件

Prototype 成功條件：

- 馬達約 360 RPM 運轉
- 兩條 LED 共用相同訊號
- 可以觀察到穩定的純色正方形
- 正方形相對地面的旋轉角度不要求固定
- 短時間內圖形不可明顯扭曲
- 所有主要參數可由設定值修改

目前階段優先驗證：

> **不使用任何旋轉位置感測器，僅依靠已知 RPM 與固定 timer，是否能以兩條 90° 交叉且同訊號的 LED 燈條形成可辨識的實心正方形。**
