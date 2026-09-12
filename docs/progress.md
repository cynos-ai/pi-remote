# 开发进度与验证证据

最后更新：2026-09-12。

## 当前状态

产品和开发交接文档已编写；应用尚未实现。参考 SQL 和示例事件属于设计附件，不是已经部署的业务实现。以下应用阶段全部未开始，不能直接运行其规划的 pnpm 脚本。

已完成一轮[独立设计评审与修订](reviews/2026-09-12-design-review.md)：当时的 7 项发现已修订；后续用户要求已替换其中的预先限制，历史审核结论不能代替当前版本的验证。

随后增加 [Bash 兼容约束](bash-compatibility.md)，本轮再扩展为[整体 TUI 体验原则](tui-experience.md)：覆盖工具、资源、扩展、控制、会话和全阶段交互，只有实际问题或用户配置才增加局部限制。当前共 FR01–FR14、AT01–AT32 及两套各 8 项对照场景，应用阶段仍未开始。

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| S01 | not_started | 工程、依赖和 CI 基础 |
| S02 | not_started | 真实 pi SDK、原生能力清单及整体 TUI / Bash 基线 |
| S03 | not_started | 公共协议与事件 reducer |
| S04 | not_started | 数据库、事件和投影事务 |
| S05 | not_started | 鉴权、项目和会话 API |
| S06 | not_started | worker、调度与恢复 |
| S07 | not_started | 命令和交互桥接 |
| S08 | not_started | WSS、快照及断线回放 |
| S09 | not_started | 移动端连接、列表与历史 |
| S10 | not_started | 移动端过程、命令与表单 |
| S11 | not_started | 双端弱网与 Linux 进程故障闭环 |
| S12 | not_started | Docker 开发环境、实际故障处理、部署与备份 |
| S13 | not_started | 真实 Linux / Android / iOS 发布验收 |

## 本次设计交付的检查

初稿 [29e8026](https://github.com/cynos-ai/pi-remote/commit/29e80269e47fe2a8e93f722ab7184b439580af68) 的 [Linux 文档 CI 已通过](https://github.com/cynos-ai/pi-remote/actions/runs/34687052151)。

2026-09-12 评审修订轮，在 Windows、Python 3.12.8、SQLite 3.45.3 上执行 `python scripts/check_docs.py` 与 `git diff --check`，均通过：10 份 Markdown 及链接 / 表格，13 个阶段，12 条需求，30 个验收场景及双向阶段归属，47 个合成事件，12 张 SQLite 参考表及完整性约束，MIT 许可证。

独立代理针对修订后的 R1–R7 复核，未发现剩余阻断项；非阻断的最终命令结果存储建议也已补入 result_json。应用实现与实际 SDK / Docker / 设备验证仍未运行，不能把这次文档复核当作运行时验收。

GitHub Actions 中同一脚本在 Linux 上运行，实际结果以仓库的 Documentation checks 为准。该检查不加载 pi、不调用模型、不启动 Docker、不构建手机 App；所有应用阶段仍为 not_started。

## Bash 兼容要求修订（历史轮次）

2026-09-12，用户明确要求服务器 pi 保留与本地 TUI 相似的 Bash 使用体验。基于[上轮提交 c306439](https://github.com/cynos-ai/pi-remote/commit/c3064390322281f17cf7af1c606c2f84dd24ddcc)修订；上轮的 [Linux 文档 CI 已通过](https://github.com/cynos-ai/pi-remote/actions/runs/34688951963)。本次不沿用独立代理对旧版本的复核结论。

设计变化：默认原生 Bash、无额外命令过滤 / 审批 / 默认超时，正常后台服务可跨 Run、归档与空闲 worker 回收；前台调度串行不再被表述为整个目录只有一个 OS writer。工具错误交由 pi 继续处理，手机展示配额不改变模型结果或原生输出文件。整容器恢复只用于未完成调用结果不明的故障。

已核对固定 SDK 的 Bash、waitForChildProcess、shell 环境及活动 PID 跟踪源码；未执行 SDK / TUI / Docker / 真机兼容测试。新增 AT31 在 S02、S06、S08、S10、S12 分别验基线、生命周期、输出、手机与部署，S13 必须纳入最终验收。

Windows 本地 `python scripts/check_docs.py` 与 `git diff --check` 通过：11 份 Markdown，13 个阶段，13 条需求，31 个验收场景，8 个 Bash/TUI 对照场景，47 个合成事件及 12 张 SQLite 参考表。设计数据结构和核心事件类型未改变，沿用现有 SQL / 合成事件检查；这些结果不代表 FR13 已实现。

## 整体 TUI 体验修订

2026-09-12，用户进一步明确 Bash 只是例子，整个产品应接近本地 TUI，后续遇到真实问题再考虑限制。本轮基于 [65d5b4d](https://github.com/cynos-ai/pi-remote/commit/65d5b4df50cab9b43eaa1974aae8adbe36742797)；该基线的 [Linux 文档 CI 已通过](https://github.com/cynos-ai/pi-remote/actions/runs/34690428411)，不是本轮的测试结果。

本轮恢复原生资源默认加载、streaming 中配置 / 扩展命令、先停止再压缩、全阶段可答表单；归档仅改列表，多 Session 默认并行，无额外容量上限及默认空闲回收。旧后续队列暂停不锁新操作，空队列 ready。删除强制 host-control / restart-clean、blocked_scope_key 及容器清理证明，撤回额外 Docker 权限收紧；未知旧命令不自动重投，实际故障按具体问题处理。此前历史评审中的 R4 / R5 / R7 处置按本轮原则替换。

新增 Operation 事件投影与可空 Run 的 Interaction、初始化表单合成示例；同步 SQL 关联约束、协议、开发步骤、FR14 / AT32 和 T01–T08。Operation 保存在现有事件和 live_state 投影中，不增加数据库服务或新表。S02 建立原生能力清单并安排缺失的适配，S06 / S07 / S10 / S12 分别验运行、控制、手机及部署，S13 纳入整体对照。

已核对固定 SDK 的 prompt 扩展命令路径、setModel / setThinkingLevel、compact 及 DefaultResourceLoader / AgentSessionRuntime / SettingsManager 文档；源码核对不等于 SDK 实测。本轮独立设计评审未重新运行；应用、真实 SDK、Docker 和设备验证仍未运行。

Windows 本地使用 Python 3.12.8 / SQLite 3.45.3 执行 `python scripts/check_docs.py` 与 `git diff --check`，均通过：12 份 Markdown，13 个阶段，14 条需求，32 个验收场景及双向阶段映射，8 项 Bash + 8 项整体 TUI 对照，59 个合成事件及 12 张 SQLite 参考表。检查包含 Run / Operation 生命周期、无 Run 初始化表单、非空 / 空队列差异、同项目 Session 并行及交互的同 Session 外键；这些结果不代表应用运行时验收通过。本轮提交的 Linux 结果以对应 GitHub Actions 为准。

## 后续阶段证据模板

```text
stage: Sxx
status: in_progress | passed | blocked
commit: <实现提交>
environment: <OS / Node / SDK / 设备 / 镜像版本>
commands: <实际运行命令，删除凭据>
results: <通过 / 失败 / not_run 数量与说明>
evidence: <清洗后的报告、日志摘要、截图路径或 CI 链接>
remaining: <尚未验证的内容及原因>
decisions: <对既有设计的必要修正及依据>
next: <下一阶段>
```

本地运行生成的详细报告放 `test-results/`（默认不提交）；只将清洗后的摘要、必要截图和可公开访问的 CI 证据纳入交接。
