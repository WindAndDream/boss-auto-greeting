import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'config', 'config.json');
const sourcePath = path.join(root, 'dist', 'boss-qq-assistant.user.js');
const outputPath = path.join(root, 'dist', 'boss-qq-assistant.personal.user.js');

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const token = String(config.bridge?.token || '');
if (!token) throw new Error('config/config.json is missing bridge.token');

const source = fs.readFileSync(sourcePath, 'utf8');
const needle = "const defaults = { url: 'http://127.0.0.1:17861', token: '', enabled: true, stopTime: '18:00' };";
if (!source.includes(needle)) throw new Error('userscript token placeholder was not found; run the normal build first');

const personalized = source.replace(
  needle,
  `const defaults = { url: 'http://127.0.0.1:17861', token: ${JSON.stringify(token)}, enabled: true, stopTime: '18:00' };`,
);
fs.writeFileSync(outputPath, personalized, 'utf8');
console.log(`Personal installer created: ${outputPath}`);
