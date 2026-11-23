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
- 保留 5000 字符、64 KiB 请求上限、2048 输出 tokens、字段校验和 UTF-8 JSON。
- Redis 连接/读取超时 3/5 秒，模型 5/35 秒，不重试。读取超时不是总时限；平台 60 秒硬超时可能返回平台错误，前端需兜底。
- 可额外启用 Vercel Firewall 流量限制与平台/模型预算提醒。付费模型配额不能消除无效请求的平台成本。
- 本地无 AI_ACCESS_TOKENS 时仍可直接访问回环开发服务；设置令牌后本地也要求 Redis 配额。

## 前端衔接

当前前端尚无 AI 请求代码，本次不改页面。B 接入时配置完整地址 `https://你的AI项目.vercel.app/api/extract`，不同域名不能直接使用相对 `/api/extract`。
队员输入访问令牌，仅保存在页面内存，通过 Authorization 头发送，不硬编码。请求仍用 `JSON.stringify({content})`，响应用 `response.json()`。
处理 401/403/429/503、网络及非 JSON 错误；识别结果仍需人工确认。
共用 AI 服务不等于共享数据，LocalStorage 通知和任务仍属于各自浏览器。

## 测试

项目根目录离线回归：

```powershell
./backend/.venv/Scripts/python.exe -m unittest backend.test_app backend.test_deployment -v
node --test tests/data.test.mjs tests/home.test.mjs tests/integration.test.mjs
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
