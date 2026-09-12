'use strict';
/* ============================================================
 * 共享白板服务端
 * - 静态文件服务（public/ 目录）
 * - REST：POST /api/create 创建房间（名称 / 密码），GET /api/room 加入预检，
 *        /api/admin/* 管理员接口（列表 / 伪装进入 / 删除）
 * - WebSocket /ws：房间内协同（增删改、撤销重做、层次、激光笔、在线用户、房间设置）
 * - 房间数据（元素、操作时间线、用户、图片池）全部缓存在进程内存，进程重启即清空
 * ============================================================ */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const crypto = require('node:crypto');
const WebSocketServer = require('ws').Server;

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 1024 * 1024;           // REST 请求体上限 1MB
const MAX_MSG = 4 * 1024 * 1024;        // WS 单条消息上限 4MB
const UNDO_DEPTH = 100;                 // 每个房间撤销深度
const MAX_ELEMENTS = 5000;              // 每房间元素上限
const ROOM_TTL_EMPTY_MS = 60 * 60 * 1000;             // 空白板（无元素）无访问 1 小时自动回收
const ROOM_TTL_CONTENT_MS = 7 * 24 * 60 * 60 * 1000;  // 有内容白板无访问或修改 7 天自动回收

/* ---------------- 管理员账号（启动参数配置） ----------------
 * 支持环境变量 ADMIN_USER / ADMIN_PASS，或命令行参数
 *   node server.js --admin-user=admin --admin-pass=secret
 * 两者都配置后才启用 /admin 管理页面与 /api/admin/* 接口。 */
function getArg(name) {
  const prefix = '--' + name + '=';
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].indexOf(prefix) === 0) return process.argv[i].slice(prefix.length);
  }
  return '';
}
const ADMIN_USER = process.env.ADMIN_USER || getArg('admin-user') || '';
const ADMIN_PASS = process.env.ADMIN_PASS || getArg('admin-pass') || '';
const ADMIN_ENABLED = !!(ADMIN_USER && ADMIN_PASS);

