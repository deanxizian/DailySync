# DailySync

DailySync 在佳明国区、佳明国际区和高驰国区之间同步运动活动。项目使用单一 TypeScript/Node.js 22 工程，所有自动任务由 GitHub Actions 执行。

## 同步方向

| 方向 | 日常同步 | 历史迁移 |
|---|---:|---:|
| 佳明国区 → 佳明国际区 | 每轮最多上传 10 条 | 每轮最多上传 100 条 |
| 佳明国际区 → 佳明国区 | 每轮最多上传 10 条 | 每轮最多上传 100 条 |
| 佳明国区 → 高驰国区 | 每轮最多上传 10 条 | 每轮最多上传 100 条 |
| 高驰国区 → 佳明国区 | 每轮最多上传 10 条 | 每轮最多上传 100 条 |

每轮都会完整扫描源端和目标端历史，按 UTC 开始时间、运动类型、时长、距离和可用的文件证据查重。上传上限只计算实际缺失并尝试上传的活动；重复运行迁移任务会跳过已有活动并继续处理后续记录。

项目不保存活动映射或时间游标。目标端被人工删除的活动，可能在后续完整扫描中被重新补回。

## 文件格式

| 来源 | 原始格式 | 处理方式 | 目标 |
|---|---|---|---|
| 佳明国区或国际区 | FIT | 校验后原样传输 | 佳明、高驰 |
| 佳明国区或国际区 | TCX | 校验后原样传输 | 佳明、高驰 |
| 佳明国区或国际区 | GPX 跑步/骑行 | 转换并复核为 TCX | 佳明、高驰 |
| 高驰国区 | FIT | 校验后原样传输 | 佳明国区 |

GPX 转换保留轨迹、时间、海拔，以及文件中已有的心率、踏频、功率和温度。无法可靠识别类型的 GPX 不会上传。单条活动存在重复匹配歧义、格式不支持或异步结果未知时，该条活动会被跳过或留待下轮核验，其他活动继续处理；Action 摘要会显示聚合警告，但不会因此标记整次任务失败。认证失败、历史扫描不完整、接口协议异常或 Session 数据库错误仍会使 Action 失败。

## Secrets

仓库只使用以下六个 GitHub Actions Secrets：

```text
GARMIN_USERNAME
GARMIN_PASSWORD
GARMIN_GLOBAL_USERNAME
GARMIN_GLOBAL_PASSWORD
COROS_USERNAME
COROS_PASSWORD
```

不需要 `AESKEY`、`GARMIN_DB_KEY`、同步数量、迁移数量、迁移起点或模式开关。

高驰接入沿用 running_page 所采用的训练中心协议：密码按接口要求计算 MD5 后登录，高驰 Token 仅保存在进程内存中；上传使用训练中心提供的临时对象存储凭据和异步导入任务。此方式不是获批的第三方官方 API，遇到验证码、二次验证或协议变化时会停止，不绕过验证。

## Actions

| Action | Cron | 北京时间 |
|---|---|---|
| 佳明国区 → 国际区 | `0 */6 * * *` | 02、08、14、20 点 |
| 佳明国际区 → 国区 | `0 1,7,13,19 * * *` | 03、09、15、21 点 |
| 佳明国区 → 高驰 | `0 2,8,14,20 * * *` | 04、10、16、22 点 |
| 高驰 → 佳明国区 | `0 3,9,15,21 * * *` | 05、11、17、23 点 |

四个迁移 Action 仅支持手动触发。所有同步和迁移任务共用一个并发组，作业上限为 GitHub 的 6 小时；同步 Action 不监听 `push`。

## Garmin Session

`db/garmin.db` 只保存佳明国区和国际区的 OAuth Session。每条记录使用独立随机盐，通过对应佳明密码和 `scrypt` 派生 256 位密钥，再使用 AES-256-GCM 加密。数据库不保存明文用户名或密码，只保存区域、账号哈希、盐、IV、认证标签和密文。

每次连接后都会比较规范化的 Session 内容。内容相同不会写数据库；Session 确实刷新时才更新对应记录并执行完整性检查。在 `main` 上，工作流只允许提交 `db/garmin.db`，提交消息固定为：

```text
Update Garmin sessions [skip ci]
```

活动同步本身不产生提交。普通运行时文件出现变化会阻止 Session 提交；推送冲突会直接失败，不拉取、不变基、不强推。

## 密码维护

账号文件使用 `.env.local`，权限必须为 `600`，变量名与六个 Secrets 相同。

修改佳明密码时，先用旧密码重新加密对应 Session：

```bash
pnpm session:rekey --region CN
pnpm session:rekey --region GLOBAL
```

命令从标准输入隐藏读取新密码。数据库完整性检查通过后，再更新对应 GitHub Password Secret。

旧密码不可用时，可在新密码已写入 `.env.local` 后重新登录并原子替换该区域 Session：

```bash
pnpm session:reset --region CN --confirm-reset
pnpm session:reset --region GLOBAL --confirm-reset
```

重置命令仅允许在非 CI 环境执行；登录失败时不会覆盖现有记录。

## 开发

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

代码目录：

```text
src/core       同步引擎、类型与错误边界
src/platforms  Garmin 与 COROS 适配器
src/formats    FIT、TCX 与 GPX 处理
src/state      Garmin Session 数据库
src/cli        固定方向入口与维护命令
tests          离线协议、引擎、状态和工作流测试
```
