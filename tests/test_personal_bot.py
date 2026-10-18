import copy
import io
import json
import os
import tempfile
import unittest
from collections import deque
from contextlib import redirect_stdout
from dataclasses import replace
from http.client import IncompleteRead
from pathlib import Path
from queue import Empty
from types import SimpleNamespace
from unittest.mock import patch
from urllib.error import HTTPError, URLError

from main import main
from personal_bot.bot import PersonalBot
from personal_bot.chat import ChatService
from personal_bot.config import AppConfig, ConfigError, ModelConfig, load_config
from personal_bot.models import ModelClient, ModelError


ROOT = Path(__file__).resolve().parents[1]
MODEL = ModelConfig("local", "ollama", "http://127.0.0.1:11434/api/chat", "test-model")
CONFIG = AppConfig("system-test", (MODEL,), max_history_turns=2)


def message(text="hello", sender="wxid_owner", roomid="", kind=1, msg_id=1,
            from_self=False, from_group=False):
    return SimpleNamespace(
        content=text, sender=sender, roomid=roomid, type=kind, id=msg_id,
        from_self=lambda: from_self, from_group=lambda: from_group,
    )


class FakeClient:
    def __init__(self, fail=False):
        self.calls = []
        self.fail = fail

    def complete(self, messages):
        self.calls.append(copy.deepcopy(messages))
        if self.fail:
            raise ModelError("test failure")
        return "reply:" + messages[-1]["content"], "fake"


class FakeWcf:
    self_wxid = "wxid_bot"

    def __init__(self, messages=()):
        self.messages = deque(messages)
        self.sent = []
        self.status = 0

    def send_text(self, msg, receiver):
        self.sent.append((receiver, msg))
        return self.status

    def enable_receiving_msg(self):
        return True

    def is_receiving_msg(self):
        return bool(self.messages)

    def get_msg(self):
        value = self.messages.popleft()
        if isinstance(value, Exception):
            raise value
        return value


class ConfigTests(unittest.TestCase):
    def load(self, update=None):
        data = json.loads((ROOT / "config.example.json").read_text(encoding="utf-8"))
        if update:
            data.update(update)
        with tempfile.TemporaryDirectory(dir=ROOT) as directory:
            path = Path(directory) / "config.local.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            return load_config(path)

    def test_sample_schema_loads_without_legacy_configuration(self):
        config = self.load()
        self.assertEqual(config.models[0].protocol, "ollama")

    def test_configuration_needs_no_user_identity(self):
        config = self.load()
        self.assertFalse(hasattr(config, "owner_id"))

    def test_invalid_limits_are_rejected(self):
        for key, value in (("max_history_turns", 0), ("max_history_turns", True),
                           ("reply_chunk_chars", 2001)):
            with self.subTest(key=key, value=value), self.assertRaises(ConfigError):
                self.load({key: value})

    def test_credentials_in_config_are_rejected(self):
        model = dict(name="remote", protocol="openai", model="test-model",
                     endpoint="https://provider.example/v1/chat/completions")
        for fields in ({"api_key": "dummy-test-key"},
                       {"endpoint": "https://user:pass@provider.example/chat"},
                       {"api_key_env": "bad-variable-name"}):
            with self.subTest(fields=fields), self.assertRaises(ConfigError):
                self.load({"models": [{**model, **fields}]})

    def test_check_does_not_import_wechat_or_call_models(self):
        with patch("main.load_config", return_value=CONFIG), \
             patch("main.ModelClient") as client, \
             patch.dict("sys.modules", {"wcferry": None}), redirect_stdout(io.StringIO()):
            self.assertEqual(main(["--check"]), 0)
            client.assert_not_called()

    def test_missing_config_produces_nonzero_exit(self):
        with redirect_stdout(io.StringIO()):
            self.assertEqual(main(["--config", str(ROOT / "absent-config.json"), "--check"]), 2)


