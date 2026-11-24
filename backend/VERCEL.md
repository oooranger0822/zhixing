# Vercel 部署与三人联调

采用独立后端 Vercel Project，同一仓库、Root Directory 为 `backend`。现有前端 Project、域名及路由不变。
`api/extract.py` 导出 Flask WSGI app；路径仍为 POST `/api/extract`。空 `public` 目录限制静态发布范围。

## 控制台步骤

1. 人工检查并提交需要的代码（本次没有提交/推送）。确认 `.env`、`api.env`、虚拟环境未被跟踪。
2. 在 Upstash 创建独立 Redis 数据库，复制 HTTPS REST URL 和具有写入权限的 REST Token，不使用 Readonly Token。
3. Vercel **新建** Project，导入同一仓库，Root Directory 选 `backend`，Framework Preset 选 **Other**，Build Command 留空，Output Directory 为 `public`。不要改现有前端项目配置。Python 依赖由 requirements.txt 安装。
4. 为 Production 设置下表变量，密钥标记 Sensitive。Preview 联调使用独立令牌和 Redis 数据库。保持 Vercel 系统环境变量暴露开启（自动提供 `VERCEL=1`）。
5. 部署，确认 Functions 中有 `api/extract.py`，maxDuration 为 60 秒。使用稳定生产域名测试。
6. 若 Deployment Protection 拦截 OPTIONS/POST，在团队政策允许下让生产 API 域名可访问；应用仍要求队员令牌。不要把平台保护绕过密钥放进前端。
7. 环境变量变更后重新部署；检查 Runtime Logs，不应包含通知正文或密钥。

| 环境变量 | 值 |
| --- | --- |
| DEEPSEEK_API_KEY | 现有密钥，只填服务端控制台 |
| DEEPSEEK_BASE_URL | `https://api.deepseek.com` |
| DEEPSEEK_MODEL | 本地已验证模型名称，当前示例 `deepseek-flash` |
| CORS_ALLOWED_ORIGINS | 如 `https://你的前端域名,http://localhost:5500,http://127.0.0.1:5500`；精确来源，无路径、尾斜杠、通配符 |
| AI_ACCESS_TOKENS | `{"A":"A的随机令牌","B":"B的随机令牌","C":"C的随机令牌"}`，不要外层单引号 |
| UPSTASH_REDIS_REST_URL | `https://…upstash.io` |
| UPSTASH_REDIS_REST_TOKEN | 数据库可写 REST Token，仅服务端 |

队员令牌各自独立随机生成，至少 32 字符，仅字母、数字、下划线、连字符。
可在自己的终端运行 `python -c "import secrets; print(secrets.token_urlsafe(32))"` 三次，安全分发。
令牌不可写进公开 HTML/JS、Git 或 URL；泄露后替换并重新部署。它不同于 DeepSeek API Key。

## 保护机制

- POST 必须有 `Authorization: Bearer <队员令牌>`，无 Origin 的命令行也要认证；CORS 不是认证。
- 每人每 60 秒最多 6 次、每 86400 秒最多 100 次，全队每 86400 秒最多 200 次。
  窗口从首次接受请求开始，不是自然日，边界可能突发。Redis Lua 原子检查和扣减，多实例共用配额。
- 输入无效不扣配额；模型调用失败也计次数。调用次数不等于精确金额预算。
- 公网认证或 Redis 配置缺失、Redis 故障时返回 503，不调用模型；无效令牌 401，超额 429。
- 第二阶段支持 10000 字符、128 KiB 请求上限，保留 2048 输出 tokens、字段校验和 UTF-8 JSON。
- Redis 连接/读取超时 3/5 秒，模型 5/35 秒，不重试。读取超时不是总时限；平台 60 秒硬超时可能返回平台错误，前端需兜底。
- 可额外启用 Vercel Firewall 流量限制与平台/模型预算提醒。付费模型配额不能消除无效请求的平台成本。
- 本地无 AI_ACCESS_TOKENS 时仍可直接访问回环开发服务；设置令牌后本地也要求 Redis 配额。

## 前端衔接

当前 notification.js 调用 `https://zhixing-ai.vercel.app/api/extract`，不同域名不能直接使用相对 `/api/extract`。
队员输入访问令牌，仅保存在页面内存，通过 Authorization 头发送，不硬编码。新前端使用 `JSON.stringify({content, referenceTime})`，响应用 `response.json()`；旧 content-only 请求继续兼容。
第二阶段必须先部署后端，再发布前端，否则旧后端会拒绝 referenceTime 字段。无需新增环境变量，禁止把 .env 带入发布文件。
处理 401/403/429/503、网络及非 JSON 错误；识别结果仍需人工确认。
共用 AI 服务不等于共享数据，LocalStorage 通知和任务仍属于各自浏览器。