/* HTTP Basic 认证校验（常量时间比较，防时序攻击） */
function basicAuthOk(req) {
  if (!ADMIN_ENABLED) return false;
  const h = req.headers.authorization || '';
  if (h.indexOf('Basic ') !== 0) return false;
  let dec;
  try { dec = Buffer.from(h.slice(6), 'base64').toString('utf8'); } catch (e) { return false; }
  const i = dec.indexOf(':');
  if (i < 0) return false;
  return constEq(dec.slice(0, i), ADMIN_USER) && constEq(dec.slice(i + 1), ADMIN_PASS);
}
function constEq(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
function needAuth(res) {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="SharedWhiteboard Admin"', 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('需要管理员认证');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

const rooms = Object.create(null); // roomId -> room

/* ---------------- 小工具 ---------------- */
function randId(len, chars) {
  let s = '';
  for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
function roomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去除易混淆字符
  let id;
  do { id = randId(5, chars); } while (rooms[id]);
  return id;
}
function now() { return Date.now(); }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

const USER_COLORS = ['#E53935', '#FB8C00', '#FDD835', '#43A047', '#00897B', '#1E88E5', '#8E24AA', '#F06292', '#6D4C41', '#616161'];

function createRoom(name, pwd, rid) {
  const id = rid || roomId();
  const room = {
    id,
    name: String(name || '').slice(0, 40) || ('白板 ' + id),
    pwd: String(pwd || '').slice(0, 40),
    ownerKey: randId(14, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),
    elements: [],
    images: [],            // 图片数据池 {id, src}：元素仅存 imageId 引用，复制不重复存储
    history: [],           // 操作时间线（PS 式单条时间线：操作记录，非全量快照）
    historyIndex: -1,      // 时间线指针：指向最后一条已应用操作（-1 = 初始空白状态）
    noLaserRO: false,      // 房间设置：只读用户禁用激光笔
    forceRO: false,        // 房间设置：可编辑用户禁止编辑（降级为只读）
    livePending: Object.create(null), // id -> true：live 创建尚未 commit 的元素（时间线 add 语义区分）
    clients: Object.create(null),
    createdAt: now(),
    lastActive: now(),
    lastModified: now(),
    deleted: false
  };
  rooms[id] = room;
  return room;
}

function shareUrl(req, room) {
  const host = req.headers.host || (`localhost:${PORT}`);
  // 协议动态判定：支持 https 反代（x-forwarded-proto）与直连 TLS
  const proto = (req.connection?.encrypted) || (req.headers['x-forwarded-proto'] || '').indexOf('https') === 0 ? 'https' : 'http';
  let q = `room=${encodeURIComponent(room.id)}`;
  if (room.pwd) q += `&pwd=${encodeURIComponent(room.pwd)}`;
  return `${proto}://${host}/board.html?${q}`;
}

/* 管理员：房间列表（含 ownerKey，用于伪装成房主进入） */
function adminRoomList() {
  const arr = [];
  Object.keys(rooms).forEach((id) => {
    const r = rooms[id];
    if (!r || r.deleted) return;
    arr.push({
      id: r.id,
      name: r.name,
      hasPwd: !!r.pwd,
      elementCount: r.elements.length,
      userCount: Object.keys(r.clients).length,
      createdAt: r.createdAt,
      lastActive: r.lastActive,
      lastModified: r.lastModified || r.lastActive,
      ownerKey: r.ownerKey
    });
  });
  arr.sort((a, b) => b.createdAt - a.createdAt);
  return arr;
}

function adminDisabled(res) {
  res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify({ ok: false, error: '管理员账号未配置：请通过启动参数 --admin-user / --admin-pass 或环境变量 ADMIN_USER / ADMIN_PASS 设置后重启' }));
}

function listUsers(room) {
  const arr = [];
  Object.keys(room.clients).forEach((uid) => {
    const c = room.clients[uid];
    arr.push({ uid, name: c.name, color: c.color, readonly: c.readonly, owner: c.owner });
  });
  return arr;
}

/* ---------------- 操作时间线（PS 式：一条时间线，服务端/客户端同一模型） ----------------
 * 每条历史记录是一个操作：{t:'add',el,i} 添加 / {t:'upd',id,before,after} 更新 /
 * {t:'del',el,i} 删除 / {t:'clear',els} 清空 / {t:'ord',id,from,to} 重排。
 * 撤销 = 逆应用指针处操作并回退；重做 = 前进并正应用；新操作截断未来。 */
function pushHistoryOp(room, op) {
  if (room.historyIndex < room.history.length - 1) room.history.length = room.historyIndex + 1; // 新操作截断未来
  room.history.push(op);
  room.historyIndex++;
  if (room.history.length > UNDO_DEPTH) {
    room.history.shift();
    room.historyIndex--;
  }
}

function applyHistoryOp(room, op, inverse) {
  if (op.t === 'add') {
    if (inverse) {
      const idx = findIndexById(room, op.el.id);
      if (idx >= 0) room.elements.splice(idx, 1);
    } else if (findIndexById(room, op.el.id) < 0) {
      const at = Math.max(0, Math.min(op.i, room.elements.length));
      room.elements.splice(at, 0, op.el);
    }
  } else if (op.t === 'del') {
    if (inverse) {
      if (findIndexById(room, op.el.id) < 0) {
        const at = Math.max(0, Math.min(op.i, room.elements.length));
        room.elements.splice(at, 0, op.el);
      }
    } else {
      const idx = findIndexById(room, op.el.id);
      if (idx >= 0) room.elements.splice(idx, 1);
    }
  } else if (op.t === 'upd') {
    const idx = findIndexById(room, op.id);
    if (idx >= 0) {
      const snap = inverse ? op.before : op.after;
      Object.keys(snap).forEach((k) => { room.elements[idx][k] = snap[k]; });
    }
  } else if (op.t === 'clear') {
    if (inverse) room.elements = structuredClone(op.els);
    else room.elements = [];
  } else if (op.t === 'ord') {
    const idx = findIndexById(room, op.id);
    if (idx < 0) return;
    const el = room.elements.splice(idx, 1)[0];
    let to = inverse ? op.from : op.to;
    to = Math.max(0, Math.min(to, room.elements.length));
    room.elements.splice(to, 0, el);
  }
}

/* 撤销/重做可用状态轻量广播（供客户端按钮 disabled 状态刷新） */
function broadcastHistory(room) {
  broadcast(room, { type: 'history', undoable: room.historyIndex >= 0, redoable: room.historyIndex < room.history.length - 1 });
}

function findIndexById(room, id) {
  for (let i = 0; i < room.elements.length; i++) {
    if (room.elements[i].id === id) return i;
  }
  return -1;
}

function broadcast(room, msg, exceptUid) {
  const data = JSON.stringify(msg);
  Object.keys(room.clients).forEach((uid) => {
    if (uid === exceptUid) return;
    const c = room.clients[uid];
    if (c.ws?.readyState === 1) {
      try { c.ws.send(data); } catch (e) {}
    }
  });
}

function broadcastState(room, exceptUid) {
  const msg = {
    type: 'state',
    elements: room.elements,
    images: room.images,
    history: room.history,          // 操作时间线（PS 式：操作记录数组，非全量快照）
    historyIndex: room.historyIndex,
    undoable: room.historyIndex >= 0,
    redoable: room.historyIndex < room.history.length - 1
  };
  // 撤销/重做后的校正广播：操作人本地已立即执行（无需校正），只发给其他成员；
  // 导入等其它 state 场景传 undefined，通知所有客户端（含发起者）
  broadcast(room, msg, exceptUid);
}

/* ---------------- 元素校验 ---------------- */
const ELEMENT_TYPES = { pen: 1, line: 1, arrow: 1, rect: 1, circle: 1, text: 1, image: 1 };
const PATCH_KEYS = {
  x: 1, y: 1, w: 1, h: 1, x1: 1, y1: 1, x2: 1, y2: 1,
  rotation: 1, points: 1, text: 1,
  stroke: 1, fill: 1, opacity: 1, strokeWidth: 1, fontSize: 1
};

function validElement(el) {
  if (!el || typeof el !== 'object') return false;
  if (typeof el.id !== 'string' || !el.id || el.id.length > 40) return false;
  if (!ELEMENT_TYPES[el.type]) return false;
  if (el.type === 'pen') {
    if (!Array.isArray(el.points) || el.points.length < 1 || el.points.length > 5000) return false;
    for (const element of el.points) {
      const p = element
      if (!Array.isArray(p) || p.length < 2 || !isNum(p[0]) || !isNum(p[1])) return false;
    }
  } else if (el.type === 'text') {
    if (typeof el.text !== 'string' || el.text.length > 5000) return false;
  } else if (el.type === 'image') {
    // 图片元素只存 imageId 引用；兼容旧格式（带 src 无 imageId），由 attachImage 归一化
    const hasImgId = typeof el.imageId === 'string' && el.imageId && el.imageId.length <= 40;
    const hasSrc = typeof el.src === 'string' && el.src.length > 0 && el.src.length <= 2500000;
    if (!hasImgId && !hasSrc) return false;
  }
  if (el.opacity !== undefined && (!isNum(el.opacity) || el.opacity < 0 || el.opacity > 1)) return false;
  if (el.strokeWidth !== undefined && (!isNum(el.strokeWidth) || el.strokeWidth < 0.5 || el.strokeWidth > 200)) return false;
  if (el.fontSize !== undefined && (!isNum(el.fontSize) || el.fontSize < 4 || el.fontSize > 500)) return false;
  return !(el.rotation !== undefined && !isNum(el.rotation));

}

/* 图片元素归一化：把 src 存入房间图片池（按 imageId 去重），元素只保留 imageId 引用；
 * 复制图片时 imageId 已存在，直接复用，不再重复存储图片数据。 */
function attachImage(room, el) {
  if (el.type !== 'image') return el;
  let imgId = el.imageId;
  if (imgId) {
    for (const element of room.images) {
      if (element.id === imgId) {
        const out = {...el};
        delete out.src;
        return out; // 图片池已有该图：去重
      }
    }
  } else {
    imgId = el.id;
  }
  if (typeof el.src !== 'string' || !el.src) return null; // 新图片必须携带数据
  room.images.push({ id: imgId, src: el.src });
  broadcast(room, { type: 'image_added', image: { id: imgId, src: el.src } });
  const out = {...el};
  out.imageId = imgId;
  delete out.src;
  return out;
}

function sanitizePatch(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  Object.keys(patch).forEach((k) => {
    if (!PATCH_KEYS[k]) return;
    const v = patch[k];
    if (k === 'points') {
      if (!Array.isArray(v) || v.length > 5000) return;
      for (const element of v) {
        const p = element
        if (!Array.isArray(p) || p.length < 2 || !isNum(p[0]) || !isNum(p[1])) return;
      }
      out[k] = v;
    } else if (k === 'text') {
      if (typeof v === 'string' && v.length <= 5000) out[k] = v;
    } else if (k === 'stroke' || k === 'fill') {
      if (typeof v === 'string' && v.length <= 40) out[k] = v;
    } else if (k === 'opacity') {
      if (isNum(v) && v >= 0 && v <= 1) out[k] = v;
    } else if (k === 'rotation') {
      if (isNum(v)) out[k] = v;
    } else if (k === 'strokeWidth') {
      if (isNum(v) && v > 0 && v <= 200) out[k] = v;
    } else if (k === 'fontSize') {
      if (isNum(v) && v > 0 && v <= 500) out[k] = v;
    } else if (isNum(v)) out[k] = v
  });
  return out;
}

/* ---------------- 层次调整 ---------------- */
/* 注：层次调整已内联到消息处理（reorder 分支），以便记录 {t:'ord'} 时间线操作的 from/to */

/* 删除整个白板：清空内存房间数据、断开所有成员（创建者按钮与管理端共用） */
function deleteRoom(room) {
  room.deleted = true;
  broadcast(room, { type: 'room_deleted' }); // 通知所有成员（含发起者）
  delete rooms[room.id];
  Object.keys(room.clients).forEach((uid) => {
    const c = room.clients[uid];
    if (c.ws?.readyState === 1) {
      try { c.ws.close(); } catch (e) {}
    }
  });
}

/* ---------------- WS 消息处理 ---------------- */
function handleMessage(room, client, msg) {
  if (!msg || typeof msg.type !== 'string') return;
  room.lastActive = now();

  if (msg.type === 'ping') { sendRaw(client, { type: 'pong' }); return; }

  // 激光笔：轨迹广播给其他成员；发起者本地自行渲染（不回传自身，避免重复绘制）。
  // 房间设置「只读用户禁用激光笔」（client.noLaser）时，激光消息一律忽略
  if (msg.type === 'laser') {
    if (client.noLaser) return;
    const x = isNum(msg.x) ? msg.x : 0;
    const y = isNum(msg.y) ? msg.y : 0;
    broadcast(room, { type: 'laser', uid: client.uid, x, y, active: !!msg.active }, client.uid);
    return;
  }

  // 选中状态广播：让其他成员看到谁在编辑哪些图案（只读成员也可选看；支持多选 ids）
  if (msg.type === 'sel') {
    const selIds = [];
    if (Array.isArray(msg.ids)) {
      for (let si = 0; si < msg.ids.length && si < 200; si++) {
        if (typeof msg.ids[si] === 'string' && msg.ids[si].length <= 40 && !selIds.includes(msg.ids[si])) selIds.push(msg.ids[si]);
      }
    } else if (typeof msg.id === 'string' && msg.id.length <= 40) {
      selIds.push(msg.id);
    }
    broadcast(room, { type: 'selection', uid: client.uid, ids: selIds }, client.uid);
    return;
  }

  // 创建者重命名白板
  if (msg.type === 'rename') {
    if (!client.owner) return;
    const nm = String(msg.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!nm) return;
    room.name = nm;
    broadcast(room, { type: 'room_renamed', name: nm }); // 含发起者
    return;
  }

  // 房主修改访问密码（留空表示取消密码）
  if (msg.type === 'pwd_change') {
    if (!client.owner) return;
    const np = String(msg.pwd || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (np === room.pwd) return;
    room.pwd = np;
    room.lastModified = now();
    broadcast(room, { type: 'room_password_changed', pwd: np }); // 含发起者
    // 设置 / 更换密码：旧密码失效，强制断开所有非房主成员，提示重新输入密码加入；
    // 清空密码（取消密码）后无需密码即可加入，不踢人
    if (np) {
      Object.keys(room.clients).forEach((uid) => {
        const c = room.clients[uid];
        if (!c || c.owner) return;
        if (c.ws?.readyState === 1) {
          try { c.ws.send(JSON.stringify({ type: 'pwd_kicked', reason: '访问密码已更改，请重新输入密码加入' })); } catch (e) {}
          setTimeout(() => { try { c.ws.close(); } catch (e) {} }, 200);
        }
      });
    }
    return;
  }

  // 房间设置（房主）：只读用户禁用激光笔 / 可编辑用户禁止编辑——对在线成员即时生效
  if (msg.type === 'room_settings') {
    if (!client.owner) return;
    const noLaserRO = !!msg.noLaserRO;
    const forceRO = !!msg.forceRO;
    let changed = false;
    if (noLaserRO !== room.noLaserRO) {
      room.noLaserRO = noLaserRO;
      changed = true;
      // 同步更新所有在线只读成员的激光权限，并广播通知（含发起者）
      Object.keys(room.clients).forEach((uid) => {
        const c = room.clients[uid];
        if (c && !c.owner) c.noLaser = c.readonly && noLaserRO;
      });
      broadcast(room, { type: 'room_laser_policy', noLaserRO });
    }
    if (forceRO !== room.forceRO) {
      room.forceRO = forceRO;
      changed = true;
      // 开启：在线可编辑访客降级为只读（清理进行中的 live 创建）；关闭：按基础权限恢复；
      // 均同步重算激光权限并广播通知（含发起者）
      Object.keys(room.clients).forEach((uid) => {
        const c = room.clients[uid];
        if (!c || c.owner) return;
        c.readonly = c.baseReadonly || forceRO;
        c.noLaser = c.readonly && room.noLaserRO;
        if (forceRO && c._live) delete c._live;
      });
      broadcast(room, { type: 'room_edit_policy', forceRO });
    }
    if (changed) {
      room.lastModified = now();
    }
    return;
  }

  // 房主导入配置：全量替换白板内容（覆盖当前元素与图片池并清空撤销历史）
  if (msg.type === 'import') {
    if (!client.owner) return;
    if (!Array.isArray(msg.elements) || msg.elements.length > MAX_ELEMENTS) return;
    const clean = [];
    const cleanImages = [];
    const imgBy = Object.create(null);
    if (Array.isArray(msg.images)) {
      for (const element of msg.images) {
        const im = element
        if (im && typeof im.id === 'string' && im.id.length <= 40 && typeof im.src === 'string' && im.src.length <= 2500000) {
          cleanImages.push({ id: im.id, src: im.src });
          imgBy[im.id] = im.src;
        }
      }
    }
    for (const element of msg.elements) {
      const e = element
      if (!validElement(e)) continue;
      if (e.type === 'image') {
        let imgId = e.imageId;
        let src = e.src || imgBy[imgId];
        if (!imgId) imgId = e.id;
        if (!src) continue; // 无图片数据的图片元素无效
        if (!imgBy[imgId]) {
          cleanImages.push({ id: imgId, src });
          imgBy[imgId] = src;
        }
        const el2 = {...e};
        el2.imageId = imgId;
        delete el2.src;
        clean.push(el2);
      } else {
        clean.push(e);
      }
    }
    room.elements = clean;
    room.images = cleanImages;
    room.history = [];
    room.historyIndex = -1;
    room.lastModified = now();
    broadcastState(room);
    return;
  }

  // 创建者删除整个白板：清空服务器内存中的房间数据，断开所有成员
  if (msg.type === 'delete_room') {
    if (!client.owner) return;
    deleteRoom(room);
    return;
  }

  if (msg.type === 'undo' || msg.type === 'redo') {
    if (client.readonly) return;
    applyUndoRedo(room, msg.type === 'undo', client.uid);
    return;
  }

  if (client.readonly) return; // 只读客户端一律拒绝改动类消息

  room.lastModified = now(); // 可编辑成员的改动消息视为内容修改（供回收判定）

  switch (msg.type) {
    case 'add':
      if (validElement(msg.element) && room.elements.length < MAX_ELEMENTS) {
        const element = attachImage(room, msg.element);
        if (!element) return;
        if (msg.live) {
          // 绘制过程中的实时预览：不记录时间线（完成时统一 commit），访问者实时看到创建过程
          room.livePending[element.id] = true;
          room.elements.push(element);
          broadcast(room, { type: 'element_added', element, live: true }, client.uid);
        } else {
          pushHistoryOp(room, { t: 'add', el: element, i: room.elements.length });
          room.elements.push(element);
          broadcast(room, { type: 'element_added', element, live: false, index: room.elements.length - 1 }, client.uid);
          broadcastHistory(room);
        }
      }
      break;

    case 'update': {
      const idx = findIndexById(room, msg.id);
      if (idx < 0) return;
      const patch = sanitizePatch(msg.patch);
      const keys = Object.keys(patch);
      if (!keys.length) return;
      const br = { type: 'element_updated', id: msg.id, patch, commit: !!msg.commit };
      let beforeEl = null;
      if (msg.commit) {
        if (room.livePending[msg.id]) {
          // 绘制完成（live 创建 → 首次 commit）：时间线记录为「该元素从无到有」（add）
          delete room.livePending[msg.id];
          br.liveDone = true;
        } else if (msg.undo && typeof msg.undo === 'object' && msg.undo.id === msg.id && ELEMENT_TYPES[msg.undo.type]) {
          // 拖动/变换期间已有节流更新先行改动元素，
          // 这里用拖动起点的元素快照作为 before，确保撤销能回到拖动前状态
          beforeEl = msg.undo;
          br.undo = msg.undo;
        } else {
          beforeEl = structuredClone(room.elements[idx]); // 应用 patch 前快照（供远端镜像时间线）
          br.before = beforeEl;
        }
      }
      for (const element of keys) {
        const k = element
        if (k === 'points') {
          room.elements[idx].points = patch[k].map((p) => [p[0], p[1]]);
        } else {
          room.elements[idx][k] = patch[k];
        }
      }
      if (msg.commit) {
        const afterEl = structuredClone(room.elements[idx]);
        if (br.liveDone) {
          pushHistoryOp(room, { t: 'add', el: afterEl, i: idx }); // 元素最终形态作为 add 操作
        } else if (beforeEl) {
          pushHistoryOp(room, { t: 'upd', id: msg.id, before: structuredClone(beforeEl), after: afterEl });
        }
        broadcastHistory(room);
      }
      broadcast(room, br, client.uid);
      break;
    }

    case 'delete': {
      const di = findIndexById(room, msg.id);
      if (di >= 0) {
        const removed = room.elements[di];
        pushHistoryOp(room, { t: 'del', el: removed, i: di });
        room.elements.splice(di, 1);
        delete room.livePending[msg.id];
        broadcast(room, { type: 'element_deleted', id: msg.id, element: removed, index: di }, client.uid);
        broadcastHistory(room);
      }
      break;
    }

    case 'clear':
      if (room.elements.length) {
        pushHistoryOp(room, { t: 'clear', els: structuredClone(room.elements) });
        room.elements.length = 0;
        room.livePending = Object.create(null);
        broadcast(room, { type: 'board_cleared' }, client.uid);
        broadcastHistory(room);
      }
      break;

    case 'reorder': {
      const rIdx = findIndexById(room, msg.id);
      if (rIdx < 0) break;
      const rEl = room.elements[rIdx];
      let rTo = rIdx;
      if (msg.action === 'toFront') rTo = room.elements.length - 1;
      else if (msg.action === 'toBack') rTo = 0;
      else if (msg.action === 'forward') rTo = Math.min(room.elements.length - 1, rIdx + 1);
      else if (msg.action === 'backward') rTo = Math.max(0, rIdx - 1);
      else break;
      if (rTo === rIdx) break;
      pushHistoryOp(room, { t: 'ord', id: msg.id, from: rIdx, to: rTo });
      room.elements.splice(rIdx, 1);
      room.elements.splice(rTo, 0, rEl);
      broadcast(room, { type: 'reordered', id: msg.id, action: msg.action }, client.uid);
      broadcastHistory(room);
      break;
    }

    default:
      break;
  }
}

function applyUndoRedo(room, isUndo, exceptUid) {
  if (isUndo) {
    if (room.historyIndex < 0) return;
    applyHistoryOp(room, room.history[room.historyIndex], true);
    room.historyIndex--;
  } else {
    if (room.historyIndex >= room.history.length - 1) return;
    room.historyIndex++;
    applyHistoryOp(room, room.history[room.historyIndex], false);
  }
  room.lastModified = now();
  broadcastState(room, exceptUid); // 操作人本地已执行，无需 state 校正
}

function sendRaw(client, msg) {
  if (client.ws?.readyState === 1) {
    try { client.ws.send(JSON.stringify(msg)); } catch (e) {}
  }
}

function deny(ws, error) {
  try { ws.send(JSON.stringify({ type: 'join_result', ok: false, error })); } catch (e) {}
  setTimeout(() => { try { ws.close(); } catch (e) {} }, 300);
}

/* ---------------- HTTP 服务 ---------------- */
function readBody(req, cb) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
  req.on('error', (e) => cb(e));
}

function serveStatic(req, res) {
  let pathname;
  try { pathname = decodeURIComponent(url.parse(req.url).pathname); }
  catch (e) { res.writeHead(400); res.end(); return; }
  if (pathname === '/') pathname = '/index.html';
  const fp = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (fp.indexOf(PUBLIC_DIR) !== 0) { res.writeHead(403); res.end(); return; }
  fs.readFile(fp, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  if (req.method === 'POST' && u.pathname === '/api/create') {
    readBody(req, (err, body) => {
      if (err) { res.writeHead(400); res.end('{"ok":false,"error":"bad request"}'); return; }
      let data = {};
      try { data = JSON.parse(body || '{}'); } catch (e) {}
      // 可选的自定义房间号：仅允许大写字母 + 数字，1-10 位
      const rid = String(data.roomId || '').trim().toUpperCase();
      if (rid) {
        if (!/^[A-Z0-9]{1,10}$/.test(rid)) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
          res.end(JSON.stringify({ ok: false, error: '房间号只能包含大写字母和数字（1-10 位）' }));
          return;
        }
        if (rooms[rid]) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
          res.end(JSON.stringify({ ok: false, error: '房间号已被占用，请换一个' }));
          return;
        }
      }
      const room = createRoom(String(data.name || ''), String(data.pwd || ''), rid || null);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({
        ok: true,
        id: room.id,
        name: room.name,
        ownerKey: room.ownerKey,
        shareUrl: shareUrl(req, room)
      }));
    });
    return;
  }

  /* ---------------- 房间存在性 / 密码校验（首页加入前预检） ---------------- */
  if (u.pathname === '/api/room' && req.method === 'GET') {
    const rid2 = String(u.query.id || '').trim().toUpperCase();
    const room2 = rooms[rid2];
    // 密码校验规则与 tryJoin 一致：无密码则通过；有密码则需匹配（创建者凭 key 不受限）
    const pwdOk2 = !room2?.pwd || (String(u.query.pwd || '') === room2.pwd);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ ok: true, exists: !!room2, pwdOk: pwdOk2 }));
    return;
  }

  /* ---------------- 管理员（HTTP 基本认证；账号由启动参数配置） ---------------- */
  if (u.pathname === '/admin' || u.pathname === '/admin.html') {
    if (ADMIN_ENABLED && !basicAuthOk(req)) { needAuth(res); return; }
    fs.readFile(path.join(PUBLIC_DIR, 'admin.html'), (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found'); return; }
      res.writeHead(200, { 'Content-Type': MIME['.html'] || 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }
  if (u.pathname === '/api/admin/rooms' && req.method === 'GET') {
    if (!ADMIN_ENABLED) { adminDisabled(res); return; }
    if (!basicAuthOk(req)) { needAuth(res); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ ok: true, admin: ADMIN_ENABLED, rooms: adminRoomList() }));
    return;
  }
  if (u.pathname === '/api/admin/delete_room' && req.method === 'POST') {
    if (!ADMIN_ENABLED) { adminDisabled(res); return; }
    if (!basicAuthOk(req)) { needAuth(res); return; }
    readBody(req, (err, body) => {
      if (err) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end('{"ok":false,"error":"bad request"}'); return; }
      let data = {};
      try { data = JSON.parse(body || '{}'); } catch (e) {}
      const r = rooms[data.id];
      if (!r) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(JSON.stringify({ ok: false, error: '房间不存在' }));
        return;
      }
      deleteRoom(r);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }
  if (u.pathname === '/api/admin/delete_all' && req.method === 'POST') {
    if (!ADMIN_ENABLED) { adminDisabled(res); return; }
    if (!basicAuthOk(req)) { needAuth(res); return; }
    const ids = Object.keys(rooms);
    for (const element of ids) deleteRoom(rooms[element]);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ ok: true, deleted: ids.length }));
    return;
  }
  serveStatic(req, res);
});