class ChatTests(unittest.TestCase):
    def setUp(self):
        self.client = FakeClient()
        self.chat = ChatService(CONFIG, self.client)

    def test_context_contains_complete_turns_and_system_prompt(self):
        self.chat.respond("alice", "one")
        self.chat.respond("alice", "two")
        self.assertEqual(self.client.calls[1], [
            {"role": "system", "content": "system-test"},
            {"role": "user", "content": "one"},
            {"role": "assistant", "content": "reply:one"},
            {"role": "user", "content": "two"},
        ])

    def test_history_is_bounded_by_complete_turns(self):
        for text in ("one", "two", "three", "four"):
            self.chat.respond("alice", text)
        contents = [item["content"] for item in self.client.calls[-1]]
        self.assertEqual(contents, ["system-test", "two", "reply:two", "three", "reply:three", "four"])

    def test_reset_removes_old_context(self):
        self.chat.respond("alice", "old")
        self.chat.respond("alice", "/reset")
        self.chat.respond("alice", "new")
        self.assertEqual(len(self.client.calls[-1]), 2)
        self.assertNotIn("old", str(self.client.calls[-1]))

    def test_help_and_status_do_not_call_model(self):
        self.assertTrue(self.chat.respond("alice", "帮助"))
        self.assertTrue(self.chat.respond("alice", "/status"))
        self.assertEqual(self.client.calls, [])

    def test_legacy_summary_keyword_is_ordinary_chat(self):
        self.chat.respond("alice", "总结")
        self.assertEqual(self.client.calls[-1][-1]["content"], "总结")

    def test_model_failure_does_not_pollute_history(self):
        self.client.fail = True
        self.chat.respond("alice", "failed")
        self.client.fail = False
        self.chat.respond("alice", "retry")
        self.assertEqual(len(self.client.calls[-1]), 2)

    def test_oversized_input_does_not_call_model(self):
        chat = ChatService(replace(CONFIG, max_message_chars=3), self.client)
        self.assertTrue(chat.respond("alice", "1234"))
        self.assertEqual(self.client.calls, [])

    def test_different_users_have_isolated_contexts(self):
        self.chat.respond("alice", "alice-private")
        self.chat.respond("bob", "bob-private")
        self.assertEqual(len(self.client.calls[-1]), 2)
        self.chat.respond("alice", "alice-next")
        contents = [item["content"] for item in self.client.calls[-1]]
        self.assertIn("alice-private", contents)
        self.assertNotIn("bob-private", contents)

    def test_reset_only_clears_requesting_user(self):
        self.chat.respond("alice", "alice-private")
        self.chat.respond("bob", "bob-private")
        self.chat.respond("alice", "/reset")
        self.chat.respond("bob", "bob-next")
        self.assertEqual(self.client.calls[-1][1]["content"], "bob-private")
        self.chat.respond("alice", "alice-next")
        self.assertEqual(len(self.client.calls[-1]), 2)


class RoutingTests(unittest.TestCase):
    def setUp(self):
        self.client = FakeClient()
        self.wcf = FakeWcf()
        self.bot = PersonalBot(CONFIG, ChatService(CONFIG, self.client), self.wcf)

    def test_only_private_user_text_reaches_model(self):
        rejected = [message(sender=""), message(sender="gh_public"),
                    message(roomid="test@chatroom"), message(from_group=True),
                    message(from_self=True), message(sender="wxid_bot"),
                    message(kind=3), message(kind=49), message(kind=37),
                    message(text=" "), message(text=None)]
        for msg in rejected:
            with self.subTest(msg=msg):
                self.assertFalse(self.bot.handle_message(msg))
        self.assertEqual(self.client.calls, [])
        self.assertEqual(self.wcf.sent, [])
        self.assertTrue(self.bot.handle_message(message()))
        self.assertEqual(self.wcf.sent, [("wxid_owner", "reply:hello")])

    def test_any_user_can_chat_and_receives_their_own_response(self):
        self.assertTrue(self.bot.handle_message(message(text="alice", sender="alice")))
        self.assertTrue(self.bot.handle_message(message(text="bob", sender="bob")))
        self.assertEqual(self.wcf.sent, [("alice", "reply:alice"), ("bob", "reply:bob")])
        self.assertEqual(len(self.client.calls[-1]), 2)

    def test_duplicate_message_does_not_call_model_twice(self):
        self.bot.handle_message(message())
        self.assertFalse(self.bot.handle_message(message()))
        self.assertEqual(len(self.client.calls), 1)

    def test_response_chunks_keep_exact_text_and_private_receiver(self):
        bot = PersonalBot(replace(CONFIG, reply_chunk_chars=3), self.bot.chat, self.wcf)
        bot.handle_message(message(text="abcdef"))
        self.assertEqual("".join(text for _, text in self.wcf.sent), "reply:abcdef")
        self.assertTrue(all(receiver == "wxid_owner" for receiver, _ in self.wcf.sent))
        self.assertTrue(all(len(text) <= 3 for _, text in self.wcf.sent))

    def test_send_failure_is_not_retried_or_logged_with_content(self):
        self.wcf.status = 1
        with self.assertLogs(level="ERROR") as logs:
            self.assertFalse(self.bot.handle_message(message(text="private-test-text")))
        self.assertNotIn("private-test-text", " ".join(logs.output))
        self.assertFalse(self.bot.handle_message(message(text="private-test-text")))
        self.assertEqual(len(self.wcf.sent), 1)

    def test_receive_loop_preserves_message_order_and_context(self):
        wcf = FakeWcf([Empty(), message(text="one", msg_id=1),
                       message(text="two", msg_id=2)])
        bot = PersonalBot(CONFIG, self.bot.chat, wcf)
        bot.run()
        self.assertEqual([text for _, text in wcf.sent], ["reply:one", "reply:two"])
        self.assertEqual(self.client.calls[1][1]["content"], "one")


