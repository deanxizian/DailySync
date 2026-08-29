# Garmin CN to COROS CN

该目录提供佳明国区到高驰国区的运动活动迁移与日常同步，不修改原项目的 TypeScript 入口、依赖和佳明同步命令。原佳明 Action 仅增加共用的数据库写锁。

## 功能

- 历史迁移：从指定位置开始扫描佳明国区活动，自动翻页并导入高驰国区。
- 日常同步：每 6 小时扫描两端活动，将佳明国区缺失的活动导入高驰国区。
- 重复保护：结合平台活动 ID、UTC 时间、运动类型、时长、距离和 FIT 证据建立映射。
- 删除保护：已建立映射的高驰活动被删除后不会自动补回，也不会删除佳明活动。

同步方向固定为 **佳明国区 → 高驰国区**，仅处理运动活动，不处理睡眠、HRV 等健康数据，也不会写入佳明账号。

## 目录

| 路径 | 用途 |
|---|---|
| `src/migrate_garmin_cn_to_coros.ts` | 历史迁移入口 |
| `src/sync_garmin_cn_to_coros.ts` | 日常同步和状态维护入口 |
| `src/bridge.ts` | 命令调度与参数处理 |
| `src/sync/` | 佳明、高驰、FIT、查重和状态实现 |
| `tests/sync/` | 离线测试 |
| `.env.example` | 本地环境变量模板 |

GitHub Actions 工作流按平台要求保存在仓库根目录：

- `.github/workflows/migrate_garmin_cn_to_coros.yml`
- `.github/workflows/sync_garmin_cn_to_coros.yml`
- `.github/workflows/manage_garmin_cn_to_coros.yml`
- `.github/workflows/coros_sync_ci.yml`

## GitHub 配置

在 `Settings → Secrets and variables → Actions` 中配置以下 Secrets：

| Secret | 默认值 | 用途 |
|---|---:|---|
| `GARMIN_USERNAME` | 无 | 选择 `db/garmin.db` 中对应的佳明国区 Session |
| `GARMIN_SYNC_NUM` | `10` | 日常同步读取佳明活动的每页数量 |
| `GARMIN_MIGRATE_NUM` | `100` | 历史迁移读取佳明活动的每页数量 |
| `GARMIN_MIGRATE_START` | `0` | 历史迁移起点；`0`/`1` 从最新活动开始，`101` 从第 101 条最新活动开始 |
| `GARMIN_MIGRATE_AUTO_PAGE` | `true` | `true` 自动翻页，`false` 只处理一页 |
| `COROS_USERNAME` | 无 | 高驰国区训练中心账号 |
| `COROS_PASSWORD` | 无 | 高驰国区训练中心密码 |
| `AESKEY` | 原项目默认值 | 佳明 Session 与高驰同步状态使用自定义密钥时必须保持一致 |

这些 Action 不使用 `GARMIN_PASSWORD`、佳明国际区凭据或 Session JSON。佳明访问只使用 `db/garmin.db` 中已有的 OAuth Session。

## GitHub Actions

| Action | 触发方式 | 用途 |
|---|---|---|
| **Migrate Garmin CN to COROS CN** | 手动 | 历史活动迁移 |
| **Sync Garmin CN to COROS CN** | 手动、每 6 小时 | 新增活动同步和指定活动处理 |
| **Manage Garmin CN to COROS CN State** | 手动 | 初始化或查看状态，以及关联、忽略或重试指定活动 |

迁移 Action 仅支持手动触发；日常同步 Action 支持手动触发，并按计划自动运行。

为保证 Actions 与人工维护使用同一份活动映射，写入和状态维护仅通过上述 Action 执行；本地命令只提供只读同步预览。

日常同步可以填写 `activity_id`，只处理指定的一条佳明活动。

历史迁移默认每页读取 100 条并自动翻页，`GARMIN_MIGRATE_NUM` 不是单次上传上限。Action 每次保留 45 分钟执行预算；未处理完的活动由后续运行继续处理，已完成映射不会重复上传。

日常同步使用 `GARMIN_SYNC_NUM` 控制每页读取数量，不限制本轮同步总数。定时任务在北京时间 **04:00、10:00、16:00、22:00** 运行，与佳明同步任务间隔 2 小时。

佳明与高驰任务使用同一个远端 Git 互斥锁。高驰工具只读正式分支中的 `db/garmin.db`，不会修改它；活动映射和加密上传意图保存在独立的 `codex/coros-sync-state` 状态分支。该分支每次只保留一个无父提交的最新快照，初始化标记保存在固定引用中；两者都不累积运行历史，也不会向 `main` 写入 Action 产物。
