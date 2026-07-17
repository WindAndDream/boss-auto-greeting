# BOSS 直聘自动问候与 AstrBot QQ 通知助手

> 本项目基于原作者 **WindAndDream** 的开源项目
> [WindAndDream/boss-auto-greeting](https://github.com/WindAndDream/boss-auto-greeting)
> 进行二次开发。感谢原作者提供 BOSS 直聘自动沟通脚本及其核心实现。

本项目不是原作者的官方版本。它面向 Windows 本机使用，在保留原项目问候语、外部文案 API、已沟通跳过、公司筛选/黑名单、Boss 活跃度、随机间隔、重试、IndexedDB 记录及 JSON/Excel 导出等能力的基础上，重点增加了 **AstrBot QQ 通知与远程控制插件**、本地安全桥接、每日定时停止、每 20 条汇总通知和 HR 回复特别提醒。

## AstrBot 插件功能（本项目重点）

本项目内置 `astrbot_plugin_boss_job_assistant` 插件，将浏览器中的 BOSS 自动沟通状态通过本机桥接服务接入 AstrBot 和 QQ：

- 将当前 QQ 私聊或群聊绑定为通知目标。
- 每完成 20 条普通投递向 QQ 汇报一次，减少逐条消息干扰。
- 检测到 HR 新回复时立即发送特别提醒；没有新回复时保持静默。
- 支持通过 QQ 查看运行状态、今日记录及计划停止时间。
- 支持通过 QQ 暂停或恢复运行许可，并设置每日停止时间。
- 验证码、登录失效和计划停止等系统事件会即时提醒。
- 本地桥接仅监听 `127.0.0.1`，使用独立令牌鉴权；API Key 和本机个性化脚本不会提交到 Git。

可用命令包括：

```text
/求职助手 绑定
/求职助手 状态
/求职助手 暂停
/求职助手 开始
/求职助手 今日记录
/求职助手 停止时间 18:00
/求职助手 帮助
```

QQ 中的“开始”只恢复运行许可，实际自动浏览仍需在 BOSS 网页面板点击“开始任务”。插件不会代替用户自动回复 HR。

## 快速开始

1. 双击 `启动助手.bat`。
2. 双击 `安装AstrBot插件.bat`，然后在 AstrBot WebUI 重载插件或重启 AstrBot。
3. 在 AstrBot「设置 → API Keys」创建仅含 `im` scope 的 Key，将它写入 `config/config.json` 的 `astrbot.apiKey`。
4. 在 QQ 中发送 `/求职助手 绑定`。
5. 将 `dist/boss-qq-assistant.user.js` 安装到 Tampermonkey。
6. 打开 BOSS 岗位列表，在脚本面板的“QQ 通知桥接”中选择停止时间并测试连接。本机个性化安装包会自动填写桥接令牌。

完整步骤见 [使用说明.md](使用说明.md)。

## 安全边界

- 不绕过验证码、访问限制或平台风控；检测到验证码、登录失效或页面异常时停止。
- 只自动发送首轮问候，后续招聘方消息不自动代答；检测到 HR 新回复时只做 QQ 特别提醒。
- API Key、QQ 凭据和简历隐私不进入 Git；桥接服务只监听 `127.0.0.1`。
- 沟通数量不设上限；默认每天 18:00 停止，可在浏览器面板或用 `/求职助手 停止时间 18:00` 修改。
- 普通投递每累计 20 条向 QQ 汇报一次；没有 HR 新回复时，回复提醒保持静默。

## 上游与许可证

- 原作者：**WindAndDream**
- 原项目代码仓库：[WindAndDream/boss-auto-greeting](https://github.com/WindAndDream/boss-auto-greeting)
- 本项目性质：基于上述原项目的非官方二次开发版本

原作者署名、MIT License 和免责声明均已保留；详见 `LICENSE` 与 `THIRD_PARTY_NOTICES.md`。本项目新增的 AstrBot 插件、本地桥接和 QQ 通知功能不代表原作者提供或维护。
