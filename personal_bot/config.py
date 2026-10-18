"""Small configuration schema with no dependency on the legacy configuration."""

import json
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class ModelConfig:
    name: str
    protocol: str
    endpoint: str
    model: str
    timeout_seconds: int = 120
    api_key_env: str = ""


@dataclass(frozen=True)
class AppConfig:
    system_prompt: str
    models: tuple[ModelConfig, ...]
    max_history_turns: int = 20
    max_message_chars: int = 12000
    reply_chunk_chars: int = 1500


def _text(data, key, default=None):
    value = data.get(key, default)
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"{key} 必须是非空文本")
    return value.strip()


def _integer(data, key, default, minimum, maximum):
    value = data.get(key, default)
    if type(value) is not int or not minimum <= value <= maximum:
        raise ConfigError(f"{key} 必须是 {minimum} 到 {maximum} 之间的整数")
    return value


def load_config(path: Path) -> AppConfig:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except OSError as exc:
        raise ConfigError("无法读取配置，请将 config.example.json 复制为 config.local.json 后填写") from exc
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ConfigError("配置必须是有效的 UTF-8 JSON") from exc
    if not isinstance(data, dict):
        raise ConfigError("配置最外层必须是对象")
    raw_models = data.get("models")
    if not isinstance(raw_models, list) or not raw_models:
        raise ConfigError("models 至少需要一个模型配置")
    models = []
    for item in raw_models:
        if not isinstance(item, dict):
            raise ConfigError("models 中每一项必须是对象")
        protocol = _text(item, "protocol")
        if protocol not in ("ollama", "openai"):
            raise ConfigError("protocol 只支持 ollama 或 openai")
        endpoint = _text(item, "endpoint")
        try:
            parts = urlsplit(endpoint)
            valid_url = parts.scheme in ("http", "https") and bool(parts.hostname)
            _ = parts.port
        except ValueError:
            valid_url = False
        if not valid_url or parts.username or parts.password or parts.fragment:
            raise ConfigError("endpoint 必须是 http/https 地址，且不能内嵌账号密码或片段")
        key_env = item.get("api_key_env", "")
        if not isinstance(key_env, str) or (key_env and not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key_env)):
            raise ConfigError("api_key_env 必须是环境变量名称，不是密钥值")
        if "api_key" in item:
            raise ConfigError("请用 api_key_env 引用环境变量，不要把密钥写进配置")
        models.append(ModelConfig(
            name=_text(item, "name"), protocol=protocol, endpoint=endpoint,
            model=_text(item, "model"), api_key_env=key_env,
            timeout_seconds=_integer(item, "timeout_seconds", 120, 1, 600),
        ))
    if len({model.name for model in models}) != len(models):
        raise ConfigError("模型 name 不能重复")
    return AppConfig(
        system_prompt=_text(data, "system_prompt", "你是我的个人助手，回答清楚、简洁。"),
        models=tuple(models),
        max_history_turns=_integer(data, "max_history_turns", 20, 1, 100),
        max_message_chars=_integer(data, "max_message_chars", 12000, 1, 100000),
        reply_chunk_chars=_integer(data, "reply_chunk_chars", 1500, 1, 2000),
    )
