"""Offline contract tests; all model HTTP calls are mocked, no real API key required."""
import json
import unittest
import base64
import shutil
import subprocess
import threading
from unittest.mock import MagicMock, patch

import requests
from urllib3.exceptions import ReadTimeoutError

from backend.app import create_app
from werkzeug.serving import make_server, WSGIRequestHandler


class ExtractTests(unittest.TestCase):
    def setUp(self):
        self.app = create_app({
            "TESTING": True,
            "DEEPSEEK_API_KEY": "test-key-not-real",
            "DEEPSEEK_BASE_URL": "https://api.deepseek.com",
            "DEEPSEEK_MODEL": "test-model",
            "CORS_ALLOWED_ORIGINS": "http://localhost:5500",
        })
        self.client = self.app.test_client()
        self.result = {"type": "assignment", "course": "程序设计", "title": "提交课程报告",
                       "content": "提交程序设计课程报告", "deadline": None,
                       "deadlineText": "本周五前", "confidence": 0.95}
        self.content = "请大家在本周五前提交程序设计课程报告"

    def response(self, data=None, status=200, raw=None, finish="stop"):
        response = MagicMock()
        response.status_code = status
        response.__enter__.return_value = response
        envelope = {"choices": [{"finish_reason": finish, "message": {
            "content": raw if raw is not None else json.dumps(data if data is not None else self.result, ensure_ascii=False)
        }}]}
        response.iter_content.return_value = [json.dumps(envelope).encode("utf-8")]
        return response

    def send(self, content=None, **kwargs):
        return self.client.post("/api/extract", json={"content": self.content if content is None else content}, **kwargs)

    @patch("backend.app.requests.post")
    def test_assignment(self, post):
        post.return_value = self.response()
        reply = self.send()
        self.assertEqual(reply.status_code, 200)
        self.assertEqual(reply.json, {"success": True, "data": self.result})
        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["response_format"], {"type": "json_object"})
        self.assertEqual(payload["messages"][1]["content"], self.content)
        self.assertFalse(post.call_args.kwargs["allow_redirects"])

    @patch("backend.app.requests.post")
    def test_chinese_utf8_request_upstream_and_response(self, post):
        # Exercise real UTF-8 bytes, not only Flask's convenient json= helper.
        upstream = {"choices": [{"finish_reason": "stop", "message": {
            "content": json.dumps(self.result, ensure_ascii=False)
        }}]}
        response = self.response()
        response.iter_content.return_value = [json.dumps(upstream, ensure_ascii=False).encode("utf-8")]
        post.return_value = response
        body = json.dumps({"content": self.content}, ensure_ascii=False).encode("utf-8")
        reply = self.client.post("/api/extract", data=body, content_type="application/json; charset=utf-8")
        self.assertEqual(reply.status_code, 200)
        self.assertEqual(post.call_args.kwargs["json"]["messages"][1]["content"], self.content)
        decoded = json.loads(reply.data.decode("utf-8", errors="strict"))
        self.assertEqual(reply.mimetype, "application/json")
        for field in ("course", "title", "content", "deadlineText"):
            self.assertEqual(decoded["data"][field], self.result[field])
            self.assertIn(self.result[field].encode("utf-8"), reply.data)

    @unittest.skipUnless(shutil.which("powershell.exe"), "Windows PowerShell unavailable")
    @patch("backend.app.requests.post")
    def test_windows_powershell_response_decoding(self, post):
        post.return_value = self.response()

        class QuietHandler(WSGIRequestHandler):
            def log_request(self, *args, **kwargs):
                pass

        server = make_server("127.0.0.1", 0, self.app, request_handler=QuietHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        body = base64.b64encode(json.dumps({"content": self.content}, ensure_ascii=False).encode("utf-8")).decode("ascii")
        expected = base64.b64encode(json.dumps(self.result, ensure_ascii=False).encode("utf-8")).decode("ascii")
        script = f"""
$ErrorActionPreference = 'Stop'
$body = [Convert]::FromBase64String('{body}')
$expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{expected}')) | ConvertFrom-Json
$r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:{server.server_port}/api/extract' -Method Post -ContentType 'application/json; charset=utf-8' -Body $body
$automatic = $r.Content | ConvertFrom-Json
$explicit = [Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray()) | ConvertFrom-Json
$results = @{{}}
foreach ($field in @('course','title','content','deadlineText')) {{
  $results[$field] = @{{automatic=($automatic.data.$field -ceq $expected.$field); utf8=($explicit.data.$field -ceq $expected.$field)}}
}}
$results | ConvertTo-Json -Compress
"""
        try:
            encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
            process = subprocess.run([shutil.which("powershell.exe"), "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
                                     capture_output=True, timeout=25)
            self.assertEqual(process.returncode, 0, "PowerShell encoding probe failed")
            results = json.loads(process.stdout)
            self.assertTrue(all(result["utf8"] for result in results.values()))
            self.assertEqual(post.call_args.kwargs["json"]["messages"][1]["content"], self.content)
            print("PowerShell decoding probe: " + json.dumps(results, sort_keys=True))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    @patch("backend.app.requests.post")
    def test_exam_activity_and_unknown_deadline(self, post):
        cases = [("exam", "高等数学考试时间另行通知", "高等数学"),
                 ("activity", "请报名校园志愿活动", ""),
                 ("assignment", "请提交课程报告，时间待定", "")]
        for kind, source, course in cases:
            with self.subTest(kind=kind):
                result = {**self.result, "type": kind, "course": course, "deadlineText": "", "deadline": None}
                post.return_value = self.response(result)
                reply = self.send(source)
                self.assertEqual(reply.status_code, 200)
                self.assertEqual(reply.json["data"]["type"], kind)
                self.assertIsNone(reply.json["data"]["deadline"])

    @patch("backend.app.requests.post")
    def test_bad_inputs_do_not_call_model(self, post):
        for content in ("", "  \n", None, 4, [], "字" * 5001):
            reply = self.client.post("/api/extract", json={"content": content})
            self.assertEqual(reply.status_code, 400)
        self.assertEqual(self.client.post("/api/extract", data="oops").status_code, 415)
        self.assertEqual(self.client.post("/api/extract", data="{", content_type="application/json").status_code, 400)
        self.assertEqual(self.client.post("/api/extract", data="x" * 65537, content_type="application/json").status_code, 413)
        post.assert_not_called()

    @patch("backend.app.requests.post")
    def test_missing_key(self, post):
        self.app.config["DEEPSEEK_API_KEY"] = ""
        reply = self.send()
        self.assertEqual(reply.status_code, 503)
        self.assertEqual(reply.json["error"]["code"], "API_KEY_MISSING")
        post.assert_not_called()

    @patch("backend.app.requests.post")
    def test_upstream_errors_are_sanitized(self, post):
        for error, status in [(requests.Timeout("secret notification test-key-not-real"), 504),
                              (requests.ConnectionError("secret notification test-key-not-real"), 502)]:
            post.side_effect = error
            with self.assertNoLogs(self.app.logger, level="WARNING"):
                reply = self.send()
            self.assertEqual(reply.status_code, status)
            self.assertNotIn("test-key-not-real", reply.get_data(as_text=True))
            self.assertNotIn("secret notification", reply.get_data(as_text=True))
        post.side_effect = None
        for upstream, expected in [(429, 429), (401, 502), (403, 502), (500, 502), (302, 502)]:
            post.return_value = self.response(status=upstream)
            self.assertEqual(self.send().status_code, expected)
        post.return_value = self.response()
        post.return_value.iter_content.side_effect = requests.ConnectionError(ReadTimeoutError(None, None, "read timeout"))
        self.assertEqual(self.send().status_code, 504)

    @patch("backend.app.requests.post")
    def test_invalid_model_json(self, post):
        for raw in ("", "   ", "not json", "```json\n{}\n```", "[]", '{"type":"other","type":"exam"}'):
            post.return_value = self.response(raw=raw)
            self.assertEqual(self.send().status_code, 502)
        for field, bad in [("confidence", True), ("confidence", 1.5), ("confidence", float("nan")),
                           ("type", "unknown"), ("course", None), ("title", 12),
                           ("deadline", "2026-02-30T12:00:00+08:00"),
                           ("deadline", "2026-11-27T12:00:00"), ("deadlineText", "凭空添加的时间")]:
            post.return_value = self.response({**self.result, field: bad})
            self.assertEqual(self.send().status_code, 502, field)
        post.return_value = self.response(finish="length")
        self.assertEqual(self.send().status_code, 502)

    @patch("backend.app.requests.post")
    def test_deadline_evidence(self, post):
        result = {**self.result, "deadline": "2026-11-27T18:00:00+08:00"}
        post.return_value = self.response(result)
        self.assertIsNone(self.send().json["data"]["deadline"], "Do not resolve relative dates")
        for description in ("2026年11月27日18:00（北京时间）", "2026-11-27T18:00:00+08:00"):
            result["deadlineText"] = description
            post.return_value = self.response(result)
            reply = self.send(f"请在{description}前提交报告")
            self.assertEqual(reply.json["data"]["deadline"], result["deadline"])
        result["deadlineText"] = "2026年11月27日18:00"
        post.return_value = self.response(result)
        self.assertEqual(self.send("截止2026年11月27日18:00").json["data"]["deadline"], result["deadline"])

    @patch("backend.app.requests.post")
    def test_campus_deadline_policy_and_null_recovery(self, post):
        description = "2026年11月28日20:00前"
        post.return_value = self.response({**self.result, "deadlineText": description, "deadline": None})
        reply = self.send(f"请在{description}提交报告")
        self.assertEqual(reply.status_code, 200)
        self.assertEqual(reply.json["data"]["deadline"], "2026-11-28T20:00:00+08:00")
        self.assertEqual(reply.json["data"]["deadlineText"], description)
        for text in ("本周五前", "11月28日20:00前", "2026年11月28日前", "2026年2月30日20:00前",
                     "2026年11月28日20:00或2026年11月29日20:00前", "纽约时间2026年11月28日20:00前",
                     "2026年11月28日20:00（UTC+09:00）前"):
            with self.subTest(text=text):
                post.return_value = self.response({**self.result, "deadlineText": text, "deadline": None})
                self.assertIsNone(self.send(f"请在{text}提交报告").json["data"]["deadline"])
        post.return_value = self.response({**self.result, "deadlineText": "2026年11月28日20:00", "deadline": None})
        self.assertIsNone(self.send("活动开始于2026年11月28日20:00").json["data"]["deadline"])

    @patch("backend.app.requests.post")
    def test_cors(self, post):
        denied = self.send(headers={"Origin": "https://untrusted.example"})
        self.assertEqual(denied.status_code, 403)
        self.assertNotIn("Access-Control-Allow-Origin", denied.headers)
        post.assert_not_called()
        preflight = self.client.options("/api/extract", headers={"Origin": "http://localhost:5500", "Access-Control-Request-Method": "POST"})
        self.assertEqual(preflight.status_code, 204)
        self.assertEqual(preflight.headers["Access-Control-Allow-Origin"], "http://localhost:5500")
        self.assertNotIn("Access-Control-Allow-Credentials", preflight.headers)
        post.return_value = self.response()
        reply = self.send(headers={"Origin": "http://localhost:5500"})
        self.assertEqual(reply.headers["Access-Control-Allow-Origin"], "http://localhost:5500")
        with self.assertRaises(ValueError):
            create_app({"CORS_ALLOWED_ORIGINS": "*"})

    @patch("backend.app.requests.post")
    def test_safe_diagnostics_and_balance_error(self, post):
        for upstream, category in [(401, "authentication"), (402, "insufficient_balance"),
                                   (429, "rate_limit"), (500, "upstream_server_error")]:
            post.return_value = self.response(status=upstream)
            with self.assertLogs("zhixing.ai", level="WARNING") as logs:
                reply = self.send()
            self.assertIn(f"status={upstream} error_type={category}", logs.output[0])
            self.assertNotIn("test-key-not-real", str(logs.output))
            self.assertNotIn(self.content, str(logs.output))
            if upstream == 402:
                self.assertEqual(reply.status_code, 503)
                self.assertEqual(reply.json["error"]["code"], "AI_INSUFFICIENT_BALANCE")
        for error, category in [(requests.exceptions.ProxyError("test-key-not-real"), "proxy_error"),
                                (requests.exceptions.SSLError(self.content), "ssl_error"),
                                (requests.Timeout("Authorization: test-key-not-real"), "timeout")]:
            post.side_effect = error
            with self.assertLogs("zhixing.ai", level="WARNING") as logs:
                reply = self.send()
            self.assertIn(f"error_type={category}", logs.output[0])
            combined = str(logs.output) + reply.get_data(as_text=True)
            for secret in ("test-key-not-real", self.content, "Authorization"):
                self.assertNotIn(secret, combined)


if __name__ == "__main__":
    unittest.main()
