/*
 * 平台弹窗回归测试入口。
 *
 * 运行：node tests/run-dialog-tests.mjs
 *
 * 做法：
 * - 生成一个本地 HTML，按顺序内联真实 userscript 和 dialog-tests.js；
 * - Chrome 以 --dump-dom 打开 file:// 页面，页面把测试结果写入 <title>；
 * - Node 解析 <title> 并输出 PASS/FAIL。
 *
 * 不依赖 npm 包、不需要网络和测试服务器；只需要本机 Chrome/Edge。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const userscriptPath = path.join(repoRoot, 'zhipin-auto-greeting.user.js');

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function buildPageHtml(userscript, testScript) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>RUNNING</title>
  <script>
    window.__ZHIPIN_AUTO_GREETING_TEST_HOOK__ = true;
    window.__dialogTestErrors = [];
    window.addEventListener('error', function (event) {
      window.__dialogTestErrors.push(String(event.message || event.error || 'unknown'));
    });
  </script>
</head>
<body>
  <div id="test-stage"></div>
  <script>${userscript}</script>
  <script>${testScript}</script>
  <pre id="test-output"></pre>
</body>
</html>`;
}

function main() {
  const chrome = findChrome();
  if (!chrome) throw new Error('未找到 Chrome/Edge，可通过 CHROME_PATH 指定');

  const userscript = fs.readFileSync(userscriptPath, 'utf8');
  const testScript = fs.readFileSync(path.join(here, 'dialog-tests.js'), 'utf8');
  if (userscript.includes('</script>') || testScript.includes('</script>')) {
    throw new Error('脚本内容包含 </script>，无法安全内联到测试页');
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhipin-dialog-test-'));
  const pagePath = path.join(tmpDir, 'dialog-tests.html');
  const domPath = path.join(tmpDir, 'dom.html');
  const errorPath = path.join(tmpDir, 'chrome-error.log');
  fs.writeFileSync(pagePath, buildPageHtml(userscript, testScript), 'utf8');

  const outFd = fs.openSync(domPath, 'w');
  const errFd = fs.openSync(errorPath, 'w');

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--allow-file-access-from-files',
    `--user-data-dir=${path.join(tmpDir, 'chrome-profile')}`,
    '--window-size=1200,900',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--dump-dom',
    pathToFileURL(pagePath).href,
  ];

  let chromeResult;
  try {
    chromeResult = spawnSync(chrome, args, {
      stdio: ['ignore', outFd, errFd],
      timeout: 60000,
      windowsHide: true,
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }

  const dom = fs.existsSync(domPath) ? fs.readFileSync(domPath, 'utf8') : '';
  const chromeError = fs.existsSync(errorPath) ? fs.readFileSync(errorPath, 'utf8') : '';

  let results = null;
  const match = dom.match(/<title>RESULT:([A-Za-z0-9+/=]+)<\/title>/);
  if (match) {
    try {
      results = JSON.parse(decodeURIComponent(Buffer.from(match[1], 'base64').toString('utf8')));
    } catch (error) {
      console.error('测试结果解码失败：', error.message);
    }
  }

  if (!results) {
    console.error('未拿到测试结果。');
    console.error(`Chrome exit: ${chromeResult && chromeResult.status}, signal: ${chromeResult && chromeResult.signal}`);
    if (chromeError.trim()) console.error(chromeError.trim().slice(-2000));
    if (dom.trim()) console.error(dom.slice(0, 2000));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
    process.exit(1);
  }

  let failed = 0;
  for (const item of results) {
    const label = item.ok ? 'PASS' : 'FAIL';
    if (!item.ok) failed += 1;
    console.log(`[${label}] ${item.name}${item.detail ? ` (${item.detail})` : ''}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}
  process.exit(failed ? 1 : 0);
}

try {
  main();
} catch (error) {
  console.error(error && error.stack || String(error));
  process.exit(1);
}
