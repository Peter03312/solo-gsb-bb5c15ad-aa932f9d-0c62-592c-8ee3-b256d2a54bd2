'use strict';

/**
 * 进路延时取消（保护期取消）。
 *
 * 语义（与需求一一对应）：
 *  - 值班员可对"已开放且尚无走行占用记录"的进路实例申请延时取消；
 *    申请立即令入口信号回红，原区段与道岔锁继续保留，等待中的申请不得提前兑现。
 *  - 返回申请状态与最早解除时间；保护时长由管理员设置（正整数秒），
 *    申请时把当时的设置快照到本申请（protect_seconds），之后修改设置不追改已有申请。
 *  - 重复申请：同一实例已有等待中的申请时直接返回原申请，不缩短期限、不产生第二笔。
 *  - 到期后在同一事务内重查：实例仍开放、无走行占用记录、沿途区段均空闲，
 *    才解除进路（删锁/released/信号红）并触发等待兑现；任一条件不符则终止申请
 *    （aborted），保留锁闭并写明原因。
 *  - 保护期内收到该实例的首段占用事件：按现有走行规则受理，并在同一事务内终止
 *    取消申请（见 abortPendingInTxn）。
 *  - 服务重启后继续处理未到期（继续等待）和已到期（立即复核）申请；
 *    管理员重置推演时一并清除。
 *
 * 实现：
 *  - 到期调度用内存 setTimeout（release_at_ms 为 UTC epoch 毫秒，权威时间在库里），
 *    重启时从 SQLite 恢复并重新调度，已到期者立即处理。
 *  - 与 interlocking.js 存在双向调用，双方均在函数内懒加载对方以规避循环依赖。
 */

const { getDb } = require('./db');

const META_PROTECT_KEY = 'cancel_protect_seconds';
const DEFAULT_PROTECT_SECONDS = 120;

const inter = () => require('./interlocking');
const InterlockError = () => inter().InterlockError;

/* ------------------------------ 内存定时器 ------------------------------ */

// instanceId -> NodeJS.Timeout（仅保留等待中的申请）
const timers = new Map();

function clearTimer(instanceId) {
  const t = timers.get(instanceId);
  if (t) {
    clearTimeout(t);
    timers.delete(instanceId);
  }
}

function schedule(row) {
  clearTimer(row.instance_id);
  const delay = Math.max(0, row.release_at_ms - Date.now());
  const t = setTimeout(() => {
    timers.delete(row.instance_id);
    processMature(row.id, 'mature');
  }, Math.min(delay, 0x7fffffff));
  // 不阻止进程退出
  if (typeof t.unref === 'function') t.unref();
  timers.set(row.instance_id, t);
}

/* ------------------------------ 管理员设置 ------------------------------ */

