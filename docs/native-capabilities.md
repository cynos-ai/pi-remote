# 原生能力清单

状态：S02 建立的 V1 常用流程适配清单。`available` 表示已确认 SDK 入口或 contract smoke，不表示移动端设备或真实 provider 已完成；`needs_adapter` 只表示范围内的后续实现任务，不能被当作默认禁用。完整终端模拟不属于 V1，不以永久 `needs_adapter` 表示。

清单来源：[capabilities.ts](../packages/agent-pi/src/capabilities.ts)。运行时可通过 `getNativeCapabilities()` 读取同一份数据。

| 能力 | 状态 | 证据 | 后续适配 |
| --- | --- | --- | --- |
| `session.prompt` | available | sdk_api | S07 / S10 映射 Operation、Run 和移动端输入 |
| `session.runtime-replacement` | available | sdk_api | S06 / S07 确认 new、switch、fork、import 的映射与 rebind |
| `session.legal-empty-history` | available | contract_smoke | S04 / S06 持久化身份并保护损坏文件 |
| `streaming.events` | available | sdk_api | S03 / S04 归一化有序事件 |
| `model.selection` | available | sdk_api | S07 暴露实际模型与 thinking 配置及 hook 错误 |
| `model.compaction` | available | sdk_api | S07 单独实现原生 stop-before-compact 时序 |
| `input.steer-follow-up` | available | sdk_api | S07 保存完整输入并恢复 returned / unknown 草稿 |
| `input.attachments` | available | sdk_api + contract | S03 / S07 使用 artifact-backed attachment DTO；S10 已接通 Expo 图片选择、上传、当前 Session 绑定及 SDK ImageContent 转换 |
| `extension.commands` | available | sdk_api | S07 / S10 保留 streaming 中的原生命令路径 |
| `extension.interactions` | available | sdk_api | S07 / S10 以 operationId 桥接标准表单 |
| `resources.native-discovery` | available | sdk_api | S06 / S12 保留原生 loader、trust 与显式部署路径 |
| `bash.native-executor` | available | sdk_api | S06 / S07 / S10 / S12 透传原生 Bash 生命周期 |
| `extension.custom-renderers` | available | contract_smoke | S07 在 worker 执行 renderer 并生成有界 80 列纯文本；S10 持久化、重连重放并标注移动端投影 |
| `ui.mobile-touch-projections` | available | contract_smoke | S07 / S10 已用文本投影、触控操作、标准表单和直接手机入口承载可观察语义 |

当前没有 `needs_adapter`、`disabled_by_owner` 或 `upstream_unavailable` 项。真实配置缺失只影响对应 live / device 证据，不会把能力清单静默改成可用或禁用。



2026-09-15 审核修复已接通真实 worker 的 runtime replacement、无命令消息/Run、标准 UI 状态/编辑器、实际模型目录和队列取回；详见[修复记录](reviews/2026-09-15-code-review-fixes.md)。2026-09-22 又接通 custom message / entry renderer 的 worker 内文本投影；函数、组件和 SDK 类型不越过协议。终端像素排版、跨 custom 实例共享焦点、聊天区域清屏/重绘、完整主题、硬件光标、全屏/滚动区和所有低频 TUI 快捷键明确不在 V1 范围。Android/iOS 真机和真实运营者 provider 的范围内流程仍单独验收。
