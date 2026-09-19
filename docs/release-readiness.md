# 发布就绪记录

状态：`blocked`。S12 Docker 部署子集已经在 WSL 2 通过生命周期验证，完整 S12 仍需同镜像原生 TUI / Bash 对照；S13 只在所有必需阶段报告、真实 provider、原生 pi TUI 对照和 Android / iOS 实机证据齐全后才能改为 `passed`。本记录不触发任何外部发布、镜像推送或应用商店操作。

## 已完成

- S01–S12 的实现和阶段验证入口已在工作树中；旧 S12 部署子集报告曾为 30/30 checks passed；新完整阶段不沿用该结果替代原生对照。
- Docker 使用 `docker.m.daocloud.io`，npm / pnpm 使用 `https://registry.npmmirror.com`；CI 同样设置这两个国内源变量。
- `pnpm verify:S13` 检查 S01–S12 源码指纹及完整 live/parity 报告，重新执行 `pnpm test:e2e` 和设备 runner；不隐式重复付费模型调用。任何缺失、过期、失败或未运行的必需证据均不能通过。入口、采集和导入流程见[验收入口说明](acceptance-runners.md)。
- 2026-09-19 修复直接 prompt 异常结束后旧 follow_up 未暂停的问题；既有进程故障回归 9/9 通过。继续复验后，DeepSeek 的 `CMD-steer-stop-drafts` 完整场景通过：包含完整草稿、暂停旧队列、旧 target、新任务、steer 消费和 follow_up 精确副作用顺序。本地后端/诊断回归 4/4 通过。此前请求超时和断言失败的证据保留，不能据本次通过断言所有历史根因已查明；详见开发进度。完整 commands 矩阵仍缺 compact 等场景。

- 2026-09-19 修复 compact 保留原生队列时旧 Run 被强制记为 aborted 的问题。DeepSeek 的原生队列/摘要/后续文件对照与摘要生成前取消对照分别通过；本地后端回归 8/8、验收报告测试 22/22 通过。完整 compact 矩阵仍需摘要流中断、其他队列/扩展及交互式 TUI 对照，详见[开发进度](progress.md)。

## 当前尚未满足

- 真实 provider：2026-09-19 已验证 DeepSeek 单模型的工具调用、thinking、基础后端命令、控制、compact 队列/生成前取消及断线回放子集；仍需第二个不同模型、完整控制/交互和 compact 矩阵、重试及长时间开发验证。旧 ID `deepseek-v4-flash` 实际由官方映射到 V4.1-Flash。首次实时测试失败原因未定，定向复验通过；详情和证据见[开发进度](progress.md)。
- 原生 TUI：在相同 Linux、SDK、资源和配置下完成 T01–T08 / B01–B08 对照。确定性 SDK 与 `/bin/bash` smoke 不能代替交互 TUI。
- Android / iOS：安装实际构建，在两平台分别完成配对、历史、命令、表单、锁屏后台恢复、弱网和双设备流程；需要设备可访问的 HTTPS/WSS 后端。
- 移动端差异：附件已接通 Expo 系统文件选择器、Session 归属校验和二进制上传；仍需在 Android / iOS 真机验证权限、弱网与后台恢复。终端专用 custom renderer 仍需按原生 API 完成入口或结构化回退，并补对应真机证据；当前不会静默丢弃输入。

## 验收顺序

1. 按[验收入口说明](acceptance-runners.md)生成逐项清单；在运营者私有环境配置 live provider、两个模型、测试项目和明确的顶层操作数和 provider 侧费用预算；执行 `pnpm test:live -- --suite sdk` 及必要的 live suites。
2. 在同一 Linux 环境完成 `pnpm test:bash-parity` 和 `pnpm test:tui-parity` 的真实基线，保存清洗后的报告。
3. 使用已构建的 Android / iOS 安装包和设备可访问的 HTTPS 地址执行 `pnpm test:device -- --platform android` 与 `pnpm test:device -- --platform ios`；网络切换、锁屏和双设备观察必须保留实际证据。
4. 重新运行受影响的 `pnpm verify:Sxx`、`pnpm test:e2e` 和 `pnpm verify:S13`。只有报告没有 `failed` / `not_run`、安装和恢复说明与行为一致时，才可由运营者决定是否发布。

所有凭据、设备 token、个人 pi 目录、真实会话、SQLite 文件和未清洗日志均不得提交；本机专用配置保存在 Git 忽略的 `.env` / `test-results` 中。正式发布时应保存在运营者私有配置目录。

## 2026-09-18 汇总复验

本轮 runner 合同 17/17、新后端 runner 的真实进程/确定性模型回归 2/2、原有实际进程 E2E 均通过。`verify:S02` 为 blocked（10 passed / 3 not_run）；`verify:S13` 为 failed（2 passed / 11 failed / 16 not_run），11 个失败项来自旧阶段报告缺少当前源码指纹，而非据此判定产品功能故障。全部阶段尚未在本轮源码重跑，真实模型、原生对照、设备证据亦未补齐，不可发布。详细命令及证据见[开发进度](progress.md)。