function getProtectSeconds() {
  const row = getDb().prepare(`SELECT value FROM meta WHERE key=?`).get(META_PROTECT_KEY);
  const n = row ? Number(row.value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PROTECT_SECONDS;
}

/**
 * 管理员设置保护时长（正整数秒）。只影响之后的新申请，不追改已有申请。
 */
function setProtectSeconds(seconds) {
  const n = Number(seconds);
  if (!Number.isInteger(n) || n < 1) {
    throwErr(400, 'BAD_PROTECT_SECONDS', '保护时长必须是正整数秒（>= 1）');
  }
  getDb()
    .prepare(`INSERT INTO meta(key,value) VALUES(?,?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
    .run(META_PROTECT_KEY, String(n));
  return { protectSeconds: n };
}

/* ------------------------------ 申请取消 ------------------------------ */

/**
 * 对已开放且尚无走行占用记录的进路实例申请延时取消。
 * 申请成功：入口信号立即回红，区段/道岔锁保留；调度到期复核。
 * 已有等待中申请：原样返回（幂等，不缩短期限、不产生第二笔）。
 */
function requestCancellation(instanceId, clientName) {
  const db = getDb();
  const txn = db.transaction(() => {
    const inst = db.prepare(
      `SELECT * FROM route_instances WHERE id=? AND status='open'`
    ).get(instanceId);
    if (!inst) throwErr(404, 'INSTANCE_NOT_FOUND', `进路实例 ${instanceId} 不存在或已解除`);

    const existing = db.prepare(
      `SELECT * FROM cancellation_requests WHERE instance_id=? AND status='pending'`
    ).get(instanceId);
    if (existing) return { row: existing, duplicate: true };

    // 已有走行占用记录 → 不允许申请延时取消（走行规则继续按原接口受理）
    const occ = db.prepare(
      `SELECT 1 FROM section_events WHERE instance_id=? AND action='occupy' LIMIT 1`
    ).get(instanceId);
    if (occ) {
      throwErr(409, 'ROUTE_ALREADY_OCCUPIED',
        `不能延时取消：进路 #${instanceId} 已存在走行占用记录，列车已开始进入进路，` +
        '请按走行事件继续办理，末段清空后进路自动解除');
    }

    const protectSeconds = getProtectSeconds();
    const now = Date.now();
    const releaseAtMs = now + protectSeconds * 1000;
    const info = db.prepare(
      `INSERT INTO cancellation_requests
         (instance_id,route_id,applicant,status,protect_seconds,release_at_ms)
       VALUES(?,?,?, 'pending', ?, ?)`
    ).run(instanceId, inst.route_id, clientName, protectSeconds, releaseAtMs);
    // 申请立即令入口信号回红（区段/道岔锁原样保留）
    db.prepare(`UPDATE route_instances SET signal_state='red' WHERE id=?`).run(instanceId);

    return {
      row: db.prepare(`SELECT * FROM cancellation_requests WHERE id=?`).get(info.lastInsertRowid),
      duplicate: false
    };
  });

  const { row, duplicate } = txn();
  schedule(row);
  return { cancellation: rowToRequest(row), duplicate };
}

/* ------------------------------ 保护期内终止 ------------------------------ */

/**
 * 保护期内收到该实例的首段占用事件时，在"走行事件同一事务内"终止取消申请。
 * 只终结等待中的申请；走行规则（占用受理、信号回红等）仍由 interlocking 执行，
 * 本函数只做申请状态置位，不改动任何锁。
 * 可安全重入：无等待中申请时返回 null。
 * @returns {number|null} 被终止的申请编号（供提交方在事务外清理内存定时器）
 */
function abortPendingInTxn(instanceId, reasonText) {
  const db = getDb();
  const pending = db.prepare(
    `SELECT id FROM cancellation_requests WHERE instance_id=? AND status='pending'`
  ).get(instanceId);
  if (!pending) return null;
  db.prepare(
    `UPDATE cancellation_requests SET status='aborted', end_reason=?, ended_at=datetime('now')
      WHERE id=?`
  ).run(reasonText ||
    '保护期内收到该实例的首段走行占用事件，按走行规则受理，取消申请终止（锁闭保留）',
  pending.id);
  return pending.id;
}

/* ------------------------------ 到期复核 ------------------------------ */

/**
 * 到期处理（由定时器/重启恢复触发）。在同一事务内重查全部条件：
 *  - 申请仍为 pending（防止重复定时器/重启竞态提前或重复兑现）；
 *  - 实例仍开放；
 *  - 无任何走行占用记录；
 *  - 沿途区段均空闲。
 * 全部满足 → 解除进路（实例 released、删除全部锁、信号红），申请 released；
 * 否则申请 aborted，锁闭保留，写明原因。解除成功后在事务外触发等待兑现。
 */
