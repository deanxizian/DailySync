# Garmin CN and COROS CN

该目录提供佳明国区与高驰国区之间的运动活动迁移和日常同步：

- **佳明国区 → 高驰国区**
- **高驰国区 → 佳明国区**

佳明连接复用项目现有 `db/garmin.db` 中的 OAuth Session，不使用佳明密码登录，也不修改数据库。高驰连接参考 running_page 的国区训练中心登录和 FIT 下载方式，并补充训练中心的 FIT 导入及结果核验流程。

仅同步运动活动，不处理睡眠、HRV 等健康数据，不删除目标端活动，也不覆盖人工编辑。

## 工作方式

- 每次运行完整扫描本轮源端和目标端活动列表，不保存同步游标或活动映射。
- 使用 UTC 开始时间、运动类型、时长、距离和必要时的 FIT 证据判断活动是否已存在。
- 佳明到高驰使用稳定导入文件名，提交后查询高驰导入任务并回查最终活动 ID。
- 高驰到佳明只放行佳明 FIT 上传端点，使用稳定文件名上传，并按活动日期窗口回查佳明活动列表取得最终活动 ID。
- 上传结果未知或仍在处理中时停止后续上传，下次运行先扫描目标端，不盲目重传。
- 明确失败、不支持或需要人工确认的单条活动会被记录并继续处理；整轮未完成或全部写入失败时 Action 才失败。
- 临时 FIT 文件只保存在未跟踪的 `coros-sync/.local/` 中，并在正常退出时删除。
- 不写 Git 分支、Release 或 `db/garmin.db`，不执行 commit 或 push。

由于没有额外保存活动映射，目标端活动被手动删除后，可能在后续运行中重新导入。本地任务与 GitHub Actions 之间也没有跨机器共享锁，避免同时手动运行相同账号的任务。

## 目录

| 路径 | 用途 |
|---|---|
| `src/migrate_garmin_cn_to_coros.ts` | 佳明到高驰历史迁移入口 |
| `src/migrate_coros_cn_to_garmin_cn.ts` | 高驰到佳明历史迁移入口 |
| `src/sync_garmin_cn_to_coros.ts` | 佳明到高驰日常同步入口 |
| `src/sync_coros_cn_to_garmin_cn.ts` | 高驰到佳明日常同步入口 |
| `src/bridge.ts` | 双向命令调度与参数处理 |
| `src/sync/` | 佳明、高驰、FIT 和查重实现 |
| `tests/sync/` | 离线测试 |

## GitHub 配置

在 `Settings → Secrets and variables → Actions` 中配置以下 Secrets：

| Secret | 默认值 | 用途 |
|---|---:|---|
| `GARMIN_USERNAME` | 无 | 选择 `db/garmin.db` 中对应的佳明国区 Session |
| `GARMIN_SYNC_NUM` | `10` | 日常同步时佳明活动列表的分页大小 |
| `GARMIN_MIGRATE_NUM` | `100` | 历史迁移时佳明分页大小及单页模式处理数量 |
| `GARMIN_MIGRATE_START` | `0` | 两个迁移方向的源活动起点；`0`/`1` 从最新开始，`101` 从第 101 条开始 |
| `GARMIN_MIGRATE_AUTO_PAGE` | `true` | `true` 自动处理全部历史，`false` 只处理一批 |
| `COROS_USERNAME` | 无 | 高驰国区训练中心账号 |
| `COROS_PASSWORD` | 无 | 高驰国区训练中心密码 |
| `AESKEY` | 原项目默认值 | `db/garmin.db` 使用自定义密钥时用于解密佳明 Session |

上述四个 `GARMIN_*` 控制参数同时传入原佳明 Action 和高驰 Action。高驰 Action 不使用 `GARMIN_PASSWORD`、佳明国际区凭据或 Session JSON。

本地运行使用权限为 `600` 的 `coros-sync/.env.local`；字段模板见 `.env.example`。

## GitHub Actions

| Action | 触发方式 | 用途 |
|---|---|---|
| **Migrate Garmin CN to COROS CN** | 手动 | 佳明历史活动迁移到高驰 |
| **Migrate COROS CN to Garmin CN** | 手动 | 高驰历史活动迁移到佳明 |
| **Sync Garmin CN to COROS CN** | 手动、每 6 小时 | 只执行佳明到高驰日常同步 |
| **Sync COROS CN to Garmin CN** | 手动、每 6 小时 | 只执行高驰到佳明日常同步 |

历史迁移会自动翻页到源端历史结束，最长运行 6 小时。重新运行时，目标端已经存在的活动会被跳过。

日常同步不保存游标，每次重新核对双方活动；`GARMIN_SYNC_NUM` 是分页大小，不是本轮上传上限。两个单向 Action 手动运行时可以填写源平台的 `activity_id`，只处理指定活动。每个同步方向有 45 分钟执行预算。

佳明到高驰的日常 Action 在北京时间 **04:00、10:00、16:00、22:00** 运行，高驰到佳明在北京时间 **05:00、11:00、17:00、23:00** 运行。全部高驰相关任务共用一个 GitHub Actions 并发队列，避免迁移和同步同时访问同一组账号；等待中的任务按顺序保留，不会互相替换。原佳明 Action 保持独立，继续在北京时间 **02:00、08:00、14:00、20:00** 运行。

高驰相关工作流只有仓库只读权限，checkout 不保存写入凭据，也没有自动提交步骤。成功同步只改变目标运动账号中的活动，不改变任何被 Git 跟踪的文件。
