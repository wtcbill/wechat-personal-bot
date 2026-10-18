"""Conversation state is in memory only, independent of the selected model."""

from personal_bot.models import ModelError


HELP = (
    "直接发文字即可与 AI 对话。\n"
    "/help 或 帮助：查看帮助\n"
    "/reset 或 新建会话：清空当前上下文\n"
    "/status：查看会话状态\n"
    "上下文只保存在内存中，重启后清空。"
)


class ChatService:
    def __init__(self, config, client):
        self.config = config
        self.client = client
        self._history = {}

    def respond(self, session_id, text):
        text = text.strip()
        if not text:
            return ""
        if text in ("/help", "帮助"):
            return HELP
        if text in ("/reset", "新建会话", "清空上下文"):
            self._history.pop(session_id, None)
            return "已新建会话，之前的上下文已清空。"
        if text == "/status":
            return f"当前上下文：{len(self._history.get(session_id, [])) // 2} 轮，仅存于内存。"
        if len(text) > self.config.max_message_chars:
            return f"消息过长，请拆分为每条不超过 {self.config.max_message_chars} 字符。"
        messages = [
            {"role": "system", "content": self.config.system_prompt},
            *[dict(message) for message in self._history.get(session_id, [])],
            {"role": "user", "content": text},
        ]
        try:
            answer, _ = self.client.complete(messages)
        except ModelError:
            return "模型暂时不可用，请检查模型服务或配置后重试。"
        history = self._history.setdefault(session_id, [])
        history.extend((
            {"role": "user", "content": text},
            {"role": "assistant", "content": answer},
        ))
        self._history[session_id] = history[-2 * self.config.max_history_turns:]
        return answer
