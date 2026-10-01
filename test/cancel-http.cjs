'use strict';

/**
 * 进路延时取消 HTTP 集成测试：
 *   临时库启动真实服务 → 管理员/值班员登录 → 端到端验证延时取消申请的
 *   申请条件、立即回红/锁闭保留、重复申请幂等、保护时长设置快照不追改、
 *   到期解除（沿途空闲）、到期条件不符终止保留锁闭、保护期内首段占用受理并
 *   终止、等待申请不得提前兑现/解除后兑现、人工解除接口约定保持、
 *   服务重启后继续处理未到期与已到期申请、管理员重置一并清除。
 *
 * 运行：node test/cancel-http.cjs
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.TEST_PORT || 3927;
const DB_PATH = process.env.SMOKE_DB_CANCEL || path.join(__dirname, '..', 'data', 'cancel-test.db');
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
function ok(name, cond, extra) {
  if (!cond) throw new Error(name + (extra ? `（${JSON.stringify(extra)}）` : ''));
  console.log('  ✓', name);
  passed++;
}
function eq(name, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${name}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
  console.log('  ✓', name);
  passed++;
}

let server = null;
function startServer(keepDb = false) {
  return new Promise((resolve, reject) => {
    if (!keepDb) {
      for (const ext of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(DB_PATH + ext); } catch (_) {}
      }
    }
    server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), DB_PATH, SEED_DEMO: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error('服务启动超时: ' + out)), 10000);
    server.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('已启动')) { clearTimeout(timer); resolve(); }
    });
    server.stderr.on('data', (d) => { out += d.toString(); });
    server.on('exit', (code) => { if (code !== 0) reject(new Error('服务异常退出: ' + out)); });
  });
}
function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.on('exit', () => { server = null; resolve(); });
    server.kill('SIGTERM');
    setTimeout(() => { try { server.kill('SIGKILL'); } catch (_) {} }, 3000);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathName, { token, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const resp = await fetch(BASE + pathName, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await resp.json(); } catch (_) {}
  return { status: resp.status, data };
}

async function login(role, nameOrPwd) {
  const body = role === 'admin' ? { password: nameOrPwd || 'admin123' } : { name: nameOrPwd };
  const { status, data } = await api(`/api/auth/login/${role}`, { method: 'POST', body });
  if (status !== 200) throw new Error('登录失败: ' + data.error);
  return data.token;
}

async function walkThrough(token, instanceId, sections) {
  let seq = 1;
  for (let i = 0; i < sections.length; i++) {
    await api(`/api/instances/${instanceId}/events`,
      { token, method: 'POST', body: { seq: seq++, sectionId: sections[i], action: 'occupy' } });
    if (i >= 1) {
      await api(`/api/instances/${instanceId}/events`,
        { token, method: 'POST', body: { seq: seq++, sectionId: sections[i - 1], action: 'clear' } });
    }
  }
  await api(`/api/instances/${instanceId}/events`,
    { token, method: 'POST', body: { seq: seq++, sectionId: sections[sections.length - 1], action: 'clear' } });
}

/** 按 [[seq, sectionId, action], ...] 顺序提交，任一非 200 即抛错 */
async function sendEvents(token, instanceId, events) {
  for (const [seq, sectionId, action] of events) {
    const r = await api(`/api/instances/${instanceId}/events`,
      { token, method: 'POST', body: { seq, sectionId, action } });
    if (r.status !== 200) throw new Error(`事件 seq=${seq} ${action} ${sectionId} 失败: ${r.data.error}`);
  }
}

/** 测试中直接改库（模拟外部条件变化，重启场景使用） */
function withDb(fn) {
  const Database = require('better-sqlite3');
  const d = new Database(DB_PATH);
  try { fn(d); } finally { d.close(); }
}

