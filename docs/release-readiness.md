# 发布就绪记录

状态：`blocked`。S12 Docker 交付已经在 WSL 2 通过完整生命周期验证；S13 只在所有必需阶段报告、真实 provider、原生 pi TUI 对照和 Android / iOS 实机证据齐全后才能改为 `passed`。本记录不触发任何外部发布、镜像推送或应用商店操作。

## 已完成

- S01–S12 的实现和阶段验证入口已在工作树中；S12 的 `test-results/s12/report.json` 最近一次为 30/30 checks passed。
- Docker 使用 `docker.m.daocloud.io`，npm / pnpm 使用 `https://registry.npmmirror.com`；CI 同样设置这两个国内源变量。
- `pnpm verify:S13` 会检查 S01–S12 报告、重新执行 `pnpm test:e2e`，并调用 live / TUI / Android / iOS runner。任何缺失报告、失败或未运行外部证据都会以非零退出结束。

## 当前尚未满足

- 真实 provider：至少两个实际可用模型，其中一个能返回 thinking；需要完成 prompt、工具、切模型、thinking、compact、重试和长时间开发验证。
- 原生 TUI：在相同 Linux、SDK、资源和配置下完成 T01–T08 / B01–B08 对照。确定性 SDK 与 `/bin/bash` smoke 不能代替交互 TUI。
- Android / iOS：安装实际构建，在两平台分别完成配对、历史、命令、表单、锁屏后台恢复、弱网和双设备流程；需要设备可访问的 HTTPS/WSS 后端。
- 移动端差异：附件已接通 Expo 系统文件选择器、Session 归属校验和二进制上传；仍需在 Android / iOS 真机验证权限、弱网与后台恢复。终端专用 custom renderer 仍需按原生 API 完成入口或结构化回退，并补对应真机证据；当前不会静默丢弃输入。

## 验收顺序

1. 在运营者私有环境配置 live provider、两个模型、测试项目和受限请求预算；执行 `pnpm test:live -- --suite sdk` 及必要的 live suites。
2. 在同一 Linux 环境完成 `pnpm test:bash-parity` 和 `pnpm test:tui-parity` 的真实基线，保存清洗后的报告。
3. 使用已构建的 Android / iOS 安装包和设备可访问的 HTTPS 地址执行 `pnpm test:device -- --platform android` 与 `pnpm test:device -- --platform ios`；网络切换、锁屏和双设备观察必须保留实际证据。
4. 重新运行受影响的 `pnpm verify:Sxx`、`pnpm test:e2e` 和 `pnpm verify:S13`。只有报告没有 `failed` / `not_run`、安装和恢复说明与行为一致时，才可由运营者决定是否发布。

所有凭据、设备 token、个人 pi 目录、真实会话、SQLite 文件和未清洗日志都留在仓库外。
