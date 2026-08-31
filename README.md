# DailySync

DailySync 是一个面向个人运动数据的三平台同步工具，在佳明国区、佳明国际区和高驰国区之间同步运动活动。

```text
Garmin Global <-> Garmin China <-> COROS China
```

项目使用 TypeScript、Node.js 22 和 pnpm。日常同步由 GitHub Actions 定时执行，历史迁移通过手动 Action 分批执行。

## 同步能力

DailySync 提供四个方向的日常同步和历史迁移：

| 方向 | 日常同步上限 | 历史迁移上限 |
| --- | ---: | ---: |
| 佳明国区 → 佳明国际区 | 10 条 | 100 条 |
| 佳明国际区 → 佳明国区 | 10 条 | 100 条 |
| 佳明国区 → 高驰国区 | 10 条 | 100 条 |
| 高驰国区 → 佳明国区 | 10 条 | 100 条 |

上限只计算实际尝试上传的缺失活动。每轮任务都会完整扫描源端和目标端历史，已存在的活动不会占用上传额度；重复运行迁移任务会自动跳过已有活动并继续处理后续记录。

日常同步 Action 支持指定一个源活动 ID。历史迁移 Action 始终按完整历史对账，每次最多上传 100 条缺失活动。

## 活动匹配

平台活动首先按以下摘要信息进行候选匹配：

- UTC 开始时间
- 运动类型
- 活动时长
- 活动距离

摘要不足、重复或经过人工编辑时，DailySync 会进一步比较原始文件格式、文件哈希、设备特征和轨迹记录特征。只有证据足够时才会认定活动已存在或可以安全上传。

项目不保存活动映射和时间游标。目标端被人工删除的活动可能在后续完整扫描中被重新补回。

单条活动存在匹配歧义、格式不支持或异步导入结果暂时未知时，该活动会被跳过并显示在 Action 摘要中，其他活动继续处理。认证失败、历史扫描不完整、平台协议异常、状态数据库错误等系统性问题会终止任务。

## 文件格式

| 来源 | 文件 | 处理方式 | 可上传目标 |
| --- | --- | --- | --- |
| 佳明国区或国际区 | FIT | 校验后原样传输 | 佳明、高驰 |
| 佳明国区或国际区 | TCX | 校验后原样传输 | 佳明、高驰 |
| 佳明国区或国际区 | GPX 跑步/骑行 | 转换并复核为 TCX | 佳明、高驰 |
| 高驰国区 | FIT | 校验后原样传输 | 佳明国区 |

GPX 转换保留轨迹、时间、海拔，以及文件中已有的心率、踏频、功率和温度。无法可靠识别运动类型或无法通过摘要复核的 GPX 不会上传。

## GitHub Secrets

在仓库的 `Settings > Secrets and variables > Actions` 中配置以下 Secrets：

| Secret | 用途 |
| --- | --- |
| `GARMIN_USERNAME` | 佳明国区账号 |
| `GARMIN_PASSWORD` | 佳明国区密码及 Session 加密密钥来源 |
| `GARMIN_GLOBAL_USERNAME` | 佳明国际区账号 |
| `GARMIN_GLOBAL_PASSWORD` | 佳明国际区密码及 Session 加密密钥来源 |
| `COROS_USERNAME` | 高驰国区账号 |
| `COROS_PASSWORD` | 高驰国区密码 |

账号与密码只通过 GitHub Secrets 或本地私有环境文件提供，不应写入仓库。

## GitHub Actions

四个日常同步任务按北京时间错峰运行：

| 方向 | Cron | 北京时间 |
| --- | --- | --- |
| 佳明国区 → 佳明国际区 | `0 */6 * * *` | 02、08、14、20 点 |
| 佳明国际区 → 佳明国区 | `0 1,7,13,19 * * *` | 03、09、15、21 点 |
| 佳明国区 → 高驰国区 | `0 2,8,14,20 * * *` | 04、10、16、22 点 |
| 高驰国区 → 佳明国区 | `0 3,9,15,21 * * *` | 05、11、17、23 点 |

