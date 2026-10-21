# dsh-agent-llm

把本机已登录的 **WorkBuddy**、**WorkBuddy AI**、**Hermes Agent** 三个 Agent 的大模型接入
DeepSeek Harness（DSH）的模型库。装好后在会话框右下角的模型选择器里即可直接选用，
无需在 DSH 里重新登录任何账号。

- 三个 Agent 各是一个独立的 DSH provider，出现在模型选择器中。
- 模型名称、积分倍率（`倍率 ×3.47`）、免费标记、上下文长度、输出上限、推理档位、能力标签
  均来自对应 Agent 自己的产品配置，与 Agent 内显示的信息一致。
- 请求走 Agent 官方网关/推理接口，**消耗的是对应 Agent 账号的积分/额度**，免费模型照常免费。
- 只读取本机登录态，不复制账号、不写死 token、不上传任何凭据。
- 不依赖任何 `@deepseek-ai/*` 包，只使用 DSH 公开的 `ctx.llm.registerAdapter()` 接缝；
  DSH 升级后仍可用（前提是该公开接缝不变）。

## 安装

### 通过 SkillHub 插件市场

在 DSH 的插件市场里搜索 `dsh-agent-llm`，或直接安装：

- owner：`MnemosyneOS`
- name：`dsh-agent-llm`

### 直接安装 GitHub 仓库

```powershell
dsh plugin --profile web add github:MnemosyneOS/dsh-agent-llm#<commit-sha>
```

`<commit-sha>` 用仓库 Release/Tag 对应的完整 40 位 commit。

> 安装完成后刷新一次 DSH Web 页面，浏览器才会加载新的 Client 模块（模型标签徽标）。

## 前置条件

插件本身不会替你登录 Agent，只复用它们已经保存的本地会话：

1. 本机安装并登录过 **WorkBuddy AI** 或 **WorkBuddy** 桌面端（至少一个）。
2. 或者本机安装并登录过 **Hermes Agent**（Nous 账号）。
3. Windows 10/11，DSH 与 Agent 使用同一个 Windows 用户。

三个 Agent 都没有登录时插件会保持空闲，不会报错，也不会影响 DSH 启动。

### 自动发现

插件按以下顺序自动定位 Agent，无需手工配置路径：

| 目标 | 探测顺序 |
| --- | --- |
| WorkBuddy 数据根 | `WORKBUDDY_AI_HOME` → `%USERPROFILE%\.workbuddy-ai` |
| WorkBuddy 数据根 | `WORKBUDDY_HOME` → `%USERPROFILE%\.workbuddy` |
| WorkBuddy 可执行文件 | `DSH_AGENT_LLM_WORKBUDDY_AI_EXE` / `DSH_AGENT_LLM_WORKBUDDY_EXE` → Windows 卸载表 `InstallLocation` → `%LOCALAPPDATA%\Programs\{WorkBuddyAI,WorkBuddy}` → `C:\AI_Workspace\01_Agents\...` |
| Hermes 数据根 | `HERMES_HOME` → `~/.hermes` → `~/HermesAgent/home` → `%LOCALAPPDATA%\Programs\Hermes\home` → `C:\AI_Workspace\01_Agents\HermesAgent\home`（以存在 `auth.json` 或 `config.yaml` 为准） |

装在非标准位置时，用下面的 `config` 显式指定即可。

## 使用

1. 确保对应 Agent 已登录。
2. 刷新 DSH 页面。
3. 点开会话框右下角的模型选择器，选择 `WorkBuddy AI`、`WorkBuddy` 或 `Hermes Agent` 分组。
   - 倍率直接显示在模型名里：`Fast · 倍率 ×0.34`。
   - 免费模型显示 `免费` 徽标。
   - 悬停模型名可看到完整信息（上下文、输出上限、能力、Agent 原始描述）。
4. 发送消息，请求按当前选择路由到对应 Agent，积分从该账号扣除。

### 数据来源与显示规则

| Agent | 模型清单来源 | 积分/倍率来源 |
| --- | --- | --- |
| WorkBuddy AI | `%USERPROFILE%\.workbuddy-ai\cache\acc-product-config-v3.json` | 同文件 `models[].credits` + `modelPromotions`（按 Asia/Shanghai 日期与每日时段计算生效折扣） |
| WorkBuddy | `%USERPROFILE%\.workbuddy\cache\acc-product-config-v3.json` | 同上 |
| Hermes Agent | `$HERMES_HOME\cache\nous_recommended_cache.json` + `context_length_cache.yaml`（在线时用 Nous `/v1/models` 校正） | Nous 免费层：`:free` 模型为 `免费`；付费层显示付费模型 |

WorkBuddy 的登录态在
`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop-ai.info` /
`workbuddy-desktop.info`，token 字段是 AES-256-GCM 密文；插件调用已安装的
`WorkBuddyAI.exe`（`ELECTRON_RUN_AS_NODE=1`，无窗口、只读）取得 at-rest 密钥后在本进程内解密，
**不落盘、不打印**。

