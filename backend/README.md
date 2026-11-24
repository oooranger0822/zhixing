# 知行 AI 提取后端

独立 Flask 服务：接收通知 → DeepSeek → 校验 JSON → 返回人工确认草稿。
公网部署见 [Vercel 部署与三人联调](VERCEL.md)，包含认证、共享配额、控制台步骤和线上测试。
不读写 LocalStorage，不保存通知、不自动创建任务，不改变现有前端和 `js/data.js`。

## 本地安装和启动（PowerShell，在项目根目录执行）

需要 Python 3.10+。使用虚拟环境，不需要激活脚本：

```powershell
py -m venv backend/.venv
./backend/.venv/Scripts/python.exe -m pip install -r backend/requirements.txt
Copy-Item backend/.env.example backend/.env
```

仅在本地编辑 `backend/.env`：

```dotenv
DEEPSEEK_API_KEY=replace_with_your_key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
CORS_ALLOWED_ORIGINS=http://localhost:5500,http://127.0.0.1:5500
```

将占位密钥替换成自己的密钥，不要发到聊天、前端或提交到 Git。
`DEEPSEEK_BASE_URL` 是基地址，不含 `/chat/completions`；只允许 HTTPS。
模型名称按账号可用模型设置，示例采用官方 JSON Output 文档中的 `deepseek-flash`。
环境中已设置的变量优先于 `.env`。修改配置后重启服务。
前端若使用其他端口，请修改 CORS 白名单；只填精确来源，不带路径或末尾 `/`。

```powershell
./backend/.venv/Scripts/python.exe backend/app.py
```

监听 `http://127.0.0.1:5000`，不启用调试器。前端继续使用原来的静态服务器。
示例（另开终端）：

```powershell
./backend/.venv/Scripts/python.exe -m http.server 5500 --bind 127.0.0.1
```

静态开发服务器只能本机使用；正式部署不要将项目根目录作为公开静态目录，以免暴露 `backend/.env`。

## 测试

离线测试完全模拟 HTTP 模型响应，不需要密钥、联网或费用：

```powershell
./backend/.venv/Scripts/python.exe -m unittest backend.test_app -v
```

覆盖作业、考试、活动、无明确截止时间、空输入/超长输入、缺失密钥、超时、限流、调用失败、非法 JSON/字段、日期和 CORS。
测试验证服务契约和校验行为，不证明真实模型的提取准确率。

启动后真实调用（将通知内容发送到 DeepSeek，可能产生 API 费用）：

```powershell
$body = @{ content = '请大家在本周五前提交程序设计课程报告' } | ConvertTo-Json
$response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5000/api/extract' -Method Post -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
$json = [System.Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray())
$result = $json | ConvertFrom-Json
$result.data | Format-List course,title,content,deadlineText
```

可依次替换为：`高等数学考试时间另行通知`、`请报名校园志愿活动`、`请提交课程报告，时间待定`、空字符串。
Windows PowerShell 5.1 对未声明 charset 的 JSON 响应可能按旧编码解码；
上面的命令直接读取响应原始字节并按 UTF-8 解码，不依赖 `$response.Content`。
请求的 `Content-Type` 只决定请求编码，不能修正响应解码。
若保存为 `.ps1`，在 Windows PowerShell 5.1 下请使用 UTF-8 **带 BOM** 保存，避免脚本内中文在发请求前损坏。
浏览器应使用 `JSON.stringify({content})` 发请求、`response.json()` 读结果，不要额外使用 escape/unescape 转码。

真实模型中文诊断（固定测试通知，不记录真实通知或密钥）：

```powershell
./backend/.venv/Scripts/python.exe -m backend.diagnose --chinese
```

输出四个字段的中文检查布尔值和仅测试数据的 Unicode 转义，避免终端字体/编码影响诊断。
真实调用失败的可重复测试使用上述离线测试，不必故意泄露或修改真实密钥。

## 接口契约

