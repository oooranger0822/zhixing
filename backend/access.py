"""Team access and atomic shared quotas; never store notification content."""
import hashlib
import hmac
import json
import logging
import re
from urllib.parse import urlsplit

import requests


class AccessError(Exception):
    def __init__(self, code, message, status):
        self.code, self.message, self.status = code, message, status


def unavailable():
    return AccessError("ACCESS_UNAVAILABLE", "访问控制服务暂时不可用，请联系管理员。", 503)


def authenticate(header, config):
    raw = config["AI_ACCESS_TOKENS"]
    if not raw and not config["VERCEL"]:
        return None  # Existing loopback-only local development remains unchanged.
    try:
        tokens = json.loads(raw)
        if not isinstance(tokens, dict) or not tokens or len(tokens) > 3:
            raise ValueError()
        for name, token in tokens.items():
            if name not in ("A", "B", "C") or not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token):
                raise ValueError()
        if len(set(tokens.values())) != len(tokens):
            raise ValueError()
    except (ValueError, TypeError):
        raise unavailable() from None
    supplied = header[7:] if header.startswith("Bearer ") else ""
    digest = hashlib.sha256(supplied.encode("utf-8")).digest()
    for name, token in tokens.items():
        if hmac.compare_digest(digest, hashlib.sha256(token.encode("utf-8")).digest()):
            return name
    raise AccessError("UNAUTHORIZED", "请提供有效的队员访问令牌。", 401)


# All checks and increments happen in one Redis operation across function instances.
# Windows start on first accepted request, not at calendar midnight.
QUOTA_SCRIPT = """
for i = 1, #KEYS do
  if tonumber(redis.call('GET', KEYS[i]) or '0') >= tonumber(ARGV[i * 2 - 1]) then
    return 0
  end
end
for i = 1, #KEYS do
  local count = redis.call('INCR', KEYS[i])
  if count == 1 then redis.call('EXPIRE', KEYS[i], ARGV[i * 2]) end
end
return 1
"""


def consume_quota(member, config):
    if member is None:
        return
    url = config["UPSTASH_REDIS_REST_URL"].rstrip("/")
    token = config["UPSTASH_REDIS_REST_TOKEN"]
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or not parsed.hostname or not parsed.hostname.endswith(".upstash.io")
            or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment or not token):
        raise unavailable()
    keys = [f"{{zhixing-ai}}:{member}:minute", f"{{zhixing-ai}}:{member}:day", "{zhixing-ai}:team:day"]
    try:
        with requests.post(url, json=["EVAL", QUOTA_SCRIPT, "3", *keys, "6", "60", "100", "86400", "200", "86400"],
                           headers={"Authorization": f"Bearer {token}"}, timeout=(3, 5), allow_redirects=False) as response:
            if response.status_code != 200:
                raise ValueError()
            data = response.json()
            if not isinstance(data, dict) or "error" in data or type(data.get("result")) is not int or data["result"] not in (0, 1):
                raise ValueError()
    except (requests.RequestException, ValueError):
        logging.getLogger("zhixing.ai").warning("access error_type=quota_unavailable")
        raise unavailable() from None
    if data["result"] == 0:
        raise AccessError("ACCESS_RATE_LIMITED", "调用次数已达限制，请稍后重试或联系管理员。", 429)