Hermes 的登录态在 `$HERMES_HOME\auth.json`（`providers.nous`）。Nous access token 约 1 小时过期：
Hermes 网关运行中由 Hermes 自己续期；网关未运行时插件用同一刷新接口续期，并把轮换后的 token
原子写回 `auth.json`，保证 Hermes 之后仍可正常使用。

## 配置

通过 `cordis.patch.yml` 的 row config 覆盖（全部可选）：

```yaml
- insert:
    - id: dsh-agent-llm
      name: dsh-agent-llm
      config:
        workbuddyAi:
          enabled: true
          home: 'C:\Users\<you>\.workbuddy-ai'
          exe: 'C:\Program Files\WorkBuddyAI\WorkBuddyAI.exe'
          authFile: 'C:\Users\<you>\AppData\Local\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop-ai.info'
          appVersion: '5.8.4'
        workbuddy:
          enabled: true
          home: 'C:\Users\<you>\.workbuddy'
          exe: 'C:\Users\<you>\AppData\Local\Programs\WorkBuddy\WorkBuddy.exe'
        hermes:
          enabled: true
          home: 'C:\Users\<you>\HermesAgent\home'
          allowRefresh: true   # false = 不自动续期，仅使用未过期的 Nous token
```

环境变量覆盖：`HERMES_HOME`、`WORKBUDDY_AI_HOME`、`WORKBUDDY_HOME`、
`DSH_AGENT_LLM_WORKBUDDY_AI_EXE`、`DSH_AGENT_LLM_WORKBUDDY_EXE`。

## 升级稳定性

- 只使用 Node 内置模块 + `ctx.llm.registerAdapter()` 公开接缝，无 DSH 内部 import。
- 插件包安装在 DSH profile（`~/.dsh/profiles/<profile>`）里，DSH 本体升级不会删除它。
- WorkBuddy 模型清单读取 Agent 自己维护的缓存文件，Agent 更新模型后无需改插件。
- Hermes 读取 `auth.json` / `cache/*` 并调用稳定的 Nous 推理接口；不 import Hermes Python 模块。
- Client 端只覆盖 `conversation.input.model.label` 槽位（优先级 `-1`）；若未来槽位 API 变化，
  最坏情况是标签退化为模型名，请求与模型选择本身不受影响。

## 已知限制

- **图片不转发**：provider 声明为纯文本，DSH 会把消息中的图片替换为占位文本；模型名/描述仍按
  Agent 原始能力显示“图像输入”。
- **WorkBuddy 旧版 token 有效期较短**（约 30 天，刷新后约 60 天）。过期后打开一次 WorkBuddy
  桌面端即可自动续期；插件有意不调用 token 刷新接口，避免轮换导致桌面端掉线。
- **旧版 WorkBuddy 渠道校验兼容**：其网关会拦截系统提示中重复出现的完整品牌词
  `DeepSeek Harness`（HTTP 400 / code 11128）。旧版 provider 在发送前把该品牌词规范化为官方缩写
  `DSH`（同一段系统提示中已定义该缩写，语义不变）；WorkBuddy AI 与 Hermes 不受影响，仍原样发送。
- **Hermes 免费层只能选免费模型**：Nous 账号为免费层时，付费模型在 Agent 中也同样不可选，
  因此插件只列出可用的 `:free` 模型。
- Hermes 自动续期在“网关未运行”时才写回 token；若网关运行中 token 未刷新，请求会提示稍后重试。

## 安全与隐私

- 插件复用本机已登录会话，属于**非官方集成**；请遵守各 Agent 的服务条款，风险自负。
- token 只在 Host 进程内存中使用；日志只记录模型名、路由与消耗数值，不记录 token。
- WorkBuddy 密钥读取方式（`ELECTRON_RUN_AS_NODE` 调用官方二进制内置 binding）不修改任何 Agent
  文件，但可能被杀软/EDR 关注；企业环境可将对应 provider 设为 `enabled: false`。
- Hermes `auth.json` 仅在自动续期路径写入，且为原子替换；不希望插件改动该文件时设置
  `hermes.allowRefresh: false`。
- 插件不发起任何遥测，也不向 MnemosyneOS 或第三方上传数据。

## 诊断

```powershell
cd <插件目录>
node tests/live-smoke.mjs          # 只读：列出三个 provider 的模型与免费状态
node tests/live-smoke.mjs --live   # 用免费模型各发一次带工具调用的请求（消耗 0 积分）
node tests/dsh-e2e.mjs             # 经 DSH 本体做端到端验证（需要运行中的 dsh web）
```

## 目录

```
dsh-agent-llm/
  index.js                  Host 入口：注册 provider
  client.js                 模型标签扩展（倍率/免费徽标）
  lib/adapter.js            DSH LlmAdapter 兼容层（零依赖）
  lib/discovery.js          Agent 安装位置自动发现
  lib/wire.js               消息/工具/SSE 公共转换
  lib/workbuddy-*.js        WorkBuddy 目录、登录态、流式连接
  lib/hermes-*.js           Hermes 目录、Nous 登录态与续期、流式连接
  cordis.patch.yml          Bundle patch
  locale/{en,zh}.json       插件市场显示标题/描述
  icon.svg                  插件图标
```

## License

MIT
