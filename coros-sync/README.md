# Garmin CN to COROS CN

该目录提供佳明国区到高驰国区的历史迁移和日常同步。佳明活动读取复用项目现有的 `db/garmin.db` OAuth Session，高驰登录、活动查询、FIT 导入和导入结果查询参考 running_page 的高驰接入方式实现。

同步方向固定为 **佳明国区 → 高驰国区**，仅处理运动活动，不处理睡眠、HRV 等健康数据，也不会写入佳明账号。

## 工作方式

- 每次运行读取本轮佳明活动，并扫描高驰活动列表。
- 使用 UTC 开始时间、运动类型、时长、距离和必要时的 FIT 证据判断活动是否已存在。
- 缺失活动使用稳定的导入文件名上传；运行中断后，下一次会先查询高驰导入任务和活动列表，再决定是否重新上传。
- 临时 FIT 文件只保存在未跟踪的 `coros-sync/.local/` 中，并在运行结束后删除。
- 不保存同步账本、游标或高驰 Token，不写 Git 分支或 Release，不执行 commit 或 push。

该实现以高驰当前数据为准。由于没有额外保存活动映射，手动删除高驰活动后，在对应导入任务也不再可查询时，该活动可能被后续运行重新导入。

## 目录

| 路径 | 用途 |
|---|---|
| `src/migrate_garmin_cn_to_coros.ts` | 历史迁移入口 |
| `src/sync_garmin_cn_to_coros.ts` | 日常同步入口 |
| `src/bridge.ts` | 命令调度与参数处理 |
| `src/sync/` | 佳明、高驰、FIT 和查重实现 |
| `tests/sync/` | 离线测试 |

GitHub Actions 工作流位于：

- `.github/workflows/migrate_garmin_cn_to_coros.yml`
- `.github/workflows/sync_garmin_cn_to_coros.yml`
- `.github/workflows/coros_sync_ci.yml`

## GitHub 配置

在 `Settings → Secrets and variables → Actions` 中配置以下 Secrets：

| Secret | 默认值 | 用途 |
|---|---:|---|
| `GARMIN_USERNAME` | 无 | 选择 `db/garmin.db` 中对应的佳明国区 Session |
| `GARMIN_SYNC_NUM` | `10` | 日常同步每页读取的佳明活动数量 |
| `GARMIN_MIGRATE_NUM` | `100` | 历史迁移每页读取的佳明活动数量 |
| `GARMIN_MIGRATE_START` | `0` | 历史迁移起点；`0`/`1` 从最新活动开始，`101` 从第 101 条最新活动开始 |
| `GARMIN_MIGRATE_AUTO_PAGE` | `true` | `true` 自动翻页，`false` 只处理一页 |
| `COROS_USERNAME` | 无 | 高驰国区训练中心账号 |
| `COROS_PASSWORD` | 无 | 高驰国区训练中心密码 |
| `AESKEY` | 原项目默认值 | `db/garmin.db` 使用自定义密钥时用于解密佳明 Session |

`GARMIN_SYNC_NUM`、`GARMIN_MIGRATE_NUM`、`GARMIN_MIGRATE_START` 和 `GARMIN_MIGRATE_AUTO_PAGE` 直接沿用原项目参数。高驰 Action 不使用 `GARMIN_PASSWORD`、佳明国际区凭据或 Session JSON。

## GitHub Actions

| Action | 触发方式 | 用途 |
|---|---|---|
| **Migrate Garmin CN to COROS CN** | 手动 | 历史活动迁移 |
| **Sync Garmin CN to COROS CN** | 手动、每 6 小时 | 新增活动同步和指定活动处理 |

历史迁移默认从最新活动开始，每页读取 100 条并自动翻页。`GARMIN_MIGRATE_NUM` 是分页大小，不是本轮上传上限；若执行时间预算用完，重新运行同一个 Action 即可，已经存在于高驰的活动会被跳过。

日常同步使用 `GARMIN_SYNC_NUM` 作为分页大小，并自动翻页完成本轮扫描。手动运行时可以填写 `activity_id`，只处理指定的一条佳明活动。

定时任务在北京时间 **04:00、10:00、16:00、22:00** 运行。历史迁移和日常同步使用同一个 GitHub Actions 原生并发组，避免两个高驰任务同时上传。原佳明 Action 保持接入高驰前的脚本、调度和提交行为；高驰工作流不参与也不修改它们。

高驰迁移和同步工作流只有仓库只读权限，checkout 不保存写入凭据，也没有自动提交步骤。成功同步只改变高驰账号中的活动，不改变 `db/garmin.db` 或其他被 Git 跟踪的文件。
