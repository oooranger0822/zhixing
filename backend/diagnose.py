"""Safe diagnostics: python -m backend.diagnose [--call]. No secret values printed."""
import argparse
import json
import os
import re
from pathlib import Path

import requests

from backend.app import create_app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--call", action="store_true", help="Send one synthetic notification to the configured official DeepSeek endpoint")
    parser.add_argument("--check-model", action="store_true", help="Check configured model against the official account model list")
    parser.add_argument("--chinese", action="store_true", help="Send a fixed Chinese notification and check UTF-8 response fields")
    args = parser.parse_args()
    environment_key_present = bool(os.environ.get("DEEPSEEK_API_KEY"))
    app = create_app()
    base = app.config["DEEPSEEK_BASE_URL"].rstrip("/")
    official = base in ("https://api.deepseek.com", "https://api.deepseek.com/v1")
    model = app.config["DEEPSEEK_MODEL"]
    key = app.config["DEEPSEEK_API_KEY"]
    print(json.dumps({
        "backend_dotenv_exists": Path(__file__).with_name(".env").is_file(),
        "api_key_present": bool(key) and key != "replace_with_your_key",
        "key_from_process_environment": environment_key_present,
        "official_base_url": official,
        "endpoint": base + "/chat/completions" if official else "custom_or_invalid_not_displayed",
        "model": model if model in ("deepseek-chat", "deepseek-reasoner", "deepseek-flash", "deepseek-v4-pro") else "custom_not_displayed",
        "effective_proxy_present": bool(requests.utils.get_environ_proxies(base)),
        "custom_ca_bundle_present": bool(os.getenv("REQUESTS_CA_BUNDLE") or os.getenv("CURL_CA_BUNDLE")),
        "ssl_verification": True,
        "connect_timeout_seconds": 10,
        "read_timeout_seconds": 45,
    }, indent=2))
    if args.call or args.check_model or args.chinese:
        if not official:
            raise SystemExit("Live diagnostic skipped: first verify the configured endpoint locally.")
    if args.check_model:
        try:
            response = requests.get(base + "/models", headers={"Authorization": "Bearer " + key},
                                    timeout=(10, 45), allow_redirects=False)
            available = None
            supported = []
            if response.status_code == 200:
                ids = {item.get("id") for item in response.json().get("data", [])}
                available = model in ids
                supported = [name for name in ("deepseek-chat", "deepseek-flash", "deepseek-v4-pro") if name in ids]
            print(json.dumps({"models_http_status": response.status_code, "configured_model_available": available,
                              "recognized_available_models": supported}))
        except (requests.RequestException, ValueError, TypeError, AttributeError):
            print(json.dumps({"model_check": "failed_no_exception_details_logged"}))
    if args.call or args.chinese:
        content = "请大家在本周五前提交程序设计课程报告" if args.chinese else "Please submit the course report. No deadline is specified."
        body = json.dumps({"content": content}, ensure_ascii=False).encode("utf-8")
        response = app.test_client().post("/api/extract", data=body, content_type="application/json; charset=utf-8")
        result = response.get_json()
        print(json.dumps({"backend_status": response.status_code, "success": result.get("success"),
                          "error_code": result.get("error", {}).get("code")}, indent=2))
        if args.chinese and result.get("success"):
            decoded = json.loads(response.data.decode("utf-8", errors="strict"))
            fields = ("course", "title", "content", "deadlineText")
            print(json.dumps({"response_content_type": response.content_type,
                              "chinese_fields": {field: bool(re.search(r"[\u4e00-\u9fff]", decoded["data"][field]))
                                                 and not any(bad in decoded["data"][field] for bad in ("?", "\ufffd")) for field in fields},
                              "synthetic_result_unicode_escaped": {field: decoded["data"][field] for field in fields}}, ensure_ascii=True))


if __name__ == "__main__":
    main()