class Response(io.BytesIO):
    def __init__(self, data):
        super().__init__(json.dumps(data).encode("utf-8"))


class ModelTests(unittest.TestCase):
    messages = [{"role": "system", "content": "test"}, {"role": "user", "content": "hello"}]

    def test_ollama_payload_and_reasoning_filter(self):
        def transport(request, timeout):
            data = json.loads(request.data)
            self.assertEqual(data["messages"], self.messages)
            self.assertFalse(data["stream"])
            self.assertEqual(timeout, 120)
            return Response({"message": {"content": "<think>reasoning</think>answer"}})
        self.assertEqual(ModelClient((MODEL,), transport).complete(self.messages), ("answer", "local"))

    def test_chat_completions_uses_environment_key_and_configured_model(self):
        model = replace(MODEL, name="remote", protocol="openai", api_key_env="TEST_BOT_KEY")
        def transport(request, timeout):
            self.assertEqual(request.get_header("Authorization"), "Bearer dummy-key")
            self.assertEqual(json.loads(request.data)["model"], "test-model")
            return Response({"choices": [{"message": {"content": "answer"}}]})
        with patch.dict(os.environ, {"TEST_BOT_KEY": "dummy-key"}):
            self.assertEqual(ModelClient((model,), transport).complete(self.messages), ("answer", "remote"))

    def test_fallback_receives_identical_unmodified_context(self):
        calls = []
        original = copy.deepcopy(self.messages)
        def transport(request, timeout):
            calls.append(json.loads(request.data)["messages"])
            if len(calls) == 1:
                raise URLError("dummy failure")
            return Response({"message": {"content": "answer"}})
        client = ModelClient((MODEL, replace(MODEL, name="backup")), transport)
        with self.assertLogs(level="WARNING"):
            self.assertEqual(client.complete(self.messages), ("answer", "backup"))
        self.assertEqual(calls[0], calls[1])
        self.assertEqual(self.messages, original)

    def test_missing_key_skips_model_without_http_request(self):
        remote = replace(MODEL, name="remote", protocol="openai", api_key_env="MISSING_TEST_KEY")
        calls = []
        def transport(request, timeout):
            calls.append(request)
            return Response({"message": {"content": "answer"}})
        with patch.dict(os.environ):
            os.environ.pop("MISSING_TEST_KEY", None)
            with self.assertLogs(level="WARNING"):
                self.assertEqual(ModelClient((remote, MODEL), transport).complete(self.messages)[0], "answer")
        self.assertEqual(len(calls), 1)

    def test_invalid_or_empty_responses_fail_without_leaking_response(self):
        for response in ({}, {"message": {"content": ""}}, {"message": {"content": 12}}):
            with self.subTest(response=response), self.assertLogs(level="WARNING"), self.assertRaises(ModelError):
                ModelClient((MODEL,), lambda *_a, **_k: Response(response)).complete(self.messages)

    def test_http_errors_use_sanitized_logs(self):
        def transport(*args, **kwargs):
            raise HTTPError("https://private.example", 401, "dummy-secret-text", {}, io.BytesIO(b"private"))
        with self.assertLogs(level="WARNING") as logs, self.assertRaises(ModelError) as error:
            ModelClient((MODEL,), transport).complete(self.messages)
        rendered = " ".join(logs.output) + str(error.exception)
        self.assertNotIn("dummy-secret-text", rendered)
        self.assertNotIn("private.example", rendered)

    def test_interrupted_http_response_is_reported_as_model_failure(self):
        def transport(*args, **kwargs):
            raise IncompleteRead(b"partial-private-response")
        with self.assertLogs(level="WARNING"), self.assertRaises(ModelError):
            ModelClient((MODEL,), transport).complete(self.messages)


if __name__ == "__main__":
    unittest.main()