四个历史迁移任务仅支持手动触发。全部同步和迁移任务共用同一个并发组，避免同时访问相同账号或同时修改 Session 数据库。单次作业使用 GitHub Actions 的 6 小时上限。

活动同步不会修改仓库文件。只有佳明 OAuth Session 确实刷新时，工作流才会提交更新后的 `db/garmin.db`，提交消息固定为：

```text
Update Garmin sessions [skip ci]
```

Session 提交不会触发同步任务，也不会覆盖远端并发更新。

## Garmin Session

`db/garmin.db` 只保存佳明国区和国际区的 OAuth Session：

- 每个区域使用独立随机盐；
- 通过对应佳明密码和 `scrypt` 派生 256 位密钥；
- 使用 AES-256-GCM 加密并校验完整性；
- 数据库仅保存区域、账号哈希、盐、IV、认证标签和密文；
- 不保存明文账号、密码、运动活动或同步游标。

每次连接后都会比较规范化的 Session 内容。内容相同时数据库保持逐字节不变；只有 Session 确实刷新时才更新对应记录。

## 本地运行

本地环境需要 Node.js 22.13 或更高版本，以及 pnpm 11.19。

```bash
pnpm install --frozen-lockfile
```

在项目根目录创建 `.env.local`，填写与 GitHub Secrets 相同的六个账号变量，并限制文件权限：

```bash
chmod 600 .env.local
```

日常同步命令：

```bash
pnpm sync:garmin-cn-to-global
pnpm sync:garmin-global-to-cn
pnpm sync:garmin-cn-to-coros
pnpm sync:coros-to-garmin-cn
```

历史迁移命令：

```bash
pnpm migrate:garmin-cn-to-global
pnpm migrate:garmin-global-to-cn
pnpm migrate:garmin-cn-to-coros
pnpm migrate:coros-to-garmin-cn
```

本地与 Actions 使用同一套同步引擎和查重规则。本地运行锁位于 `.local/`，下载的活动文件仅存在于本次运行的私有临时目录，任务结束后会自动清理。

## 密码维护

佳明密码也是对应 Session 的加密密钥来源。修改佳明密码时，应先使用旧密码重新加密数据库记录，再更新 GitHub Secret：

```bash
pnpm session:rekey --region CN
pnpm session:rekey --region GLOBAL
```

命令通过隐藏的标准输入读取新密码。旧密码不可用时，可以在 `.env.local` 中配置新密码后重新登录并替换对应 Session：

```bash
pnpm session:reset --region CN --confirm-reset
pnpm session:reset --region GLOBAL --confirm-reset
```

Session 重置只能在本地执行。登录失败或数据库校验失败时，现有记录不会被覆盖。

## 项目结构

```text
.github/workflows  同步、迁移和 CI 工作流
scripts            Session 提交保护脚本
src/cli            命令入口、配置、报告和运行锁
src/core           同步引擎、类型与错误边界
src/formats        FIT、TCX 和 GPX 处理
src/platforms      Garmin 与 COROS 平台适配器
src/state          Garmin Session 加密数据库
tests              引擎、平台、格式、状态和工作流测试
```

## 开发检查

```bash
pnpm typecheck
pnpm test
pnpm audit --prod
```

测试完全离线运行，不访问真实账号或上传活动。

## 平台说明

Garmin 接入使用 `@gooin/garmin-connect`。COROS 接入使用高驰国区训练中心的网页协议，包括账号登录、FIT 导出、对象存储上传和异步导入查询；它不是获批的第三方官方 API。遇到验证码、二次验证或平台协议变化时，任务会停止并报告，不尝试绕过验证。

## License

DailySync 使用 [GNU General Public License v3.0](LICENSE.txt)。