function processMature(requestId, trigger) {
  const db = getDb();
  let released = false;
  let abortReason = null;
  void trigger; // 触发来源（mature/retry/server_start_due），日志保留位

  const txn = db.transaction(() => {
    const req = db.prepare(`SELECT * FROM cancellation_requests WHERE id=?`).get(requestId);
    if (!req || req.status !== 'pending') return; // 已处理（走行终止/重置/重复）

    clearTimer(req.instance_id);

    const inst = db.prepare(
      `SELECT * FROM route_instances WHERE id=? AND status='open'`
    ).get(req.instance_id);
    if (!inst) {
      db.prepare(
        `UPDATE cancellation_requests SET status='aborted', end_reason=?, ended_at=datetime('now')
          WHERE id=?`
      ).run(`到期复核：进路实例 #${req.instance_id} 已不再开放，取消申请终止`, req.id);
      abortReason = 'instance_gone';
      return;
    }

    const occ = db.prepare(
      `SELECT 1 FROM section_events WHERE instance_id=? AND action='occupy' LIMIT 1`
    ).get(req.instance_id);
    if (occ) {
      db.prepare(
        `UPDATE cancellation_requests SET status='aborted', end_reason=?, ended_at=datetime('now')
          WHERE id=?`
      ).run('到期复核：该进路已存在走行占用记录（保护期内列车已开始进入），按走行规则办理，取消申请终止，锁闭保留', req.id);
      abortReason = 'occupied_event';
      return;
    }

    // 沿途区段均空闲（含被外部置为占用/未知的情形——按走行规则须保留锁闭）
    const steps = db.prepare(
      `SELECT step_order, section_id FROM route_steps WHERE route_id=? ORDER BY step_order`
    ).all(inst.route_id);
    const busy = [];
    for (const s of steps) {
      const sec = db.prepare(`SELECT occ_state FROM sections WHERE id=?`).get(s.section_id);
      if (!sec || sec.occ_state !== 'free') {
        busy.push({ sectionId: s.section_id, state: sec ? sec.occ_state : 'missing' });
      }
    }
    if (busy.length) {
      const detail = busy.map((b) =>
        `区段 ${b.sectionId}${b.state === 'missing' ? ' 不存在' :
          b.state === 'occupied' ? ' 已被占用' : ' 占用状态未知（按占用处理）'}`).join('；');
      db.prepare(
        `UPDATE cancellation_requests SET status='aborted', end_reason=?, ended_at=datetime('now')
          WHERE id=?`
      ).run(`到期复核：沿途区段并非均空闲（${detail}），取消申请终止，原区段与道岔锁闭保留`, req.id);
      abortReason = 'sections_busy';
      return;
    }

    // 条件全部满足：解除进路（删除全部锁；信号保持红灯），申请兑现
    db.prepare(
      `UPDATE route_instances SET status='released', signal_state='red',
              released_at=datetime('now') WHERE id=?`
    ).run(req.instance_id);
    db.prepare(`DELETE FROM route_locks WHERE instance_id=?`).run(req.instance_id);
    db.prepare(
      `UPDATE cancellation_requests SET status='released',
              end_reason='保护期到期且复核通过（实例仍开放、无走行占用、沿途区段均空闲），进路已解除',
              ended_at=datetime('now') WHERE id=?`
    ).run(req.id);
    released = true;
  });

  try {
    txn();
  } catch (e) {
    // 复核事务异常：稍后重试，绝不丢申请
    console.error('[cancel] 到期复核失败，稍后重试:', e);
    const row = db.prepare(`SELECT * FROM cancellation_requests WHERE id=?`).get(requestId);
    if (row && row.status === 'pending') {
      const t = setTimeout(() => {
        timers.delete(row.instance_id);
        processMature(requestId, 'retry');
      }, 1000);
      if (typeof t.unref === 'function') t.unref();
      timers.set(row.instance_id, t);
    }
    return { released: false, error: true };
  }

  if (released) {
    console.log(`[cancel] 延时取消申请 #${requestId} 保护期到期，进路已解除`);
    // 进路解除、资源释放 → 自动尝试兑现等待申请（不得在取消申请等待期提前触发）
    try {
      inter().triggerWaitingSweep('cancelled_route_released');
    } catch (e) {
      console.error('[cancel] 解除后等待兑现扫描失败:', e);
    }
  } else if (abortReason) {
    console.log(`[cancel] 申请 #${requestId} 到期条件不符（${abortReason}），申请终止，锁闭保留`);
  }
  return { released, aborted: !!abortReason };
}

