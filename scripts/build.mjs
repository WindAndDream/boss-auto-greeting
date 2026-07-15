import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const input=path.join(root,'zhipin-auto-greeting.user.js');
const output=path.join(root,'dist','boss-qq-assistant.user.js');
const extension=path.join(root,'src','userscript','bridge-extension.js');
fs.mkdirSync(path.dirname(output),{recursive:true});
const upstream=fs.readFileSync(input,'utf8')
  .replace(/^\/\/ @name\s+.*$/m, '// @name         BOSS 直聘自动问候与 QQ 通知助手')
  .replace(/^\/\/ @version\s+.*$/m, '// @version      0.2.0')
  .replace(/^\/\/ @description\s+.*$/m, '// @description  筛选岗位、发送首轮问候、保存记录，并通过本机 AstrBot 向 QQ 推送结果。');
fs.writeFileSync(output, `${upstream.trimEnd()}\n\n${fs.readFileSync(extension,'utf8').trimEnd()}\n`, 'utf8');
console.log(`Built ${output}`);
