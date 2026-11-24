// Optional real Chromium layout smoke test; isolated profile, local fixtures, no AI calls.
// CHROME_PATH may override the installed browser path. Requires Node with WebSocket.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, extname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

let root = resolve(import.meta.dirname, '..');
const recoveryRoot = process.env.ZHIXING_RECOVERY_ROOT ? resolve(process.env.ZHIXING_RECOVERY_ROOT) : null;
const profile = await mkdtemp(join(tmpdir(), 'zhixing-layout-'));
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://local').pathname;
  const file = resolve(root, '.' + path);
  const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' }[extname(file)];
  if (!file.startsWith(root + '\\') && !file.startsWith(root + '/')) { res.writeHead(403).end(); return; }
  if (!type || path.startsWith('/backend/')) { res.writeHead(404).end(); return; }
  try { res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }).end(await readFile(file)); }
  catch { res.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
const watchdog = setTimeout(() => { console.error('Browser smoke test timed out'); browser.kill(); server.close(); process.exit(1); }, 55000);
try {
  const endpoint = await new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(Error('Chromium startup timeout')), 15000);
    browser.on('error', error => { clearTimeout(timer); reject(error); });
    browser.stderr.on('data', chunk => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await once(socket, 'open');
  let seq = 0;
  const pending = new Map(); const errors = [];
  socket.addEventListener('message', e => {
    const msg = JSON.parse(e.data);
    if (msg.id) { const cb = pending.get(msg.id); pending.delete(msg.id); msg.error ? cb.reject(Error(msg.error.message)) : cb.resolve(msg.result); }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params) => send(method, params, sessionId);
  await command('Runtime.enable'); await command('Page.enable'); await command('Network.enable');
  await command('Network.setBlockedURLs', { urls: ['https://zhixing-ai.vercel.app/*'] });
  const evaluate = async expression => {
    const value = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
    return value.result.value;
  };
  const navigate = async page => {
    await command('Page.navigate', { url: `${origin}/${page}.html` });
    for (let i = 0; i < 100; i++) {
      if (await evaluate(`location.pathname === '/${page}.html' && document.readyState === 'complete'`)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw Error('Page load timeout');
  };
  await navigate('index');
  await evaluate(`(async () => {
    const api = await import('./js/data.js');
    await api.addNotification({sender:'测试教师',source:'测试课程群',content:'长通知测试'.repeat(2000), extractionStatus:'pending', extraction:{type:'assignment',course:'程序设计',title:'提交报告',content:'人工确认后提交报告',deadline:null,deadlineDate:'2026-11-28',deadlineText:'28号之前',dateWarning:'推断日期，待确认：原文省略年月，请核对参考日期和跨月含义。',confidence:0.9}});
    await api.createManualTask({title:'长标题测试'.repeat(30),content:'备注内容'.repeat(100),deadlineDate:'2026-11-28'});
  })()`);
  for (const width of [320, 375, 390, 430, 768, 1440]) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    for (const page of ['index', 'notification', 'task']) {
      await navigate(page);
      if (page === 'notification') await evaluate(`document.getElementById('messageForm').hidden = false`);
      if (page === 'task') await evaluate(`document.getElementById('manualEntry').click()`);
      const measure = await evaluate(`({width:innerWidth,scroll:document.documentElement.scrollWidth, bad:[...document.querySelectorAll('input,textarea,select,button')].filter(el=>{const r=el.getBoundingClientRect();const parent=el.parentElement; if(getComputedStyle(parent).overflowX==='auto' && parent.scrollWidth>parent.clientWidth) return false; return r.width>0 && r.height>0 && (r.left < -1 || r.right > innerWidth+1)}).map(el=>el.id||el.className)})`);
      const clientWidth = await evaluate('document.documentElement.clientWidth');
      assert.ok(measure.scroll <= clientWidth + 1, `${page} ${width}px overflow: ${JSON.stringify(measure)}, client=${clientWidth}`);
      assert.deepEqual(measure.bad, [], `${page} ${width}px clipped controls`);
      if (width === 320 || width === 1440) {
        const shot = await command('Page.captureScreenshot', { format: 'png' });
        await writeFile(join(profile, `${page}-${width}.png`), Buffer.from(shot.data, 'base64'));
      }
      if (page === 'task') {
        await evaluate(`document.getElementById('extractClose').click(); document.getElementById('extractEntry').click()`);
        assert.equal(await evaluate(`document.getElementById('taskDeadlineInput').value`), '2026-11-28');
        assert.equal(await evaluate(`(()=>{const field=document.getElementById('taskDeadlineTextInput');field.value=' 28号之前\\n ';return field.value === ' 28号之前\\n ';})()`), true, 'multiline original deadline text stays editable without clipping');
        assert.equal(await evaluate(`!document.getElementById('taskDateHint').hidden && document.getElementById('taskDateHint').textContent.includes('推断日期，待确认')`), true);
        if (width === 320) {
          await evaluate(`document.getElementById('taskDeadlineInput').scrollIntoView({block:'center'})`);
          const shot = await command('Page.captureScreenshot', { format: 'png' });
          await writeFile(join(profile, 'inferred-date-320.png'), Buffer.from(shot.data, 'base64'));
        }
        assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth+1`), true);
        await evaluate(`document.getElementById('extractClose').click(); document.querySelector('.task-card').click()`);
        assert.equal(await evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth+1'), true, 'task detail fits viewport');
      }
      console.log(`PASS Chromium ${page} ${width}px`);
    }
  }
  await navigate('task');
  await evaluate(`(async () => {
    document.getElementById('manualEntry').click();
    document.getElementById('taskTitleInput').value = '浏览器手动任务验证';
    document.getElementById('taskDeadlineInput').value = '2028-02-29';
    document.getElementById('taskTimeInput').value = '20:30';
    document.getElementById('extractSubmit').click();
    for(let i=0;i<100 && !document.getElementById('extractModal').hidden;i++) await new Promise(r=>setTimeout(r,10));
    if(!document.getElementById('extractModal').hidden) throw Error('Manual save failed');
    const api = await import('./js/data.js');
    const task = api.getTasks().find(t=>t.title==='浏览器手动任务验证');
    if(task.deadline !== '2028-02-29T12:30:00.000Z' || task.sourceNotificationId !== null) throw Error('Manual task date/source mismatch');
  })()`);
  await navigate('task');
  assert.ok(await evaluate(`document.getElementById('taskList').textContent.includes('浏览器手动任务验证')`));
  console.log('PASS Chromium manual form save and reload persistence (Beijing time)');
  if (recoveryRoot) {
    const snapshot = () => evaluate(`(async()=>{const api=await import('./js/data.js');return JSON.stringify({notifications:api.getNotifications(),tasks:api.getTasks()})})()`);
    const before = await snapshot();
    root = recoveryRoot; // Same origin/profile, different release assets, untouched fixture data.
    for (const page of ['index', 'notification', 'task']) {
      await navigate(page);
      assert.equal(await snapshot(), before, 'recovery page reads must not rewrite stored records');
    }
    assert.ok(await evaluate(`document.getElementById('taskList').textContent.includes('浏览器手动任务验证')`));
    await evaluate(`document.getElementById('extractEntry').click()`);
    assert.equal(await evaluate(`document.getElementById('taskDeadlineInput').value`), '2026-11-28');
    assert.ok(await evaluate(`document.getElementById('taskDateHint').textContent.includes('推断日期，待确认')`));
    console.log('PASS Chromium same-origin recovery: three pages, manual task, date-only draft and inference warning survive without data migration');
  }
  assert.deepEqual(errors, [], 'No uncaught page errors');
  console.log(`Screenshots and isolated profile: ${profile}`);
} finally {
  clearTimeout(watchdog);
  socket?.close(); browser.kill(); server.close();
}
