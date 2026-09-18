# 2026-09-15 代码审核修复记录

对应[审核报告](2026-09-15-code-review.md)的 R01–R16。修复基于原未提交工作树，没有重置或覆盖原实现，也没有提交、推送。原审核报告保留为修复前事实。

## 实现与回归映射

| 问题 | 修复内容 | 主要测试 |
| --- | --- | --- |
| R01 | 流式消息按 start/update/end 关联同一 ID，释放已结束内容跟踪 | tests/sdk/worker-review.test.ts |
| R02 | 根据最终 assistant outcome 判定失败/取消；覆盖原生重试和非致命工具失败 | tests/sdk/worker-review.test.ts；tests/e2e/real-process.test.mjs |
| R03 | clearQueue 同步回调不再误报消费，返回完整输入；compact 保留原生队列路径 | tests/sdk/worker-review.test.ts；tests/commands/commands.test.ts |
| R04 | 保留未跨 IPC 的合法 follow_up，故障后暂停，不自动重投未知任务 | tests/commands/commands.test.ts；tests/e2e/real-process.test.mjs |
| R05 | 严格逐行 JSON/身份/引用校验；损坏历史在 SDK open 前拒绝 | tests/runtime/session-history-review.test.ts |
| R06 | 初始化传递持久状态及 pi ID；未落盘同 ID 路径可恢复，持久文件不重建；按实际文件核实落盘 | tests/runtime/session-history-review.test.ts；tests/runtime/runtime.test.ts；tests/sdk/worker-review.test.ts |
| R07 | 用户 Bash 独立 Operation、增量及最终输出、退出码/取消；可与模型同时运行 | tests/sdk/worker-review.test.ts；tests/e2e/real-process.test.mjs |
| R08 | 映射先确认再运行 hooks；合法初始化表单豁免 ready 截止时间，仍检测失联 | tests/runtime/runtime.test.ts；tests/e2e/real-process.test.mjs |
| R09 | 生产 worker 使用实际 runtime，持久替换意图与映射；新旧 Session 回调分属各自 Operation；无请求内容和自主 Run 可见 | tests/runtime/session-history-review.test.ts；tests/runtime/runtime.test.ts；tests/sdk/worker-review.test.ts；tests/e2e/real-process.test.mjs |
| R10 | 标准 UI 事件、编辑器请求/ACK、Snapshot notices、延迟 hook 独立子操作；不能等价呈现的终端函数有明确提示 | tests/sdk/worker-review.test.ts；tests/mobile/editor-sync.test.ts；tests/mobile/extension-ui.test.ts；tests/api/api.test.ts |
| R11 | 实际 SDK 模型目录/思考等级、刷新与缓存；读取初始化 snapshot 不等待 hook | tests/runtime/session-history-review.test.ts；tests/runtime/runtime.test.ts；tests/mobile/api.test.ts |
| R12 | EventStore 分配有效配置版本；标题同步意图及匹配 ACK，防止过时回声覆盖 | tests/storage/persistence-performance.test.ts；tests/runtime/runtime.test.ts |
| R13 | 手机发送前保存原请求和键，重启仍按原身份确认；控制命令不依赖编辑器同步 | tests/mobile/cache.test.ts |
| R14 | 大 IPC 消息落盘转交；完整结果在事件入库前保存 artifact；预览明确截断，HTTP/Range/WSS 引用一致 | tests/runtime/output-archive.test.ts；tests/runtime/output-archive-http.test.ts |
| R15 | 写增量不读取全部历史正文；批处理只复制一次活动投影，更新受影响 SQL 行；ACK 积压转磁盘 FIFO | tests/storage/persistence-performance.test.ts；tests/sdk/worker-review.test.ts |
| R16 | 增加真实生产 server/worker、HTTPS/WSS、本地 HTTP provider、外部 SIGKILL 与重启测试；保留并准确标识旧替身测试 | tests/e2e/real-process.test.mjs；scripts/test-real-process-e2e.mjs |

额外修复了集成测试发现的同源问题：多 Session 恢复批次命名空间冲突、IPC 将长输入错误限制为 512 字符、手机刷新旧 snapshot 覆盖已收到的新事件，以及把 SDK `isPersisted()` 配置开关误认为已经写出 JSONL。

最终独立复核补上四条组合路径：旧 Session 草稿与旧 epoch 表单分别路由；空闲回收检查所有所属 Session 及原生活动；并发/嵌套原生替换独立关联意图且不会互相死锁；跨目录原生 switch 按真实 cwd 认领/创建同 owner 项目并验证重启。对应回归位于 runtime.test.ts、session-history-review.test.ts 和 worker-review.test.ts。

## 验证状态

最终代码在 WSL/Linux、Node 24.19.0、pnpm 10.28.0、pi SDK 0.85.1 上完成以下验证，全部退出码 0：

| 命令 | 实际结果 |
| --- | --- |
| `pnpm test:unit` | 24 文件、170 测试通过，96.83 秒 |
| `pnpm run typecheck` | protocol、agent-pi、server、mobile 和测试 TypeScript 全部通过 |
| `pnpm run lint` | 全仓 ESLint 通过 |
| `pnpm run build:server` | protocol、agent-pi、server 及服务端资源构建通过 |
| `pnpm run build:mobile` | Android / iOS / web JS 与资源导出通过 |
| `node scripts/test-real-process-e2e.mjs --no-build` | 最终生产构建的 9 个真实进程集成测试全部通过，0 failed / skipped / cancelled，80.06 秒 |
| `python3 scripts/check_docs.py`、`git diff --check` | 文档、契约及差异格式检查通过 |

证据保存在默认忽略的 `test-results/code-review/`：`final-unit.log`、`final-typecheck.log`、`final-lint.log`、`r16-final-real-process.log` 与 `r16-runtime-manifest.json`；移动端导出位于 `test-results/s01-mobile-export/`。9 项真实进程场景和运行边界见[原报告的 R16 最终复验](2026-09-15-code-review.md)。测试使用临时项目和合成内容，本地 HTTP provider 不需要外部模型凭据或调用付费服务。

阶段状态不会仅因这些回归通过就全部改为 passed。真实运营者 provider、原生 TUI 全量对照、Docker 部署和 Android/iOS 真机仍单独验收。Android/iOS JS bundle 导出仅表示打包成功，不表示已安装到手机。

## 保留的边界

- 终端 custom renderer、主题等不能直接在 React Native 执行；标准文本 UI/表单已有桥接，终端专有能力明确提示回退需求，不关闭扩展或原生工具。
- Artifact 配额拒绝时保留完整数据库事件，不截掉唯一副本。未确认 spool 保留供诊断；不通过恢复文件自动重放模型命令或 shell 副作用。
- 长历史正文扫描已消除，但 live_state_json 仍保存部分历史实体投影；短基准不能证明无限会话容量。
- WSL 的 /mnt/c 冷启动导入很慢。真实进程测试可离线复制相同构建和生产依赖到 Linux 临时目录执行；这不是替换 server、worker、SDK 或故障恢复实现。
