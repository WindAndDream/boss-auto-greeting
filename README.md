# BOSS 直聘自动问候与 AstrBot QQ 通知助手

Windows 本机运行的二次开发版本：保留上游 BOSS 自动沟通脚本的问候语、外部文案 API、已沟通跳过、公司筛选/黑名单、Boss 活跃度、随机间隔、重试、上限、IndexedDB 记录及 JSON/Excel 导出能力，并新增本地桥接、每日保护上限、AstrBot QQ 通知和 QQ 控制命令。

## 快速开始

1. 双击 `启动助手.bat`。
2. 双击 `安装AstrBot插件.bat`，然后在 AstrBot WebUI 重载插件或重启 AstrBot。
3. 在 AstrBot「设置 → API Keys」创建仅含 `im` scope 的 Key，将它写入 `config/config.json` 的 `astrbot.apiKey`。
4. 在 QQ 中发送 `/求职助手 绑定`。
5. 将 `dist/boss-qq-assistant.user.js` 安装到 Tampermonkey。
6. 打开 BOSS 岗位列表，在脚本面板的“QQ 通知桥接”中填写 `config/config.json` 里的 `bridge.token` 并测试连接。

完整步骤见 [使用说明.md](使用说明.md)。

## 安全边界

- 不绕过验证码、访问限制或平台风控；检测到验证码、登录失效或页面异常时停止。
- 只自动发送首轮问候，后续招聘方消息不自动代答。
- API Key、QQ 凭据和简历隐私不进入 Git；桥接服务只监听 `127.0.0.1`。
- 默认每日上限 20 条，可通过 QQ 命令调整到 1–100 条。

## 上游与许可证

本项目基于 [WindAndDream/boss-auto-greeting](https://github.com/WindAndDream/boss-auto-greeting) 二次开发。上游作者署名、MIT License 和免责声明已保留；详见 `LICENSE` 与 `THIRD_PARTY_NOTICES.md`。
