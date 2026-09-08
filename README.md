# DailySync

DailySync 是一个面向个人运动数据的三平台同步工具，在佳明国区、佳明国际区和高驰国区之间同步运动活动。

```text
Garmin Global <-> Garmin China <-> COROS China
```

项目使用 TypeScript、Node.js 24 和 pnpm。日常同步由 GitHub Actions 定时执行，历史迁移通过手动 Action 分批执行。

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

单条活动存在匹配歧义、格式不支持或异步导入结果暂时未知时，该活动会被跳过并显示在 Action 摘要中，其他活动继续处理。认证失败、历史扫描不完整、平台协议异常、长期凭据保存失败等系统性问题会终止任务。

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
| `GARMIN_PASSWORD` | 佳明国区密码及缓存加密密钥来源 |
| `GARMIN_GLOBAL_USERNAME` | 佳明国际区账号 |
| `GARMIN_GLOBAL_PASSWORD` | 佳明国际区密码及缓存加密密钥来源 |
| `COROS_USERNAME` | 高驰国区账号 |
| `COROS_PASSWORD` | 高驰国区密码 |
| `GARMIN_OAUTH1` | 佳明国区长期 OAuth1，由本地登录命令写入 |
| `GARMIN_GLOBAL_OAUTH1` | 佳明国际区长期 OAuth1，由本地登录命令写入 |
| `GH_SECRETS_TOKEN` | 仅用于自动更新上述两个 OAuth1 Secret 的细粒度 PAT |

账号与密码只通过 GitHub Secrets 或本地私有环境文件提供，不应写入仓库。

在 GitHub [细粒度 Token 设置](https://github.com/settings/personal-access-tokens/new)中创建 PAT：Resource owner 选择仓库所有者，Repository access 只选择此仓库，Repository permissions 中的 **Secrets** 设为 **Read and write**。将生成的完整 Token 保存为 `GH_SECRETS_TOKEN`，按所选有效期及时更换；不需要 Contents 写入权限。

配置本地六个账号变量后，使用已登录的 GitHub CLI 写入两个 OAuth1 Secret：

```bash
gh auth login
pnpm session:login --region CN --repo OWNER/REPO
pnpm session:login --region GLOBAL --repo OWNER/REPO
```

将 `OWNER/REPO` 替换为自己的仓库。命令在本地登录佳明、核验账号，然后直接写入 GitHub Secrets，不显示或导出 Token。执行时应避开同账号的其他同步任务。

## GitHub Actions

四个日常同步任务按北京时间错峰运行：

| 方向 | Cron | 北京时间 |
| --- | --- | --- |
| 佳明国区 → 佳明国际区 | `0 */6 * * *` | 02、08、14、20 点 |
| 佳明国际区 → 佳明国区 | `0 1,7,13,19 * * *` | 03、09、15、21 点 |
| 佳明国区 → 高驰国区 | `0 2,8,14,20 * * *` | 04、10、16、22 点 |
| 高驰国区 → 佳明国区 | `0 3,9,15,21 * * *` | 05、11、17、23 点 |

四个历史迁移任务仅支持手动触发。全部同步和迁移任务共用同一个并发组，避免同时访问相同账号或更新相同凭据。单次作业使用 GitHub Actions 的 6 小时上限。

工作流仅申请仓库内容读取权限，不执行 Git 暂存、提交或推送。活动同步和凭据刷新均不会产生 Commit。

## Garmin Session

佳明凭据分两层保存：

- **OAuth1** 是长期凭据，保存在对应区域的 GitHub Secret 中。
- **OAuth2** 是短期访问凭据，使用对应佳明密码、随机盐和 `scrypt` 派生密钥，以 AES-256-GCM 加密后保存到 Actions Cache。

缓存按区域、账号和 OAuth1 版本隔离，不包含 OAuth1、明文密码或活动文件。OAuth2 不变时不创建新缓存。缓存丢失、过期或损坏时，直接用 OAuth1 换取新的 OAuth2；缓存服务不可用只产生警告，不会阻止已完成的同步。

只有 OAuth1 被佳明确认失效时，才尝试一次密码登录。新凭据经账号核验后，先自动更新对应 Secret，再进行活动同步。OAuth1 未变化时不写 Secret。验证码、二次验证或凭据回写失败会终止任务，不绕过验证，也不把未保存的长期凭据当作已保存。

Actions 启动时检查 `GH_SECRETS_TOKEN` 的可用性。该 Token 过期或被撤销时，需要更新它；GitHub Secrets 中缺少或损坏的 OAuth1 不会被 Actions 自动初始化。项目不使用 Session 数据库，也不将凭据提交到 Git。

## 本地运行

本地环境需要 Node.js 24.20 或更高版本，以及 pnpm 11.19。将 OAuth1 写入 GitHub 时还需要 GitHub CLI。

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

本地与 Actions 使用同一套同步引擎和查重规则。本地 OAuth1 加密保存在 `.local/oauth1/`，OAuth2 加密保存在 `.local/oauth2/`，都不会进入 Git；本地运行不会自动更新 GitHub Secrets。首次本地运行没有凭据时会使用账号密码登录。

本地运行锁位于 `.local/`，下载的活动文件仅存在于本次运行的私有临时目录，任务结束后会自动清理。本地锁与 Actions 并发组不跨机器互锁，应避免同时运行同账号任务。

## 密码维护

修改佳明密码后，同步更新对应的 Password Secret 和 `.env.local`。旧 OAuth2 缓存无法解密时会自动丢弃；OAuth1 仍有效时可直接换取新 OAuth2。

需要替换本地长期凭据或重新配置 GitHub OAuth1 时，执行对应区域的登录命令：

```bash
pnpm session:login --region CN --repo OWNER/REPO
pnpm session:login --region GLOBAL --repo OWNER/REPO
```

省略 `--repo` 时只更新本地凭据。以下命令核验本地连接，不上传活动：

```bash
pnpm session:check --region CN
pnpm session:check --region GLOBAL
```

登录失败时不会覆盖已有长期凭据。命令不会将密码或 Token 输出到终端。

## 项目结构

```text
.github/workflows  同步、迁移和 CI 工作流
src/cli            命令入口、配置、报告和运行锁
src/core           同步引擎、类型与错误边界
src/formats        FIT、TCX 和 GPX 处理
src/platforms      Garmin 与 COROS 平台适配器
src/state          OAuth1 Secret 与加密 OAuth2 缓存
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
