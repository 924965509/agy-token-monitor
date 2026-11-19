# 🚀 Antigravity Token 速度与额度监控 (`agy-token-monitor`)

专为 **Google Antigravity 2.0** 打造的原生右侧边栏（Sidecar Auxiliary Pane）实时监控插件。零外部依赖，直接解析本地 `transcript.jsonl` 与 SQLite `conversations/<id>.db`，实时展示 **扣除首字延迟（TTFT）后的纯生成速度 (`tok/s`)**、**端到端等效速度**、**上下文水位**、**前缀缓存命中率** 以及 **📅 全工作区每日额度日历看板**。

---

## ✨ 核心特性

1. **⚡ 双口径速度测算（剥离首字延迟 TTFT vs 端到端速度）**
   - 自动结合 `~/.gemini/antigravity/conversations/<sessionId>.db` (`gen_metadata` & `steps` 表) 与 `transcript.jsonl`：
   - **纯生成速度 (`decodeTokPerSec`)**：剥离每次请求的 Prompt 预填充、KV Cache 加载与网络握手延迟（TTFT），还原模型真实的流式解码速度。
   - **端到端等效速度 (`e2eTokPerSec`)**：含首字延迟的完整步骤耗时速度，支持顶部按钮一键切换口径。
   - **思考 / 正文 Token 拆分**：精确拆分每一步的 `思考 Token (Thinking)` 与 `正文/工具调用 Token (Text)`。

2. **📅 每日额度日历看板（全工作区汇总）**
   - 自动扫描并聚合 `~/.gemini/antigravity/brain/*` 下所有历史会话的每日 Token 消耗，并持久化归档至 `~/.gemini/antigravity/token_daily_history.json`。
   - **月历网格热力图（周一 ~ 周日）**：按日展示总吞吐量（或切换为仅「新增输入+输出」的净消耗）、活跃会话数与响应步数。
   - **当日账单明细**：点击日历任意日期，底部即时展开当日 `总吞吐 / 净消耗 / 新增输入 / 缓存命中 / 模型输出` 及 **各模型消耗占比**。

3. **📊 实时上下文水位、Orchestrator 双阶段追踪与缓存命中率趋势图**
   - 双轴 SVG 趋势图：同屏展示最近 28 步的生成速度柱状图与上下文窗口水位折线；对 `Orchestrator` 模式按 **规划 (`plan` 靛蓝)** / **执行 (`exec` 青绿)** / **复盘 (`review` 紫金)** 自动分段着色。
   - 彩色模型胶囊标签：自动识别 `Orchestrator`（紫金渐变徽章 + 阶段/引擎/交棒状态子徽章，兼容 `Hydrogen` / `Flash` 执行引擎）、`Gemini 4 Neon`、`Gemini 4 Hydrogen`、`Gemini 4 Carbon`、`Gemini 4 Pro`、`Gemini Flash`、`Claude` 等全部新旧模型。

---

## 📦 给朋友的一键安装指南

### 方式一：一行命令自动安装（推荐）

打开终端（Terminal），运行以下命令即可直接安装到 Antigravity 全局插件目录：

```bash
mkdir -p ~/.gemini/config/plugins && git clone https://github.com/924965509/agy-token-monitor.git ~/.gemini/config/plugins/agy-token-monitor
```

或者直接执行一键安装脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/924965509/agy-token-monitor/main/install.sh | bash
```

### 方式二：日后更新插件

```bash
git -C ~/.gemini/config/plugins/agy-token-monitor pull
```

---

## 🖥️ 在 Antigravity 中启用与打开

1. **启用插件与 Sidecar**：
   - 安装完成后，在 Antigravity 的 **Plugins（插件管理）** / **Automations（后台服务）** 中确认 `Token 速度与额度监控 (agy-token-monitor)` 已开启。
2. **呼出右侧监控面板**：
   - 在任意聊天窗口对 Antigravity 说：**`打开 Token 速度监控`**，点击 AI 回复中的 `[Token 速度监控]` 胶囊即可在右侧辅助栏（Aux Pane）固定打开。
3. **独立浏览器模式（可选）**：
   - 也可以在终端直接以独立 Web 服务模式启动，在任意浏览器中查看：
     ```bash
     node ~/.gemini/config/plugins/agy-token-monitor/sidecars/monitor/main.mjs --standalone 3299
     ```
     然后访问 `http://127.0.0.1:3299`。

---

## 📂 目录结构

```text
agy-token-monitor/
├── plugin.json                      # 插件元数据清单
├── install.sh                       # 一键安装/更新脚本
├── assets/
│   └── logo.svg                     # 插件图标
├── skills/
│   └── token-monitor/
│       └── SKILL.md                 # AI 呼出侧边栏与 CLI 统计技能指引
└── sidecars/
    └── monitor/
        ├── sidecar.json             # Sidecar 守护进程与 Aux Pane 视图声明
        ├── main.mjs                 # 后端数据解析引擎 (transcript.jsonl + SQLite protobuf)
        └── index.html               # 前端实时看板 (KPI + 日历热力图 + 趋势图 + 步骤明细表)
```