async function main() {
  await startServer();
  const admin = await login('admin');
  const jia = await login('dispatcher', '值班员甲');
  const yi = await login('dispatcher', '值班员乙');

  console.log('\n[1] 鉴权：未登录/管理员不能访问值班员延时取消接口');
  let r = await api('/api/cancel-requests', {});
  eq('未登录 401', r.status, 401);
  r = await api('/api/cancel-requests', { token: admin });
  eq('管理员访问 403', r.status, 403);

  console.log('\n[2] 管理员保护时长设置：必须正整数；默认 120；修改不追改已有申请');
  r = await api('/api/admin/settings/cancel-protect-seconds', { token: admin });
  eq('读取默认保护时长', r.data.protectSeconds, 120);
  r = await api('/api/admin/settings/cancel-protect-seconds',
    { token: admin, method: 'PUT', body: { seconds: 0 } });
  eq('0 被拒绝 400', r.status, 400);
  eq('错误码 BAD_PROTECT_SECONDS', r.data.code, 'BAD_PROTECT_SECONDS');
  r = await api('/api/admin/settings/cancel-protect-seconds',
    { token: admin, method: 'PUT', body: { seconds: 2.5 } });
  eq('小数被拒绝 400', r.status, 400);
  r = await api('/api/admin/settings/cancel-protect-seconds',
    { token: admin, method: 'PUT', body: { seconds: 360 } });
  eq('设置为 360 秒成功', r.status, 200);
  eq('返回新值', r.data.protectSeconds, 360);

  console.log('\n[3] 申请条件：不存在/已解除实例拒绝；开放且无占用可申请');
  r = await api('/api/instances/9999/cancel-request', { token: jia, method: 'POST' });
  eq('不存在实例 404', r.status, 404);
  eq('错误码 INSTANCE_NOT_FOUND', r.data.code, 'INSTANCE_NOT_FOUND');

  // 开放 R1（保护时长当前 360 秒）
  r = await api('/api/routes/R1/open', { token: jia, method: 'POST',
    body: { switchPositions: { SW7: 'N', SW8: 'N' } } });
  eq('R1 开放成功', r.status, 200);
  const inst1 = r.data.instance.id;
  eq('开放时信号绿', r.data.instance.signalState, 'green');

  r = await api(`/api/instances/${inst1}/cancel-request`, { token: jia, method: 'POST' });
  eq('申请成功 200', r.status, 200);
  eq('不是重复申请', r.data.duplicate, false);
  const c1 = r.data.cancellation;
  eq('c1 等待中', c1.status, 'pending');
  eq('c1 快照保护时长 360', c1.protectSeconds, 360);
  ok('最早解除时间在约 360 秒后',
    Math.abs((c1.releaseAtMs - Date.now()) - 360000) < 5000, { remain: c1.remainingMs });
  eq('关联实例正确', c1.instanceId, inst1);
  eq('申请人记录正确', c1.applicant, '值班员甲');

  console.log('\n[4] 申请立即令入口信号回红，区段与道岔锁保留');
  let st = (await api('/api/state', { token: jia })).data.state;
  let instRow = st.openInstances.find((x) => x.id === inst1);
  eq('信号已回红', instRow.signalState, 'red');
  eq('区段锁保留(3)', instRow.lockedSections.length, 3);
  eq('道岔锁保留(2)', instRow.lockedSwitches.length, 2);

  console.log('\n[5] 重复申请：不缩短期限、不产生第二笔');
  const before = c1.releaseAtMs;
  await sleep(20);
  r = await api(`/api/instances/${inst1}/cancel-request`, { token: yi, method: 'POST' });
  eq('重复申请 200', r.status, 200);
  eq('标记 duplicate', r.data.duplicate, true);
  eq('返回同一笔申请', r.data.cancellation.id, c1.id);
  eq('最早解除时间未变（不缩短）', r.data.cancellation.releaseAtMs, before);
  r = await api('/api/cancel-requests?scope=all', { token: jia });
  eq('只有一笔申请', r.data.cancellations.length, 1);

  console.log('\n[6] 等待中的取消申请不得提前兑现共享资源的等待申请');
  // 乙对 R1 提交等待申请：资源被 #inst1 锁（取消保护期内仍锁定）→ 必须等待
  r = await api('/api/routes/R1/waiting', { token: yi, method: 'POST',
    body: { switchPositions: { SW7: 'N', SW8: 'N' } } });
  eq('R1 等待申请进入等待', r.data.waiting.status, 'waiting');
  const w1id = r.data.waiting.id;
  ok('阻断原因含锁闭', r.data.waiting.blockReasons.some((x) => x.includes('锁')), r.data.waiting.blockReasons);
  st = (await api('/api/state', { token: jia })).data.state;
  eq('保护期内仍只有 1 个开放实例（未提前兑现）', st.openInstances.length, 1);

  console.log('\n[7] 保护期内首段占用事件：按走行规则受理并终止取消，锁闭保留，可继续走行');
  r = await api(`/api/instances/${inst1}/events`, { token: jia, method: 'POST',
    body: { seq: 1, sectionId: '1', action: 'occupy' } });
  eq('首段占用受理', r.status, 200);
  ok('返回终止的取消申请编号', r.data.result.cancellationAbortedId === c1.id, r.data.result);
  r = await api('/api/cancel-requests', { token: jia });
  const c1after = r.data.cancellations.find((x) => x.id === c1.id);
  eq('c1 已终止', c1after.status, 'aborted');
  ok('终止原因说明首段占用', c1after.endReason.includes('首段'), c1after.endReason);
  // 同号同内容重传幂等，不影响状态
  r = await api(`/api/instances/${inst1}/events`, { token: jia, method: 'POST',
    body: { seq: 1, sectionId: '1', action: 'occupy' } });
  eq('重传幂等', r.data.result.idempotent, true);
  eq('重传不重复返回终止', r.data.result.cancellationAbortedId, undefined);
  // 走行完毕自动解除 → 等待申请兑现（首段1已占用 seq1）
  await sendEvents(jia, inst1, [
    [2, '3', 'occupy'], [3, '1', 'clear'],
    [4, '5', 'occupy'], [5, '3', 'clear'], [6, '5', 'clear']
  ]);
  r = await api('/api/waiting', { token: yi });
  const w1 = r.data.waiting.find((x) => x.id === w1id);
  eq('进路解除后等待申请兑现', w1.status, 'fulfilled');
  // 清理兑现实例（由申请人乙办理走行）
  await walkThrough(yi, w1.instanceId, ['1', '3', '5']);

  console.log('\n[8] 已有走行占用记录的进路不能申请延时取消');
  await api('/api/switches/SW7/move', { token: jia, method: 'POST', body: { position: 'N' } });
  await api('/api/switches/SW8/move', { token: jia, method: 'POST', body: { position: 'R' } });
  r = await api('/api/routes/R2/open', { token: jia, method: 'POST',
    body: { switchPositions: { SW7: 'N', SW8: 'R' } } });
  eq('R2 开放成功', r.status, 200);
  const inst2 = r.data.instance.id;
  await api(`/api/instances/${inst2}/events`, { token: jia, method: 'POST',
    body: { seq: 1, sectionId: '1', action: 'occupy' } });
  r = await api(`/api/instances/${inst2}/cancel-request`, { token: jia, method: 'POST' });
  eq('已走行拒绝申请 409', r.status, 409);
  eq('错误码 ROUTE_ALREADY_OCCUPIED', r.data.code, 'ROUTE_ALREADY_OCCUPIED');
  // 清理 R2（区段顺序 1,3,4，首段1已占 seq1）
  await sendEvents(jia, inst2, [
    [2, '3', 'occupy'], [3, '1', 'clear'],
    [4, '4', 'occupy'], [5, '3', 'clear'], [6, '4', 'clear']
  ]);

  console.log('\n[9] 人工解除接口约定保持（末段未清空拒绝）');
  await api('/api/switches/SW7/move', { token: jia, method: 'POST', body: { position: 'R' } });
  await api('/api/switches/SW8/move', { token: jia, method: 'POST', body: { position: 'N' } });
  r = await api('/api/routes/R3/open', { token: jia, method: 'POST',
    body: { switchPositions: { SW7: 'R', SW8: 'N' } } });
  const inst3 = r.data.instance.id;
  r = await api(`/api/instances/${inst3}/cancel-request`, { token: jia, method: 'POST' });
  eq('R3 取消申请提交', r.status, 200);
  r = await api(`/api/instances/${inst3}/release`, { token: jia, method: 'POST' });
  eq('保护期内人工解除仍被拒绝 409', r.status, 409);
  eq('错误码保持 LAST_SECTION_NOT_CLEARED', r.data.code, 'LAST_SECTION_NOT_CLEARED');

  console.log('\n[10] 管理员改短保护时长：只影响新申请；旧申请快照不变');
  r = await api('/api/admin/settings/cancel-protect-seconds',
    { token: admin, method: 'PUT', body: { seconds: 2 } });
  eq('改保护时长为 2 秒', r.status, 200);
  r = await api('/api/cancel-requests', { token: jia });
  const cOld = r.data.cancellations.find((x) => x.instanceId === inst3);
  eq('旧申请仍为 360 秒快照（不追改）', cOld.protectSeconds, 360);

  console.log('\n[11] 到期复核通过：事务内解除进路并触发等待兑现');
  // inst3（R3）取消申请快照 360 秒，先把它终止掉，改用新申请验证到期解除
  await api(`/api/instances/${inst3}/events`, { token: jia, method: 'POST',
    body: { seq: 1, sectionId: '2', action: 'occupy' } });
  // R3 区段顺序 2,3,5
  await sendEvents(jia, inst3, [
    [2, '3', 'occupy'], [3, '2', 'clear'],
    [4, '5', 'occupy'], [5, '3', 'clear'], [6, '5', 'clear']
  ]);
  // 新开放 R1 并申请（当前保护 2 秒），同时排一条共享资源的等待申请
  await api('/api/switches/SW7/move', { token: jia, method: 'POST', body: { position: 'N' } });
  await api('/api/switches/SW8/move', { token: jia, method: 'POST', body: { position: 'N' } });
  r = await api('/api/routes/R1/open', { token: jia, method: 'POST',
    body: { switchPositions: { SW7: 'N', SW8: 'N' } } });
  const inst4 = r.data.instance.id;
  r = await api('/api/routes/R1/waiting', { token: yi, method: 'POST',
    body: { switchPositions: { SW7: 'N', SW8: 'N' } } });
  const w2id = r.data.waiting.id;
  eq('等待申请先排队', r.data.waiting.status, 'waiting');
  r = await api(`/api/instances/${inst4}/cancel-request`, { token: jia, method: 'POST' });
  const c4 = r.data.cancellation;
  eq('新申请快照 2 秒', c4.protectSeconds, 2);
  // 到期前等待不兑现
  st = (await api('/api/state', { token: jia })).data.state;
  eq('到期前仍只 1 个开放实例', st.openInstances.length, 1);
  await sleep(2600);
  st = (await api('/api/state', { token: jia })).data.state;
  const c4row = (await api('/api/cancel-requests', { token: jia })).data.cancellations
    .find((x) => x.id === c4.id);
  eq('到期申请状态 released', c4row.status, 'released');
  ok('到期解除实例不再在开放列表', !st.openInstances.some((x) => x.id === inst4));
  const w2 = (await api('/api/waiting', { token: yi })).data.waiting.find((x) => x.id === w2id);
  eq('解除瞬间触发等待兑现', w2.status, 'fulfilled');
  eq('等待兑现为新实例', w2.instanceId !== inst4, true);
  // 清理
  await walkThrough(yi, w2.instanceId, ['1', '3', '5']);

  console.log('\n[12] 到期时沿途区段非空闲：终止申请、保留锁闭与红灯');
  r = await api('/api/admin/settings/cancel-protect-seconds',
    { token: admin, method: 'PUT', body: { seconds: 1 } });
  r = await api('/api/routes/R1/open', { token: jia, method: 'POST',
    body: { switchPositions: { SW7: 'N', SW8: 'N' } } });
  const inst5 = r.data.instance.id;
  r = await api(`/api/instances/${inst5}/cancel-request`, { token: jia, method: 'POST' });
  const c5 = r.data.cancellation.id;
  // 外部把锁闭中的沿途区段置为占用（排路前接口允许占用锁闭区段）
  await api('/api/sections/3/state', { token: jia, method: 'POST', body: { action: 'occupy' } });
  await sleep(1500);
  st = (await api('/api/state', { token: jia })).data.state;
  const i5 = st.openInstances.find((x) => x.id === inst5);
  ok('实例仍开放', !!i5);
  eq('区段锁保留', i5.lockedSections.length, 3);
  eq('道岔锁保留', i5.lockedSwitches.length, 2);
  eq('信号保持红灯', i5.signalState, 'red');
  const c5row = (await api('/api/cancel-requests', { token: jia })).data.cancellations
    .find((x) => x.id === c5);
  eq('申请终止', c5row.status, 'aborted');
  ok('原因说明区段占用', c5row.endReason.includes('区段 3'), c5row.endReason);
  // 终止后可重新申请（当前保护 1 秒）；沿途恢复空闲（锁闭区段不能走排路前清空接口，
  // 这里模拟外部核实后直接落库为空闲），新申请到期复核通过解除
  withDb((d) => d.prepare(`UPDATE sections SET occ_state='free' WHERE id='3'`).run());
  r = await api(`/api/instances/${inst5}/cancel-request`, { token: jia, method: 'POST' });
  eq('终止后可重新申请（新一笔）', r.data.cancellation.id > c5 && r.status === 200, true);
  await sleep(1500);
  st = (await api('/api/state', { token: jia })).data.state;
  ok('第二次申请到期解除', !st.openInstances.some((x) => x.id === inst5));

  console.log('\n[13] 重启继续处理：未到期继续等待、不提前；到期立即复核解除');
  await api('/api/admin/settings/cancel-protect-seconds',
    { token: admin, method: 'PUT', body: { seconds: 300 } });
  r = await api('/api/routes/R1/open', { token: jia, method: 'POST',
    body: { switchPositions: { SW7: 'N', SW8: 'N' } } });
  const inst6 = r.data.instance.id;
  r = await api(`/api/instances/${inst6}/cancel-request`, { token: jia, method: 'POST' });
  const c6 = r.data.cancellation;
  const dueAt = c6.releaseAtMs;
  await stopServer();
  await startServer(true);
  let st2 = (await api('/api/state', { token: (await login('dispatcher', '值班员甲')) })).data.state;
  ok('重启后未到期申请仍 pending、实例仍开放',
    st2.cancellationRequests.some((x) => x.id === c6.id && x.status === 'pending') &&
    st2.openInstances.some((x) => x.id === inst6));
  const c6rest = st2.cancellationRequests.find((x) => x.id === c6.id);
  eq('最早解除时间不变（继续计时）', c6rest.releaseAtMs, dueAt);
  ok('剩余时间仍约 5 分钟', c6rest.remainingMs > 290000, c6rest.remainingMs);
  await stopServer();
  // 外部把到期时刻改为过去，模拟停机期间已到期
  withDb((d) => d.prepare(`UPDATE cancellation_requests SET release_at_ms=? WHERE id=?`)
    .run(Date.now() - 1000, c6.id));
  await startServer(true);
  const jia2 = await login('dispatcher', '值班员甲');
  await sleep(500); // 启动同步处理已到期申请，稍候确认落库
  st2 = (await api('/api/state', { token: jia2 })).data.state;
  const c6due = st2.cancellationRequests.find((x) => x.id === c6.id);
  eq('重启后已到期立即复核解除（申请 released）', c6due.status, 'released');
  ok('实例已解除', !st2.openInstances.some((x) => x.id === inst6));

  console.log('\n[14] 重启时已到期但条件不符：终止并保留锁闭');
  r = await api('/api/routes/R1/open', { token: jia2, method: 'POST',
    body: { switchPositions: { SW7: 'N', SW8: 'N' } } });
  const inst7 = r.data.instance.id;
  r = await api(`/api/instances/${inst7}/cancel-request`, { token: jia2, method: 'POST' });
  const c7 = r.data.cancellation.id;
  await stopServer();
  withDb((d) => {
    d.prepare(`UPDATE cancellation_requests SET release_at_ms=? WHERE id=?`)
      .run(Date.now() - 1000, c7);
    d.prepare(`UPDATE sections SET occ_state='occupied' WHERE id='5'`).run();
  });
  await startServer(true);
  const jia3 = await login('dispatcher', '值班员甲');
  await sleep(500);
  const st3 = (await api('/api/state', { token: jia3 })).data.state;
  const c7row = st3.cancellationRequests.find((x) => x.id === c7);
  eq('到期条件不符 → 申请终止', c7row.status, 'aborted');
  ok('实例仍开放、锁闭保留',
    st3.openInstances.some((x) => x.id === inst7 && x.lockedSections.length === 3 &&
      x.lockedSwitches.length === 2 && x.signalState === 'red'));

  console.log('\n[15] 管理员重置推演：一并清除等待中的取消申请与实例');
  r = await api('/api/admin/reset/state', { token: admin, method: 'POST' });
  eq('重置成功', r.status, 200);
  eq('重置后无开放实例', r.data.state.openInstances.length, 0);
  eq('重置后无等待中的取消申请',
    r.data.state.cancellationRequests.filter((c) => c.status === 'pending').length, 0);
  eq('重置后无等待申请', r.data.state.waitingApplications.filter((w) => w.status === 'waiting').length, 0);
  // 重置后再申请、再重置：定时器已清理，不应再有到期动作
  await api('/api/switches/SW7/move', { token: jia3, method: 'POST', body: { position: 'N' } }).catch(() => {});

  console.log(`\n延时取消全部 ${passed} 项断言通过 ✅`);
  await stopServer();
}

main().catch(async (e) => {
  console.error('\n❌ 测试失败:', e);
  await stopServer();
  process.exit(1);
});
