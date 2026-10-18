"""Stateless Ollama and chat-completions-compatible HTTP calls."""

import json
import logging
import os
import re
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from personal_bot.config import ModelConfig


class ModelError(RuntimeError):
    pass


class _NoRedirect(HTTPRedirectHandler):
    # A key configured for one endpoint must not follow an HTTP redirect.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ModelClient:
    def __init__(self, models: tuple[ModelConfig, ...], transport=None):
        self.models = models
        self._transport = transport or build_opener(_NoRedirect()).open

    def complete(self, messages):
        for model in self.models:
            try:
                answer = self._request(model, messages)
                return answer, model.name
            except ModelError:
                # Never log response bodies, keys, endpoints or private messages.
                logging.warning("一个模型请求失败，继续尝试已配置的备用模型。")
        raise ModelError("模型暂时不可用，请检查模型服务或配置后重试。")

    def _request(self, model, messages):
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if model.api_key_env:
            key = os.environ.get(model.api_key_env, "")
            if not key:
                raise ModelError("模型密钥环境变量未设置")
            headers["Authorization"] = f"Bearer {key}"
        payload = {"model": model.model, "messages": [dict(item) for item in messages]}
        if model.protocol == "ollama":
            payload["stream"] = False
        request = Request(
            model.endpoint, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=headers, method="POST",
        )
        try:
            with self._transport(request, timeout=model.timeout_seconds) as response:
                raw = response.read(2_000_001)
            if len(raw) > 2_000_000:
                raise ModelError("模型响应过大")
            result = json.loads(raw.decode("utf-8"))
            if model.protocol == "ollama":
                answer = result["message"]["content"]
            else:
                answer = result["choices"][0]["message"]["content"]
            if not isinstance(answer, str):
                raise ModelError("模型响应不是文本")
            if model.protocol == "ollama":
                answer = re.sub(r"<think>.*?</think>", "", answer, flags=re.DOTALL)
            answer = answer.strip()
            if not answer:
                raise ModelError("模型返回空内容")
            return answer
        except HTTPError as exc:
            exc.close()
            raise ModelError("模型 HTTP 请求失败") from None
        except (URLError, OSError, HTTPException, ValueError, KeyError, IndexError, TypeError):
            raise ModelError("模型请求或响应解析失败") from None
