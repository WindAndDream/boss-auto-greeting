# Boss 直聘自动打招呼脚本

基于篡改猴（油猴）的 JavaScript 脚本，用于筛选岗位条件，自动向岗位 hr 打招呼。



## 技术栈

- 原生 JavaScript（ES6+）Tampermonkey / 油猴 Userscript。
- 无构建流程、无包管理器、无前端框架；`.user.js` 文件需要能直接安装运行。
- 运行在浏览器页面环境，主要目标是 Chrome / Edge + Tampermonkey。
- 主要使用浏览器原生 API：DOM、事件模拟、History API、MutationObserver、fetch / XMLHttpRequest、IndexedDB、localStorage。
- Excel 导出按需从 CDN 懒加载 SheetJS `xlsx@0.20.3`。



## 维护约定

- 优先保持单文件脚本结构，不要引入构建工具、框架或复杂依赖。
- 修改页面逻辑时，要考虑 BOSS 直聘是 SPA，列表页和聊天页可能通过 history 跳转而不是整页刷新。
- 主脚本依赖 `document-start` 阶段提前注入，用于拦截接口和保存原生方法引用，避免随意调整 userscript header。
- 岗位记录存储在 IndexedDB；配置、运行状态和调试事件存储在 localStorage。
- 网络请求优先使用页面 fetch；当页面策略或跨域限制影响请求时，使用 `GM_xmlhttpRequest` 兜底。
- UI 使用原生 DOM 和内联样式实现，不要改成 Vue / React / jQuery。



## 关键文件

- `zhipin-auto-greeting.user.js`：主脚本，负责岗位筛选、自动沟通、记录存储、导出和控制面板。
- `zhipin-devtools-unlock.user.js`：本地调试辅助脚本，用于降低页面反调试逻辑对 DevTools 的干扰。
- `tests/dialog-tests.js`：平台弹窗识别的浏览器侧回归测试。
- `tests/run-dialog-tests.mjs`：测试入口，无依赖，使用本机 Chrome/Edge 运行。
- `README.md`：面向用户的简要说明。
- `AGENTS.md`：面向 AI 维护者的项目上下文和约束。



## 测试

- 运行 `node tests/run-dialog-tests.mjs`，需要本机 Chrome 或 Edge（也可用 `CHROME_PATH` 指定）。
- 测试页通过 `file://` 加载真实 userscript，覆盖“已向BOSS发送消息”、沟通次数提醒、硬限制和普通内容误判等场景。




## 代码规范

- 数据结构：在代码阅读性、空间、时间三者之间平衡，对于复杂需求，使用符合要求的数据结构。
- 逻辑耦合：依赖抽象而非具体实现，在适合解耦合的地方进行拆分，但不要过度抽象和解耦。
- 代码冗余：不要过度将多个功能同时存入一个函数之中，拆分功能板块、函数原子化。
- 代码注释：当新增了一些核心功能和工具函数的时候，需要补充代码注释，说明用途和意义。



## 输出偏好

每次搞定任务后，回复结果的时候，都要以“好厚米”开头，剩下没啥了，避免浪费你太多token，ai兄弟。
