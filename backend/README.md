# 知行 AI 提取后端

独立 Flask 服务：接收通知 → DeepSeek → 校验 JSON → 返回人工确认草稿。
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
最多 5000 字符；请求体最多 64 KiB。

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

连接超时 10 秒，读取超时 45 秒（网络读取等待时限，不是整次请求的硬总时限）；不自动重试，避免重复付费。
不返回原始上游错误、请求头、密钥或原始模型响应；应用不记录通知内容。

截止时间采用保守校验：支持原文中的完整 ISO 时间戳，以及含“北京时间”的完整中文年月日和 `HH:mm[:ss]`。
其它日期表达、缺少年份/时刻/时区、相对日期返回 `null`，保留原始时间描述，交人工确认。
无效日历日期（如 2 月 30 日）或格式错误会拒绝模型响应。
模型仍可能误解任务或把活动时间当成截止时间，结构校验不等于语义保证，confidence 也不是校准概率。

B：展示提取草稿和错误提示；用户点击识别才发送原文，禁用重复提交。
C：人工确认后将任务字段传给现有 `createTaskFromNotification()`；`type` 属于通知分类，`confidence` 仅供展示，不直接传入任务接口。

CORS 不是身份认证；无 Origin 的命令行请求可访问本地服务。若部署到公网，必须在入口配置身份认证、调用配额/限流和 HTTPS，并使用生产 WSGI 服务；本轮不实现账号系统。

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