/* ---------------- WebSocket 服务 ---------------- */
/* perMessageDeflate 关闭：iOS 9 老 WebKit 的 permessage-deflate 实现存在握手缺陷，
 * 开启会导致连接一直停留在 connecting 状态。
 * 连接方式与 iOS9 正常示例一致：连 /ws（不带任何查询参数），
 * 打开后在首条消息里发送 hello {room,pwd,key,ro,name} 完成加入。 */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MSG, perMessageDeflate: false });

function tryJoin(ws, msg, req) {
  const room = rooms[msg.room];
  if (!room || room.deleted) { deny(ws, '房间不存在，请检查房间号'); return null; }

  const isOwner = msg.key && msg.key === room.ownerKey;
  const pwdOk = !room.pwd || (msg.pwd || '') === room.pwd;
  if (!isOwner && !pwdOk) { deny(ws, '房间密码错误'); return null; }

  // 基础权限由分享链接 ro=1 决定（创建者始终可编辑）；
  // 房间设置「可编辑用户禁止编辑」forceRO 开启时，可编辑访客降级为只读；
  // noLaser 由房间设置「只读用户禁用激光笔」决定（对只读成员即时生效）
  const baseReadonly = isOwner ? false : (msg.ro === '1');
  const readonly = isOwner ? false : (baseReadonly || room.forceRO);
  const noLaser = !isOwner && readonly && !!room.noLaserRO;
  const client = {
    uid: randId(10, 'abcdefghijklmnopqrstuvwxyz0123456789'),
    // 创建者的名字始终显示为“房主”
    name: isOwner ? '房主' : (String(msg.name || '').slice(0, 20) || ('访客' + Math.floor(Math.random() * 900 + 100))),
    // 房主标记颜色始终为红色；访客从非红色色板中随机分配
    color: isOwner ? '#E53935' : USER_COLORS[1 + Math.floor(Math.random() * (USER_COLORS.length - 1))],
    readonly,
    baseReadonly, // 基础权限（不含 forceRO 动态降级），供房间设置切换时恢复/降级
    noLaser,
    owner: isOwner,
    ws
  };
  room.clients[client.uid] = client;
  room.lastActive = now();
  client._room = room;

  sendRaw(client, {
    type: 'welcome',
    self: { uid: client.uid, name: client.name, color: client.color, readonly: client.readonly, baseReadonly: client.baseReadonly, noLaser: client.noLaser, owner: client.owner },
    room: { id: room.id, name: room.name, pwd: room.pwd, noLaserRO: room.noLaserRO, forceRO: room.forceRO, shareUrl: shareUrl(req, room) },
    elements: room.elements,
    images: room.images,
    users: listUsers(room),
    history: room.history,          // 操作时间线（PS 式：操作记录数组，非全量快照）
    historyIndex: room.historyIndex,
    undoable: room.historyIndex >= 0,
    redoable: room.historyIndex < room.history.length - 1
  });
  broadcast(room, { type: 'user_joined', user: { uid: client.uid, name: client.name, color: client.color, readonly: client.readonly } }, client.uid);
  return client;
}

