import asyncio
import json
import urllib.error
import urllib.request

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star


class BossJobAssistant(Star):
    def __init__(self, context: Context, config: AstrBotConfig):
        super().__init__(context)
        self.config = config

    def _call_sync(self, method: str, path: str, payload=None):
        base = str(self.config.get("bridge_url", "http://127.0.0.1:17861")).rstrip("/")
        token = str(self.config.get("bridge_token", ""))
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(
            f"{base}{path}", data=data, method=method,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=8) as response:
            return json.loads(response.read().decode("utf-8"))

    async def _call(self, method: str, path: str, payload=None):
        try:
            return await asyncio.to_thread(self._call_sync, method, path, payload)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            logger.warning(f"BOSS 求职助手桥接请求失败: {exc}")
            raise RuntimeError("无法连接本机求职助手，请先双击“启动助手.bat”。") from exc

    @filter.command_group("求职助手")
    def job_assistant(self):
        """BOSS 求职助手控制命令"""
        pass

    @job_assistant.command("绑定")
    async def bind(self, event: AstrMessageEvent):
        await self._call("POST", "/api/v1/bind", {"umo": event.unified_msg_origin})
        yield event.plain_result("绑定成功，后续 BOSS 执行结果将发送到当前会话。")

    @job_assistant.command("状态")
    async def status(self, event: AstrMessageEvent):
        data = await self._call("GET", "/api/v1/status")
        state = data["state"]
        schedule = "今日停止时间已到" if data.get("scheduledStopReached") else f"计划 {state['stopTime']} 停止"
        yield event.plain_result(f"状态：{'运行许可开启' if state['enabled'] else '已暂停'}\n今日已投递：{data['todayCount']} 条（每 20 条通知）\n停止计划：{schedule}\nQQ 绑定：{'已绑定' if data['bound'] else '未绑定'}")

    @job_assistant.command("暂停")
    async def pause(self, event: AstrMessageEvent):
        await self._call("POST", "/api/v1/control", {"enabled": False})
        yield event.plain_result("求职助手已暂停。")

    @job_assistant.command("开始")
    async def start(self, event: AstrMessageEvent):
        await self._call("POST", "/api/v1/control", {"enabled": True})
        yield event.plain_result("求职助手已允许运行；仍需在 BOSS 网页面板点击“开始任务”。")

    @job_assistant.command("今日记录")
    async def today(self, event: AstrMessageEvent):
        data = await self._call("GET", "/api/v1/status")
        yield event.plain_result(f"今日已发送 {data['todayCount']} 条，累计保存 {data['total']} 条事件。")

    @job_assistant.command("停止时间")
    async def stop_time(self, event: AstrMessageEvent, time_value: str):
        data = await self._call("POST", "/api/v1/control", {"stopTime": time_value})
        yield event.plain_result(f"每日停止时间已设为 {data['state']['stopTime']}。沟通数量不设上限。")

    @job_assistant.command("帮助")
    async def help(self, event: AstrMessageEvent):
        yield event.plain_result("可用命令：\n/求职助手 绑定\n/求职助手 状态\n/求职助手 暂停\n/求职助手 开始\n/求职助手 今日记录\n/求职助手 停止时间 18:00\n/求职助手 帮助")