`POST /api/extract`，`Content-Type: application/json`，只接受 `{"content":"通知原文"}`。
最多 10000 个 Unicode 码点（中文、emoji 均按码点计数）；请求体最多 128 KiB，兼容 10000 个 emoji 的 JSON 转义传输。超限返回明确 400/413，不截断。

成功：`{"success":true,"data":{"type":"assignment","course":"程序设计","title":"提交课程报告","content":"提交程序设计课程报告","deadline":null,"deadlineText":"本周五前","confidence":0.95}}`

失败：`{"success":false,"error":{"code":"AI_TIMEOUT","message":"模型服务响应超时，请稍后重试。"}}`

| HTTP 状态 | 错误 |
| --- | --- |
| 400 / 413 / 415 | 非法或空输入、超长内容/请求体、不支持的媒体类型 |
| 403 | 前端 Origin 不在白名单 |
| 503 | 缺少密钥或模型配置无效 |
| 429 | DeepSeek 限流 |
| 504 | DeepSeek 超时 |
| 502 | 上游鉴权/调用失败、JSON 或字段校验失败 |
| 500 | 未预期的服务异常，仅返回通用信息 |

连接超时 5 秒，读取超时 35 秒（网络读取等待时限，不是整次请求的硬总时限）；不自动重试，避免重复付费。
不返回原始上游错误、请求头、密钥或原始模型响应；应用不记录通知内容。

截止时间采用保守校验：支持原文中的完整 ISO 时间戳，以及完整中文年月日和 `HH:mm[:ss]`。
中文完整日期未注明时区时按校园默认北京时间（UTC+08:00）解释；例如“2026年11月28日20:00前”返回 `2026-11-28T20:00:00+08:00`。
模型漏填 deadline 时，仅在原文有截止语义且完整日期唯一时补全。明确其他时区不套用默认时区。旧客户端只发送 content 时，缺少年份/时刻、相对日期、冲突时间仍返回 null。

第二阶段前端发送可选 referenceTime：

```json
{"content":"明天下午三点半前提交报告","referenceTime":"2026-11-24T10:00:00+08:00"}
```

在原七个响应字段之外，服务端增加 `deadlineDate`、`dateWarning`、`referenceTime`。本例 deadline 为 `2026-11-25T15:30:00+08:00`，deadlineDate 为 null。只说“明天”时 deadline 为 null、deadlineDate 为 `2026-11-25`，不擅自补时分。原始 deadlineText 不变。本周从周一开始。中文“八点”未指明上午/下午时不生成时刻；多候选、非法日期及无法识别的时区保留人工确认提示。

省略年月的日号优先使用唯一的通知年月上下文，其次参考本月/下月/上月线索，否则建议参考日期起最近的有效日号。例如参考 2026-11-24 时，“24号晚上8点前”建议 2026-11-24 20:00，“28号之前”建议仅日期 2026-11-28，“3号交作业”建议仅日期 2026-12-03。4 月出现“31号”时建议 5 月 31 日，并提示本月无该日及跨月歧义。

缺少年份的月日优先使用唯一明确年份上下文，否则在参考年前后四年内选取距离参考日期最近的有效日期。例如参考 2027-01-02 时，“12月31日”建议 2026-12-31，并提示已过去；不自动变成一年后的期限。“2月29日”会校验闰年，不归一化成 3 月 1 日。

上述补全年月结果均带 `dateWarning: "推断日期，待确认：…"`，不是确定事实。前端持久保存为 pending 草稿，预填任务表单并持续提示，用户可以修改并确认后生成任务。上下文存在多个冲突年月、日号非法时保留空值与确认提示。历史通知必须使用录入表单可修改的参考日期；不会使用服务端当前日期代替它。

前端参考值默认首次输入通知内容时的北京时间，允许修正参考日期，原通知 time 不被修正值覆盖。纯日期存储使用 YYYY-MM-DD，精确时刻使用带时区 ISO；任务预填和展示采用北京时间，不跟随设备时区偏移。

### 容量与费用

