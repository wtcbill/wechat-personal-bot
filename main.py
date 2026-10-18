"""Personal WeChat bot entry point. --check never connects to WeChat."""

import argparse
import logging
from pathlib import Path

from personal_bot.bot import PersonalBot
from personal_bot.chat import ChatService
from personal_bot.config import ConfigError, load_config
from personal_bot.models import ModelClient


def main(argv=None):
    parser = argparse.ArgumentParser(description="个人微信私聊 AI 助手")
    parser.add_argument(
        "--config", type=Path,
        default=Path(__file__).resolve().with_name("config.local.json"),
    )
    parser.add_argument("--check", action="store_true", help="仅验证配置，不连接微信或模型")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        config = load_config(args.config)
    except ConfigError as exc:
        print(f"配置错误：{exc}")
        return 2
    if args.check:
        print("配置有效；未连接微信或调用模型。")
        return 0

    # Importing the app for tests/checks must not load the Windows Hook SDK.
    try:
        from wcferry import Wcf
    except ImportError:
        print("缺少 wcferry，请使用已准备好依赖的 Python 环境。")
        return 2

    wcf = None
    try:
        wcf = Wcf(debug=False)
        if not wcf.self_wxid:
            print("微信身份尚未就绪，请确认已登录。")
            return 2
        bot = PersonalBot(config, ChatService(config, ModelClient(config.models)), wcf)
        bot.run()
    except KeyboardInterrupt:
        logging.info("已停止。")
    except Exception:
        logging.error("微信连接或运行失败，请检查本机客户端及 wcferry 版本。")
        return 1
    finally:
        if wcf is not None:
            try:
                wcf.cleanup()
            except Exception:
                logging.warning("微信连接清理失败。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
