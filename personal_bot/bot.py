"""Route private text messages to isolated conversations."""

import logging
from collections import deque
from queue import Empty


class PersonalBot:
    def __init__(self, config, chat, wcf):
        self.config = config
        self.chat = chat
        self.wcf = wcf
        self._seen = set()
        self._seen_order = deque()

    def accepts(self, message):
        sender = getattr(message, "sender", "")
        if not isinstance(sender, str) or not sender or sender.startswith("gh_") or sender == self.wcf.self_wxid:
            return False
        if getattr(message, "roomid", "") or getattr(message, "type", None) != 1:
            return False
        if message.from_self() or message.from_group():
            return False
        return isinstance(getattr(message, "content", None), str)

    def handle_message(self, message):
        if not self.accepts(message):
            return False
        msg_id = str(getattr(message, "id", "") or "")
        message_key = (message.sender, msg_id)
        if msg_id and message_key in self._seen:
            return False
        text = message.content.strip()
        if not text:
            return False
        if msg_id:
            self._seen.add(message_key)
            self._seen_order.append(message_key)
            if len(self._seen_order) > 1000:
                self._seen.discard(self._seen_order.popleft())
        answer = self.chat.respond(message.sender, text)
        size = self.config.reply_chunk_chars
        for offset in range(0, len(answer), size):
            status = self.wcf.send_text(answer[offset:offset + size], receiver=message.sender)
            if status != 0:
                logging.error("私聊回复发送失败；未自动重发。")
                return False
        return True

    def run(self):
        if not self.wcf.enable_receiving_msg():
            raise RuntimeError("无法开启微信消息接收")
        logging.info("个人私聊 Bot 已启动。")
        # Wcf already queues incoming messages. One consumer preserves their order.
        while self.wcf.is_receiving_msg():
            try:
                message = self.wcf.get_msg()
            except Empty:
                continue
            try:
                self.handle_message(message)
            except Exception:
                logging.error("消息处理失败；未输出消息内容或自动重发。")