/* ------------------------------ 重置 / 重启 ------------------------------ */

/**
 * 管理员重置推演：清除全部等待中的取消申请并清理定时器。
 * 重置事务内会删除全部进路实例，申请一并物理清除（"一并清除"语义）。
 */
function clearAllByReset() {
  const db = getDb();
  const pending = db.prepare(
    `SELECT instance_id FROM cancellation_requests WHERE status='pending'`
  ).all();
  for (const p of pending) clearTimer(p.instance_id);
  db.prepare(`DELETE FROM cancellation_requests WHERE status='pending'`).run();
}

/**
 * 服务重启后继续处理：未到期的重新挂定时器，已到期的立即复核。
 * 应在服务启动（建表/等待兑现扫描）后调用一次。
 */
function resumeAfterRestart() {
  const db = getDb();
  const pending = db.prepare(
    `SELECT * FROM cancellation_requests WHERE status='pending' ORDER BY release_at_ms`
  ).all();
  let due = 0;
  for (const row of pending) {
    if (row.release_at_ms <= Date.now()) {
      due++;
      processMature(row.id, 'server_start_due');
    } else {
      schedule(row);
    }
  }
  return { pending: pending.length, due };
}

/* ------------------------------ 查询 / 快照 ------------------------------ */

function rowToRequest(row) {
  const now = Date.now();
  return {
    id: row.id,
    instanceId: row.instance_id,
    routeId: row.route_id,
    applicant: row.applicant,
    status: row.status,                 // pending/released/aborted/cancelled
    protectSeconds: row.protect_seconds,
    // 最早解除时间（绝对）与剩余毫秒（等待中为 >= 0，已结束为 0）
    releaseAt: new Date(row.release_at_ms).toISOString(),
    releaseAtMs: row.release_at_ms,
    remainingMs: row.status === 'pending' ? Math.max(0, row.release_at_ms - now) : 0,
    endReason: row.end_reason,
    createdAt: row.created_at,
    endedAt: row.ended_at
  };
}

function getRequest(id) {
  const row = getDb().prepare(`SELECT * FROM cancellation_requests WHERE id=?`).get(id);
  return row ? rowToRequest(row) : null;
}

function getPendingForInstance(instanceId) {
  const row = getDb().prepare(
    `SELECT * FROM cancellation_requests WHERE instance_id=? AND status='pending'`
  ).get(instanceId);
  return row ? rowToRequest(row) : null;
}

/**
 * 申请列表：等待中的在前（按最早解除时间升序），已结束的在后（按编号倒序）。
 * @param {{applicant?:string, status?:string}} filter
 */
function listRequests(filter = {}) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM cancellation_requests
      ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,
               CASE status WHEN 'pending' THEN release_at_ms ELSE -id END`
  ).all();
  return rows
    .filter((r) => (!filter.applicant || r.applicant === filter.applicant)
      && (!filter.status || r.status === filter.status))
    .map(rowToRequest);
}

/* ------------------------------ 内部工具 ------------------------------ */

function throwErr(status, code, message, extra = {}) {
  const E = InterlockError();
  throw new E(status, code, message, extra);
}

module.exports = {
  DEFAULT_PROTECT_SECONDS,
  getProtectSeconds,
  setProtectSeconds,
  requestCancellation,
  abortPendingInTxn,
  processMature,
  clearAllByReset,
  resumeAfterRestart,
  getRequest,
  getPendingForInstance,
  listRequests,
  clearTimer
};
