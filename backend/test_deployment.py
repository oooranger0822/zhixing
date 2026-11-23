"""Offline deployment checks: no real keys or paid calls."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import MagicMock, patch
import requests
from backend.app import create_app


class DeploymentTests(unittest.TestCase):
    def test_vercel_entrypoint_import_and_fail_closed(self):
        env = {**os.environ, "VERCEL": "", "AI_ACCESS_TOKENS": "", "CORS_ALLOWED_ORIGINS": "https://zhixing.example"}
        result = subprocess.run([sys.executable, "-c", "from api.extract import app; assert app.test_client().post('/api/extract', json={'content':'test'}).status_code == 503"],
                                cwd=Path(__file__).parent, env=env, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, "Vercel entrypoint import or fail-closed check failed")

    def setUp(self):
        self.config = {"TESTING": True, "VERCEL": "1", "AI_ACCESS_TOKENS": json.dumps({"A": "a" * 40, "B": "b" * 40}),
                       "UPSTASH_REDIS_REST_URL": "https://test.upstash.io", "UPSTASH_REDIS_REST_TOKEN": "fake-secret",
                       "CORS_ALLOWED_ORIGINS": "https://zhixing.example"}
        self.client = create_app(self.config).test_client()
        self.headers = {"Authorization": "Bearer " + "a" * 40, "Origin": "https://zhixing.example"}

    @patch("backend.app.call_deepseek")
    @patch("backend.access.requests.post")
    def test_authentication_and_missing_config(self, post, model):
        for headers in ({}, {"Authorization": "Bearer wrong"}):
            self.assertEqual(self.client.post("/api/extract", json={"content": "通知"}, headers=headers).status_code, 401)
        for override in ({"AI_ACCESS_TOKENS": ""}, {"AI_ACCESS_TOKENS": "{}"}, {"AI_ACCESS_TOKENS": '{"A":"short"}'},
                         {"UPSTASH_REDIS_REST_URL": ""}, {"UPSTASH_REDIS_REST_TOKEN": ""}):
            client = create_app({**self.config, **override}).test_client()
            self.assertEqual(client.post("/api/extract", json={"content": "通知"}, headers=self.headers).status_code, 503)
        post.assert_not_called()
        model.assert_not_called()

    @patch("backend.app.call_deepseek")
    @patch("backend.access.requests.post")
    def test_quota_and_chinese_contract(self, post, model):
        response = MagicMock(status_code=200)
        response.__enter__.return_value = response
        response.json.return_value = {"result": 1}
        post.return_value = response
        result = {"type": "assignment", "course": "程序设计", "title": "提交报告", "content": "提交课程报告",
                  "deadline": None, "deadlineText": "本周五前", "confidence": 0.95}
        model.return_value = result
        reply = self.client.post("/api/extract", json={"content": "请在本周五前提交课程报告"}, headers=self.headers)
        self.assertEqual(reply.status_code, 200)
        self.assertEqual(json.loads(reply.data.decode("utf-8")), {"success": True, "data": result})
        command = post.call_args.kwargs["json"]
        self.assertEqual(command[0], "EVAL")
        self.assertEqual(command[3:6], ["{zhixing-ai}:A:minute", "{zhixing-ai}:A:day", "{zhixing-ai}:team:day"])
        self.assertEqual(command[6:], ["6", "60", "100", "86400", "200", "86400"])
        self.assertNotIn("课程报告", str(command))
        model.reset_mock()
        response.json.return_value = {"result": 0}
        self.assertEqual(self.client.post("/api/extract", json={"content": "通知"}, headers=self.headers).status_code, 429)
        model.assert_not_called()

    @patch("backend.app.call_deepseek")
    @patch("backend.access.requests.post")
    def test_quota_failure_fails_closed(self, post, model):
        post.side_effect = requests.Timeout("fake-secret")
        with self.assertLogs("zhixing.ai", level="WARNING") as logs:
            reply = self.client.post("/api/extract", json={"content": "通知"}, headers=self.headers)
        self.assertEqual(reply.status_code, 503)
        self.assertNotIn("fake-secret", str(logs.output) + reply.get_data(as_text=True))
        model.assert_not_called()

    @patch("backend.access.requests.post")
    def test_preflight_origin_and_validation(self, post):
        reply = self.client.options("/api/extract", headers={"Origin": "https://zhixing.example"})
        self.assertEqual(reply.status_code, 204)
        self.assertIn("Authorization", reply.headers["Access-Control-Allow-Headers"])
        self.assertEqual(self.client.post("/api/extract", json={"content": ""}, headers=self.headers).status_code, 400)
        self.assertEqual(self.client.post("/api/extract", json={"content": "通知"}, headers={**self.headers, "Origin": "https://evil.example"}).status_code, 403)
        post.assert_not_called()

    @patch("backend.app.load_dotenv")
    def test_vercel_does_not_read_dotenv(self, dotenv):
        with patch.dict(os.environ, {"VERCEL": "1", "CORS_ALLOWED_ORIGINS": "https://zhixing.example"}):
            create_app()
        dotenv.assert_not_called()
