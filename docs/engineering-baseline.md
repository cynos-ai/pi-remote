# S01 工程基线

状态：S01 实施产物，版本选择与验证入口记录。

## 固定版本

| 组件 | 版本 | 选择依据 |
| --- | --- | --- |
| Node.js | 24.19.0 | 项目统一 Node 24 LTS 基线；由 `.node-version`、根 `engines` 和 CI 同时约束 |
| pnpm | 10.28.0 | 项目约定的 pnpm 10；由 `packageManager` 和 CI action 固定 |
| pi SDK | 0.85.1 | 产品契约指定版本；只在 `packages/agent-pi` 直接依赖 |
| Expo | 57.0.22 | 与本次锁定的 React Native 版本同代的稳定 SDK |
| React Native | 0.86.3 | Expo 57 的 `bundledNativeModules.json` 推荐版本 |
| React | 19.2.3 | Expo 57 的 `bundledNativeModules.json` 推荐版本 |
| React Native Web | 0.21.0 | Expo 57 的 `bundledNativeModules.json` 推荐范围 |

完整解析结果保存在根 `pnpm-lock.yaml`；实际依赖安装必须使用 `pnpm install --frozen-lockfile`。

## 国内源约定

项目默认通过根 `.npmrc` 和 CI 的 `NPM_CONFIG_REGISTRY` 使用 `https://registry.npmmirror.com`。后续 Dockerfile / Compose / CI 镜像任务默认使用 `docker.m.daocloud.io` 作为 Docker Hub 镜像前缀，并保留显式配置覆盖入口；不得在提交的配置中写入镜像仓库凭据。

## 验证入口

`pnpm verify:S01` 会检查 Node / pnpm / SDK 依赖边界，执行冻结安装、lint、类型检查、单元测试、server 构建、Expo 全平台 / Android / iOS JavaScript bundle，并启动构建后的 server 请求 `/healthz`。报告写入 `test-results/s01/report.json`，该目录被 Git 忽略。

S01 的 Android / iOS 结果是 JavaScript bundle；原生编译、模拟器和真实设备验收仍按开发计划留给后续阶段。