wss.on('connection', (ws, req) => {
  let client = null;
  let joined = false;
  // 若 8 秒内未发送 hello，关闭连接（保护资源）
  const helloTimer = setTimeout(() => {
    if (!joined) { try { ws.close(); } catch (e) {} }
  }, 8000);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch (e) { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (!joined) {
      if (msg.type !== 'hello') return;
      clearTimeout(helloTimer);
      client = tryJoin(ws, msg, req);
      if (!client) return; // deny 已回复并准备关闭
      joined = true;
      return;
    }
    handleMessage(roomOf(client), client, msg);
  });
  ws.on('close', () => {
    if (joined && client && roomOf(client).clients[client.uid]) {
      const r = roomOf(client);
      delete r.clients[client.uid];
      broadcast(r, { type: 'user_left', uid: client.uid });
    }
  });
  ws.on('error', () => {});
});

function roomOf(client) {
  return client?._room;
}

/* 空闲房间自动回收：空白板无访问 1 小时删除；有内容白板无访问或修改 7 天删除（不阻塞进程退出） */
setInterval(() => {
  const t = now();
  Object.keys(rooms).forEach((id) => {
    const r = rooms[id];
    if (!r) return;
    const lastMod = r.lastModified || r.lastActive;
    const idle = t - Math.max(r.lastActive, lastMod);
    const ttl = r.elements.length ? ROOM_TTL_CONTENT_MS : ROOM_TTL_EMPTY_MS;
    if (idle > ttl) delete rooms[id];
  });
}, 10 * 60 * 1000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`共享白板服务已启动: http://localhost:${PORT}`);
});
