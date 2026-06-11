# LLM Usage Dashboard

> 一次看到 **Codex (OpenAI)**、**Claude Code (Anthropic)** 與 **Antigravity (Google)** 的訂閱用量、剩餘額度與重置時間，以及各專案的 token 消耗與預估花費。支援 Electron 桌面視窗與 **CMD 終端模式**（`--cli`），資料只讀你自己電腦上的檔案、不上傳任何雲端。

[![npm version](https://img.shields.io/npm/v/llm-usage-dashboard.svg)](https://www.npmjs.com/package/llm-usage-dashboard)
[![node](https://img.shields.io/node/v/llm-usage-dashboard.svg)](https://nodejs.org)
[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)](#)

---

## ⚡ 一行安裝

只要電腦有 [Node.js](https://nodejs.org)（你在用 Codex CLI / Claude Code，通常都已經有了）：

```bash
# 不安裝，直接執行（桌面 GUI）
npx llm-usage-dashboard

# 或裝成全域指令
npm i -g llm-usage-dashboard
llm-usage-dashboard

# 🆕 終端模式（不需 Electron，純 CMD 輸出）
llm-usage-dashboard --cli
```

> GUI 模式首次執行會自動下載 Electron（約 100MB+），之後啟動就很快。
> 終端模式（`--cli`）不需要 Electron，任何有 Node.js 的環境都能直接使用。

📦 npm 套件頁：<https://www.npmjs.com/package/llm-usage-dashboard>

---

## 📊 它顯示什麼

| 區塊 | 內容 |
|------|------|
| **總覽** | 本月預估花費、本月總 tokens、累計花費 |
| **Codex 卡片** | 5 小時 / 每週額度（官方精確 `used_percent` + 重置倒數）、方案、今日 / 本月 tokens、本月花費估算 |
| **Claude Code 卡片** | 5 小時區塊 / 近 7 天用量（依 token 記錄重建）、方案、今日 / 本月 tokens、本月花費估算 |
| **Antigravity 卡片** | 方案、Prompts / Flows 點數額度、各模型配額進度條與重置倒數 |
| **近 14 天圖** | 每日 Codex / Claude / Antigravity tokens 堆疊長條圖 |
| **各專案用量** | 每個專案（依工作目錄）的來源、累計 / 本月 tokens、本月花費、最後活動時間 |

### 重點功能

- 🔒 **純本機、不連網**：只讀取你電腦上 Codex / Claude Code 自己產生的紀錄檔，不上傳、不需 API key。
- 🟢 **Codex 額度為官方精確值**：直接讀取 Codex 寫入的 `rate_limits`（5 小時與每週的 `used_percent` + 重置時間）。
- 📈 **各專案分項**：自動依工作目錄歸戶，看出哪個專案吃掉最多額度。
- 💵 **花費估算**：依模型單價把 token 換算成約略美金成本（訂閱制非實際帳單，僅供參考）。
- ▶️ **一鍵啟動**：每張卡片的「▶ 啟動」按鈕（與系統匣 Launch 選單）可直接開啟 Codex / Claude / Antigravity。
- 📴 **Antigravity 離線快取**：IDE 沒開時面板改顯示上次成功讀取的額度（標示「快取」與時間），不再一片空白。
- 🔄 **常駐 + 自動更新**：縮到系統匣常駐，檔案變動即時刷新，另每 5 分鐘自動拉取一次。
- 🚀 **開機自動啟動**：一個勾選即可隨 Windows 開機背景啟動。
- 💻 **CMD 終端模式**：加上 `--cli` 即可在任何終端直接輸出 ANSI 彩色 Dashboard，不需要 Electron。

---

## 🖥 使用方式

### GUI 桌面模式（預設）

1. 執行 `npx llm-usage-dashboard`（或全域安裝後執行 `llm-usage-dashboard`）。
2. 主視窗開啟，立即看到所有用量。
3. **關閉視窗 = 縮到系統匣**（不會結束）。點系統匣圖示可再開啟。
4. 系統匣圖示右鍵選單：
   - **Open Dashboard** — 開啟主視窗
   - **Refresh now** — 立即重新整理
   - **Launch** — 直接啟動 Codex / Claude / Antigravity
   - **Start with Windows** — 開機自動啟動開關
   - **Open data folders** — 開啟 Codex / Claude 的資料夾
   - **Quit** — 結束程式

### 💻 CMD 終端模式

不想裝 Electron？只要加上 `--cli` 就能在 CMD / PowerShell / Terminal 直接看到完整 Dashboard：

```bash
# 任選一種
llm-usage-dashboard --cli
npx llm-usage-dashboard --cli
npm run cli                     # 在專案目錄內
```

終端模式會輸出 ANSI 彩色的 Dashboard，包含進度條、14 天 bar chart、專案表格等，與 GUI 顯示同樣的資料。

---

## 🔧 需求

- **Node.js 18 以上**（執行 `node -v` 確認）
- Windows / macOS / Linux 桌面環境
- 電腦上有在使用 **Codex CLI** 或 **Claude Code**（否則沒有可顯示的資料）

### 資料來源

| 工具 | 讀取路徑 |
|------|----------|
| Codex (OpenAI) | `~/.codex/sessions/**/rollout-*.jsonl` |
| Claude Code (Anthropic) | `~/.claude/projects/**/*.jsonl` |

> 同時涵蓋 CLI 與桌面版 —— 兩者共用同一份本機檔案。

---

## ❓ 常見問題

**Q：會用掉我的 API 額度嗎？需要 API key 嗎？**
不會、也不需要。它只是讀取你本機既有的紀錄檔來統計，完全離線運作。

**Q：Claude 的額度為什麼是「估算」？**
Anthropic 沒有把官方配額數字寫進本機檔案，所以 Claude 的 5 小時 / 每週是依 token 紀錄重建的估算視窗；Codex 則因為官方有寫入 `rate_limits`，顯示為精確值。

**Q：花費金額準確嗎？**
訂閱制不是按 token 計費，所以金額僅為依模型單價換算的**參考值**，非實際帳單。

**Q：執行 `llm-usage-dashboard` 沒反應？**
改用 `npx llm-usage-dashboard`（有時全域 bin 目錄不在系統 PATH 中）。

**Q：不想安裝 Electron，可以用嗎？**
可以！加上 `--cli` 參數即可使用純終端模式：`llm-usage-dashboard --cli`，只需要 Node.js，不會下載 Electron。

---

## 📜 授權與隱私

- 本工具在**你的電腦本機**執行，所有用量資料**不會離開你的裝置**。
- 顯示的花費為估算值，僅供參考，不代表實際帳單。

---

<sub>本頁為 LLM Usage Dashboard 的安裝與使用說明。安裝請見上方「一行安裝」，或前往 <a href="https://www.npmjs.com/package/llm-usage-dashboard">npm 套件頁</a>。</sub>
