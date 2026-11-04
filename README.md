# Moon Observe × LongN

把 Moon Observe 的效果系統（effect engine、串接、天氣、3D 模擬器與控制頁）接到 **LongN** 裝置的硬體上：5 台旋轉的雙半圓燈，每條半圓 152 顆 RGB LED，每台一顆馬達，由一台 Windows 10 電腦經 Art-Net 控制。LongN 原本的 Processing 程式只保留在 `LongN/` 作為硬體對照。

```text
瀏覽器 ──HTTP（同源 /api）──▶ Python 後端（Windows 服務 :8765）──Art-Net──▶ 5 × LongN 控制盒（2.0.0.101–105）
                                         └─ 天氣：Open-Meteo                    LED：ch1–456、馬達：ch457／458
```

## 目錄

| 路徑 | 內容 |
|---|---|
| `backend/` | Python 3.12（uv）：效果渲染、LongN 封包、控制 API、天氣、定時播放、Windows 部署腳本 → [README](backend/README.md)、[部署](backend/deploy/README.md) |
| `frontend/` | React + three.js：3D 模擬器與控制頁 → [README](frontend/README.md) |
| `LongN/` | 原 Processing 程式（`*.pde`、`data/IP.ini`），只供對照硬體格式 |
| [`system-reference.md`](system-reference.md) | 系統規格（效果引擎、LongN 封包、前端、API、設定、天氣、部署位置） |
| [`PLAN.md`](PLAN.md) | 移植計畫、決策、里程碑與現場測試紀錄 |

## 開發

```bash
# 後端（repository 根目錄）
uv sync --locked --project backend
cp backend/config.example.toml backend/config.toml   # 再把 render.preset 改成 "preset.json"；沒接控制器時 targets 改成 127.0.0.1
cp backend/preset.example.json backend/preset.json   # 控制頁存檔會覆寫這份，不要直接用進版控的範例
uv run --locked --project backend python backend/run.py --config backend/config.toml

# 前端
cd frontend && npm install && npm run dev            # http://localhost:5173，/api 代理到後端
```

測試：`cd backend && uv run --locked python -m unittest discover -s tests -v`、`cd frontend && npm test`。

## 部署

現場電腦以 WinSW 服務執行，版本化 release、健康檢查與自動回退，步驟見 [`backend/deploy/README.md`](backend/deploy/README.md)。

## 現況

- 開發機上的前後端與部署流程已完成；Windows 安裝、升級、回退與「停止服務時送全 0」已在現場電腦遠端測過。
- 待現場確認：接上控制器後燈與馬達的實際反應（LED index 0 的位置、GRB 色序、順／逆方向）、5 台的實際排列、重新開機後自動啟動。
- 定時播放（每日／特殊日期時段、播一輪後休息、休息後先暖機再播放）已完成並在開發機實測；現場待確認暖機秒數是否足夠，以及重新開機後是否自動進入正確階段。
- 控制盒收不到 Art-Net 時不會自己停馬達；目前只保證程式結束時送全 0（排程的時段外會持續送全 0）。
