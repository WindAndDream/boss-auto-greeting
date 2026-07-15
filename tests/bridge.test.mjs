import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('example config is valid and safe',()=>{const c=JSON.parse(fs.readFileSync(new URL('../config/config.example.json',import.meta.url),'utf8'));assert.equal(c.bridge.host,'127.0.0.1');assert.equal(c.astrbot.apiKey,'');assert.ok(c.automation.dailyLimit<=20);});
test('userscript extension contains safety stop and no embedded secret',()=>{const s=fs.readFileSync(new URL('../src/userscript/bridge-extension.js',import.meta.url),'utf8');assert.match(s,/emergencyStop/);assert.doesNotMatch(s,/sk-[A-Za-z0-9]{20}/);});