## 测试

项目根目录离线回归：

```powershell
./backend/.venv/Scripts/python.exe -B -m unittest backend.test_app backend.test_deployment backend.test_dates
node --test tests/*.test.mjs
```

线上 PowerShell 5.1 中文测试（真实调用产生费用）：

```powershell
$uri = 'https://你的AI项目.vercel.app/api/extract'
$secureToken = Read-Host '请输入队员令牌' -AsSecureString
$credential = New-Object System.Net.NetworkCredential('', $secureToken)
$headers = @{ Authorization = 'Bearer ' + $credential.Password }
$body = @{ content = '请大家在本周五前提交程序设计课程报告' } | ConvertTo-Json
$response = Invoke-WebRequest -UseBasicParsing -Uri $uri -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
$result = [Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray()) | ConvertFrom-Json
$result.success
$result.data | Format-List course,title,content,deadlineText
Remove-Variable headers,credential,secureToken
```

应为 success=True，中文正常，相对时间 deadline 为 null。保存为 .ps1 时使用 UTF-8 带 BOM。
再检查：无令牌 401；合法令牌加空内容 400；非法 Origin 403；允许来源 OPTIONS 204。
真实配额 429 和 Redis 故障验证请用独立 Preview 数据库，避免占用生产额度。
确认 `/app.py`、`/.env`、`/access.py` 无法下载，并在真实前端来源浏览器验证预检和 POST。
本地测试不代替 Vercel 构建、真实 Redis Lua 执行和云端网络联调。