10000 字符不是 10000 tokens。当前示例模型 deepseek-flash 的官方上下文为 1M tokens，单条通知容量远低于该窗口；若管理员另行配置模型，应核对该模型限制。仍限制输出 2048 tokens，连接/读取超时 5/35 秒，前端总等待 65 秒；长内容可能更慢。原文完整保存，模型输出截断会报错，不将不完整 JSON 作为成功结果，不自动重试付费请求。

以 **10000 输入 tokens + 2048 输出 tokens** 的假设用量计算，Flash 缓存未命中费用约为 $0.00273（非高峰）或 $0.00546（高峰）；这不是每条通知报价，实际还包含系统提示并取决于 token 数、模型、缓存及计费时段。按 2026-11-24 [DeepSeek 官方价格表](https://api-docs.deepseek.com/quick_start/pricing/)估算。原有令牌认证、来源限制及 Redis 共享配额不变，不记录通知或密钥来计算费用。

### 发布与回归

先重新部署 backend，再发布新前端：旧线上后端只接受 content，会拒绝新前端附带的 referenceTime。地址仍是 `https://zhixing-ai.vercel.app/api/extract`；无需修改密钥、访问令牌或 Vercel 环境变量。

```powershell
node --test tests/*.test.mjs
./backend/.venv/Scripts/python.exe -B -m unittest backend.test_app backend.test_deployment backend.test_dates
node tests/browser-smoke.mjs
```

第三条需本机 Chrome（可通过 CHROME_PATH 指定路径），创建临时独立用户目录，只使用虚构数据并屏蔽真实 AI 接口。检查三页 320/375/390/430/768/1440px、表单、弹窗和长文本；截图路径输出到终端。所有自动化模型响应均模拟，不代表线上新后端已发布或已实测。
无效日历日期（如 2 月 30 日）或格式错误会拒绝模型响应。
模型仍可能误解任务或把活动时间当成截止时间，结构校验不等于语义保证，confidence 也不是校准概率。

B：展示提取草稿和错误提示；用户点击识别才发送原文，禁用重复提交。
C：人工确认后将任务字段传给现有 `createTaskFromNotification()`；type 可作为任务类型，confidence 仅供展示，不直接传入任务接口。

CORS 不是身份认证；本地无令牌配置时可直接访问。Vercel 部署要求队员令牌和 Redis 共享配额，详见部署文档；不实现账号系统。

官方协议参考：https://api-docs.deepseek.com/guides/json_mode/ 、https://api-docs.deepseek.com/api/create-chat-completion/

## 安全诊断

```powershell
./backend/.venv/Scripts/python.exe -m backend.diagnose
./backend/.venv/Scripts/python.exe -m backend.diagnose --check-model
./backend/.venv/Scripts/python.exe -m backend.diagnose --call
```

第一条仅检查配置，第二条查询官方账号模型列表，第三条发送一条固定的无个人信息测试通知（可能产生费用）。
只显示密钥是否存在，不显示密钥片段、代理地址、请求头或原始响应。
只加载 `backend/.env`；`api.env` 和 `__pycache__/api.env` 不会自动读取。
进程环境变量优先，修改 `.env` 或代码后需要重启 Flask。

服务端日志示例：`deepseek status=402 error_type=insufficient_balance`。
402 表示 DeepSeek 账户余额不足，前端得到 HTTP 503 / `AI_INSUFFICIENT_BALANCE`；需由账户持有人检查余额与额度。
401/403 为鉴权或权限问题，429 为限流，500/503 为上游故障；
`proxy_error`、`ssl_error`、`connection_error`、`timeout`、`read_timeout` 为固定网络错误类别。
日志不记录原始异常文本、上游错误体、Authorization、通知内容或模型结果。
保留 SSL 校验，不自动关闭代理，也不在请求失败时自动切换模型或付费重试。
若配置的模型不在 `/models` 列表中，使用诊断返回的可用模型手动修正 `.env`；
当前官方示例为 `DEEPSEEK_MODEL=deepseek-flash`，不要依赖旧模型名始终可用。
