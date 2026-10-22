#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../miniapp');
const app = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8'));
let templates=0;
for(const page of app.pages){
 for(const ext of ['js','wxml'])assert(existsSync(join(root,`${page}.${ext}`)),`${page}.${ext} missing`);
 const source=readFileSync(join(root,`${page}.js`),'utf8');
 const markup=readFileSync(join(root,`${page}.wxml`),'utf8');
 const handlers=[...markup.matchAll(/(?:bind|catch)(?::)?[a-zA-Z]+\s*=\s*["']([a-zA-Z_$][\w$]*)["']/g)].map(m=>m[1]);
 for(const handler of handlers)assert(new RegExp(`(?:async\\s+)?${handler}\\s*\\(`).test(source),`${page}: event handler ${handler} missing`);
 for(const [,expression] of markup.matchAll(/{{([\s\S]*?)}}/g)) assert(!/\.[\w$]+\s*\(/.test(expression),`${page}: WXML method call unsupported: ${expression}`);
 templates++;
}
const files=[];
function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){if(entry.name==='node_modules')continue;const file=join(dir,entry.name);if(entry.isDirectory())walk(file);else files.push(file);}}
walk(root);
for(const file of files){
 if(file.endsWith('.json'))JSON.parse(readFileSync(file,'utf8'));
 if(file.endsWith('.js')){const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);}
}
for(const tab of app.tabBar.list)assert(app.pages.includes(tab.pagePath));
console.log(`PASS: ${templates} pages, event handlers, WXML expressions, JS syntax, JSON and tab routing. Real WeChat compilation still required.`);