参考：[Vercel Python Functions](https://vercel.com/docs/functions/runtimes/python)、[项目配置](https://vercel.com/docs/project-configuration/vercel-json)、[Upstash REST](https://upstash.com/docs/redis/features/restapi)。

## 发布安全：同仓库、两个现有 Project

以下步骤全部由负责人手动执行，本次代码修改不提交、不推送、不部署，也不修改控制台设置。不要重新创建已上线的项目或更换现有密钥/队员令牌。

### 本地准备与恢复基线

本次前端对 HTTP 400 + success=false + INVALID_CONTENT + 已知旧后端的完整固定文案，提示“AI 服务版本尚未更新，请联系管理员”。其余 400 按参考日期无效、内容超长或一般请求问题提示，不一律归因于版本。不回显任意后端错误文本，不删除 referenceTime 重试，不自动增加付费调用。

恢复必须使用**支持新版数据的完整前端版本**，不能恢复历史七字段严格校验版本，也不能仅替换 js/data.js：旧任务页无法正确展示 deadlineDate。当前兼容基线保留三页、全部依赖、手动任务和日期展示；不修改浏览器数据，不删字段、不降级数据。

```powershell
node --test tests/*.test.mjs
./backend/.venv/Scripts/python.exe -B -m unittest backend.test_app backend.test_deployment backend.test_dates
node scripts/frontend-recovery.mjs
```

最后一条只在 `.release/frontend-compatible-随机后缀/` 创建本地快照，不执行部署。`public/` 仅包含明确白名单中的 11 个前端文件；不复制后端、.env、令牌、测试或浏览器用户数据。包根目录 manifest.json 记录每个文件的 SHA-256，标记来源为 working-tree，不能把它误认为已提交的 Git 版本。每次构建创建新目录，不覆盖旧包。

```powershell
node scripts/frontend-recovery.mjs --verify .release/frontend-compatible-实际后缀
$env:ZHIXING_RECOVERY_ROOT = (Resolve-Path .release/frontend-compatible-实际后缀/public).Path
node tests/browser-smoke.mjs
Remove-Item Env:ZHIXING_RECOVERY_ROOT
```

核验恢复包的三页、手动任务、仅日期草稿、推断提示；浏览器测试使用同一个临时来源先加载当前版本、再切换恢复包，确认读取不改写原有测试记录。所有模型响应为模拟/阻断真实请求。保留已验证快照，不要在事故发生后从有问题的工作区重新生成并冒充旧基线。

`.release/` 已被 Git 忽略。负责人应安全归档快照与 manifest、记录对应已提交 SHA、测试结果及未来 Deployment ID；不要将本地恢复目录混入日常前端根目录上传。恢复包不是数据库备份，也不能修复其自身已有的代码缺陷。基线自身出错时仍需兼容性修复后重新发布。

### 分阶段上线（控制台手动操作）

1. **推送生产分支之前：两个 Project 都要操作。** 在 Vercel `Settings → Environments → Production → Branch Tracking` 关闭 `Auto-assign Custom Production Domains`，确认当前生产域名仍指向旧版；记录两个项目的生产分支、当前 Deployment ID 与 Git SHA。不要依赖同一次 push 的构建完成先后。若当前账号界面无法控制自动提升，先保持生产分支不动，通过非生产分支 Preview 验证，再逐项目手动提升，不允许两个项目自动同时切换。
2. **本地人工检查并提交。** 精确选择此次改动文件；确认新增日期解析器、测试和恢复脚本未遗漏。不要 `git add .` 混入未知文件。确认没有跟踪 `.env`、api.env、虚拟环境、缓存和 `.release/`；不要为检查而打印密钥。由负责人提交、推送并按团队流程合并到已核实的生产分支。
3. **等待两个候选构建，但不切换前端。** 同仓库可能同时触发两个项目构建；应处于 staged、未接管生产域名。后端仍为 Root Directory=`backend`、Other、Output Directory=`public`，60 秒 Function；前端保留已上线的 Root Directory/静态构建配置。确认两个候选均来自同一个目标 SHA，后端包含 dates.py，并使用已有 Production 环境变量。不要把后端 Output Directory 配置套到前端根目录。
4. **先验收后端候选。** 使用其部署 URL 和现有合法认证，分别发送 `{content}` 与 `{content, referenceTime}`。旧请求必须继续返回原七字段结构；新请求检查日号、跨月、历史参考日期、dateWarning、中文，以及 10000/10001 字符边界。检查 401/403/400、OPTIONS 和日志脱敏。真实调用会消耗额度，使用无敏感内容的少量测试；不是通过本地模拟测试就宣称线上通过。
5. **只提升后端。** 后端 Project 的 Deployments 中选择已验证候选，`Promote`，确认 `zhixing-ai.vercel.app` 指向它。前端仍保持旧生产部署。重新用旧生产前端完成识别、保存及任务生成，验证后端真实生产域名的 CORS、认证、配额和中文均正常。
6. **再验收前端候选。** 新前端固定调用上述生产 API；它不会自动转向后端 Preview。若候选页面来源未获 CORS 允许，由管理员手动将其精确 Origin 加入后端允许列表并重新部署同一兼容后端，然后复验；不得用通配符或将平台绕过密钥放入页面。也可先使用已经允许的 localhost 来源验证，但最终生产来源必须验收。核对推断提示、日期可编辑、原始多行 deadlineText、长通知、手动任务、任务完成/重开和首页统计。
7. **最后提升前端。** 前端 Project 的 Deployments 中手动 Promote 经过验证的候选，保持原前端生产域名。A/B/C 先处理未保存草稿，关闭旧标签页，再重新加载三个页面；不清除 LocalStorage。检查历史数据、刷新持久化及错误提示。上线后记录兼容前端的 Deployment ID、SHA，与已归档恢复包对应起来，后续回退只选择已验证兼容版本。

Vercel Preview 的 Promote to Production 会重新构建并切换到 Production 环境变量；已暂存的 Production 构建提升不重新构建。因此不要把 Preview 验证等同于 Production 配置验证。上述控制项及提升流程参考 [Vercel 官方说明](https://vercel.com/docs/deployments/promoting-a-deployment)。本仓库没有授权或核验当前控制台状态，负责人必须实际检查。

### 恢复操作与边界

- 前端尚未发布时，后端候选失败就不提升；已提升但新前端尚未写入数据时，可按旧前端契约处理后端回退。
- 新前端发布后，后端不能回退到拒绝 referenceTime 的旧版。旧标签页也不会因服务器回退自动更新，应通知全部关闭后重新打开。
- 前端需要恢复时，优先在**原前端 Project**选择已记录、经过新数据测试的兼容 Deployment。若尚无可用历史兼容 Deployment，使用归档恢复包的 public/ 创建**新的恢复部署**并人工提升到原域名，不修改历史部署、不修改用户数据。
- 从本地恢复包发布需要负责人手动使用 Vercel CLI：先校验 manifest，在 public/ 目录核对/链接**原前端 Project**后创建部署。核对该项目适用于纯静态目录的构建设置，保持生产自动域名分配关闭，验证部署再在控制台 Promote。仅上传 public/，不要上传包根目录或整个工作区；不要误选后端 Project。本次没有执行这些命令，也不提供自动部署脚本。
- 仍需保留兼容的新后端服务。恢复包与当前通过测试的前端是同一兼容基线；若缺陷就在该基线内，不能声称换成相同代码会消除故障，应发布修复版本。
- 不执行 LocalStorage clear、删除字段、覆盖为备份或数据迁移。静态部署切换不恢复用户数据；保持原域名才能继续访问同源存储。旧前端误报 CORRUPT_DATA 时应恢复兼容前端，而不是清空存储。
- 当前错误识别依赖已知旧后端固定文案。其他旧版本若返回不同文案，只能显示一般 HTTP 400 提示；不会凭未知错误断定版本不匹配。输入限制仍为 10000 字符、输出仍为 2048 tokens，均有回归断言。
