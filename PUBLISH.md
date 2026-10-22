# 发布说明

本文档记录 `dsh-agent-llm` 的对外发布状态与各版本指向，便于使用者确认自己拿到的是哪一版。

## 当前对外指向

| 位置 | 引用 | 说明 |
| --- | --- | --- |
| GitHub `main` | 跟随最新提交 | 开发分支，始终与仓库根目录一致 |
| Git tag `v1.1.1` | 最新提交 | **推荐安装版本**，含全部隐私与可移植性清理 |
| Git tag `v1.1.0` | 与 `v1.1.1` 相同提交 | 保持标签与主分支一致，避免下游拉到旧内容 |
| SkillHub `MnemosyneOS/dsh-agent-llm` | 由 SkillHub 自动同步 | 约每 2 小时同步一次 GitHub 主分支 |

> SkillHub 不提供手动同步接口，记录里的 `headSha` 会滞后于 GitHub 主分支。
> 同步完成后，记录中的 `headSha` 会指向本仓库最新提交。

## 安装

```powershell
# 方式一：直接指定 GitHub 提交（推荐，版本可审计）
dsh plugin --profile web add github:MnemosyneOS/dsh-agent-llm#<完整 commit SHA>

# 方式二：通过 SkillHub 插件市场
# 在 DSH 插件市场中搜索 dsh-agent-llm（owner: MnemosyneOS，分类：模型推理）
```

## 已清理的个人信息

本仓库对外版本**不含**任何用户私有路径、用户名、工作区布局、令牌或密钥。
清理内容：

- 移除全部硬编码的本机目录（改用环境变量 + Windows 卸载表 + 通用目录扫描）
- 诊断脚本去除硬编码路径，改用环境变量
- 修复 `locale/zh.json` 的编码损坏
- 移除发布脚本（纯内部工具，不随包发布）

## 插件市场索引

仓库根目录的 `market-index.json` 是 DeepSeek Harness 插件市场格式 1 索引，
可直接作为插件市场索引源使用：

```
https://raw.githubusercontent.com/MnemosyneOS/dsh-agent-llm/main/market-index.json
```

该索引中的 `versions[].source.commit` 指向发布时的确切提交。
