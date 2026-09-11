'use strict';
/* ============================================================
 * 共享白板服务端
 * - 静态文件服务（public/ 目录）
 * - REST：POST /api/create 创建房间（名称 / 密码），GET /api/room 加入预检，
 *        /api/admin/* 管理员接口（列表 / 伪装进入 / 删除）
 * - WebSocket /ws：房间内协同（增删改、撤销重做、层次、激光笔、在线用户）
 * - 房间数据（元素、撤销栈、用户）全部缓存在进程内存，进程重启即清空
 * ============================================================ */
var http = require('http');
var fs = require('fs');
var path = require('path');
var url = require('url');
var crypto = require('crypto');
var WebSocketServer = require('ws').Server;

var PORT = Number(process.env.PORT) || 8080;
var PUBLIC_DIR = path.join(__dirname, 'public');
var MAX_BODY = 1024 * 1024;           // REST 请求体上限 1MB
var MAX_MSG = 4 * 1024 * 1024;        // WS 单条消息上限 4MB
var UNDO_DEPTH = 100;                 // 每个房间撤销深度
var MAX_ELEMENTS = 5000;              // 每房间元素上限
var ROOM_TTL_EMPTY_MS = 60 * 60 * 1000;             // 空白板（无元素）无访问 1 小时自动回收
var ROOM_TTL_CONTENT_MS = 7 * 24 * 60 * 60 * 1000;  // 有内容白板无访问或修改 7 天自动回收

/* ---------------- 管理员账号（启动参数配置） ----------------
 * 支持环境变量 ADMIN_USER / ADMIN_PASS，或命令行参数
 *   node server.js --admin-user=admin --admin-pass=secret
 * 两者都配置后才启用 /admin 管理页面与 /api/admin/* 接口。 */
function getArg(name) {
  var prefix = '--' + name + '=';
  for (var i = 2; i < process.argv.length; i++) {
    if (process.argv[i].indexOf(prefix) === 0) return process.argv[i].slice(prefix.length);
  }
  return '';
}
var ADMIN_USER = process.env.ADMIN_USER || getArg('admin-user') || '';
var ADMIN_PASS = process.env.ADMIN_PASS || getArg('admin-pass') || '';
var ADMIN_ENABLED = !!(ADMIN_USER && ADMIN_PASS);

/* HTTP Basic 认证校验（常量时间比较，防时序攻击） */
function basicAuthOk(req) {
  if (!ADMIN_ENABLED) return false;
  var h = req.headers.authorization || '';
  if (h.indexOf('Basic ') !== 0) return false;
  var dec;
  try { dec = Buffer.from(h.slice(6), 'base64').toString('utf8'); } catch (e) { return false; }
  var i = dec.indexOf(':');
  if (i < 0) return false;
  return constEq(dec.slice(0, i), ADMIN_USER) && constEq(dec.slice(i + 1), ADMIN_PASS);
}
function constEq(a, b) {
  var ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
function needAuth(res) {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="SharedWhiteboard Admin"', 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('需要管理员认证');
}

var MIME = {
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

var rooms = Object.create(null); // roomId -> room

/* ---------------- 小工具 ---------------- */
function randId(len, chars) {
  var s = '';
  for (var i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
function roomId() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去除易混淆字符
  var id;
  do { id = randId(5, chars); } while (rooms[id]);
  return id;
}
function now() { return Date.now(); }
function isNum(v) { return typeof v === 'number' && isFinite(v); }

var USER_COLORS = ['#E53935', '#FB8C00', '#FDD835', '#43A047', '#00897B', '#1E88E5', '#8E24AA', '#F06292', '#6D4C41', '#616161'];

function createRoom(name, pwd, rid) {
  var id = rid || roomId();
  var room = {
    id: id,
    name: String(name || '').slice(0, 40) || ('白板 ' + id),
    pwd: String(pwd || '').slice(0, 40),
    ownerKey: randId(14, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),
    elements: [],
    undo: [],
    redo: [],
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
  var host = req.headers.host || ('localhost:' + PORT);
  var q = 'room=' + encodeURIComponent(room.id);
  if (room.pwd) q += '&pwd=' + encodeURIComponent(room.pwd);
  return 'http://' + host + '/board.html?' + q;
}

/* 管理员：房间列表（含 ownerKey，用于伪装成房主进入） */
function adminRoomList() {
  var arr = [];
  Object.keys(rooms).forEach(function (id) {
    var r = rooms[id];
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
  arr.sort(function (a, b) { return b.createdAt - a.createdAt; });
  return arr;
}

function adminDisabled(res) {
  res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify({ ok: false, error: '管理员账号未配置：请通过启动参数 --admin-user / --admin-pass 或环境变量 ADMIN_USER / ADMIN_PASS 设置后重启' }));
}

function listUsers(room) {
  var arr = [];
  Object.keys(room.clients).forEach(function (uid) {
    var c = room.clients[uid];
    arr.push({ uid: uid, name: c.name, color: c.color, readonly: c.readonly, owner: c.owner });
  });
  return arr;
}

function pushHistory(room) {
  room.undo.push(JSON.stringify(room.elements));
  if (room.undo.length > UNDO_DEPTH) room.undo.shift();
  room.redo.length = 0;
}

function findIndexById(room, id) {
  for (var i = 0; i < room.elements.length; i++) {
    if (room.elements[i].id === id) return i;
  }
  return -1;
}

function broadcast(room, msg, exceptUid) {
  var data = JSON.stringify(msg);
  Object.keys(room.clients).forEach(function (uid) {
    if (uid === exceptUid) return;
    var c = room.clients[uid];
    if (c.ws && c.ws.readyState === 1) {
      try { c.ws.send(data); } catch (e) {}
    }
  });
}

function broadcastState(room) {
  var msg = {
    type: 'state',
    elements: room.elements,
    undoable: room.undo.length > 0,
    redoable: room.redo.length > 0
  };
  broadcast(room, msg); // 撤销/重做需要通知所有客户端（含发起者）
}

/* ---------------- 元素校验 ---------------- */
var ELEMENT_TYPES = { pen: 1, line: 1, arrow: 1, rect: 1, circle: 1, text: 1, image: 1 };
var PATCH_KEYS = {
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
    for (var i = 0; i < el.points.length; i++) {
      var p = el.points[i];
      if (!Array.isArray(p) || p.length < 2 || !isNum(p[0]) || !isNum(p[1])) return false;
    }
  } else if (el.type === 'text') {
    if (typeof el.text !== 'string' || el.text.length > 5000) return false;
  } else if (el.type === 'image') {
    if (typeof el.src !== 'string' || el.src.length > 2500000) return false;
  }
  if (el.opacity !== undefined && (!isNum(el.opacity) || el.opacity < 0 || el.opacity > 1)) return false;
  if (el.strokeWidth !== undefined && (!isNum(el.strokeWidth) || el.strokeWidth < 0.5 || el.strokeWidth > 200)) return false;
  if (el.fontSize !== undefined && (!isNum(el.fontSize) || el.fontSize < 4 || el.fontSize > 500)) return false;
  if (el.rotation !== undefined && !isNum(el.rotation)) return false;
  return true;
}

function sanitizePatch(patch) {
  var out = {};
  if (!patch || typeof patch !== 'object') return out;
  Object.keys(patch).forEach(function (k) {
    if (!PATCH_KEYS[k]) return;
    var v = patch[k];
    if (k === 'points') {
      if (!Array.isArray(v) || v.length > 5000) return;
      for (var i = 0; i < v.length; i++) {
        var p = v[i];
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
    } else {
      if (isNum(v)) out[k] = v;
    }
  });
  return out;
}

/* ---------------- 层次调整 ---------------- */
function reorderElement(room, id, action) {
  var idx = findIndexById(room, id);
  if (idx < 0) return false;
  var el = room.elements.splice(idx, 1)[0];
  var ni = idx;
  if (action === 'toFront') ni = room.elements.length;
  else if (action === 'toBack') ni = 0;
  else if (action === 'forward') ni = Math.min(room.elements.length, idx + 1);
  else if (action === 'backward') ni = Math.max(0, idx - 1);
  else { room.elements.splice(idx, 0, el); return false; }
  room.elements.splice(ni, 0, el);
  return true;
}

/* 删除整个白板：清空内存房间数据、断开所有成员（创建者按钮与管理端共用） */
function deleteRoom(room) {
  room.deleted = true;
  broadcast(room, { type: 'room_deleted' }); // 通知所有成员（含发起者）
  delete rooms[room.id];
  Object.keys(room.clients).forEach(function (uid) {
    var c = room.clients[uid];
    if (c.ws && c.ws.readyState === 1) {
      try { c.ws.close(); } catch (e) {}
    }
  });
}

/* ---------------- WS 消息处理 ---------------- */
function handleMessage(room, client, msg) {
  if (!msg || typeof msg.type !== 'string') return;
  room.lastActive = now();

  if (msg.type === 'ping') { sendRaw(client, { type: 'pong' }); return; }

  // 激光笔：所有人（含发起者）都能看到轨迹
  if (msg.type === 'laser') {
    var x = isNum(msg.x) ? msg.x : 0;
    var y = isNum(msg.y) ? msg.y : 0;
    broadcast(room, { type: 'laser', uid: client.uid, x: x, y: y, active: !!msg.active });
    return;
  }

  // 选中状态广播：让其他成员看到谁在编辑哪些图案（只读成员也可选看；支持多选 ids）
  if (msg.type === 'sel') {
    var selIds = [];
    if (Array.isArray(msg.ids)) {
      for (var si = 0; si < msg.ids.length && si < 200; si++) {
        if (typeof msg.ids[si] === 'string' && msg.ids[si].length <= 40 && selIds.indexOf(msg.ids[si]) < 0) selIds.push(msg.ids[si]);
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
    var nm = String(msg.name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!nm) return;
    room.name = nm;
    broadcast(room, { type: 'room_renamed', name: nm }); // 含发起者
    return;
  }

  // 房主修改访问密码（留空表示取消密码）
  if (msg.type === 'pwd_change') {
    if (!client.owner) return;
    var np = String(msg.pwd || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (np === room.pwd) return;
    room.pwd = np;
    room.lastModified = now();
    broadcast(room, { type: 'room_password_changed', pwd: np }); // 含发起者
    // 设置 / 更换密码：旧密码失效，强制断开所有非房主成员，提示重新输入密码加入；
    // 清空密码（取消密码）后无需密码即可加入，不踢人
    if (np) {
      Object.keys(room.clients).forEach(function (uid) {
        var c = room.clients[uid];
        if (!c || c.owner) return;
        if (c.ws && c.ws.readyState === 1) {
          try { c.ws.send(JSON.stringify({ type: 'pwd_kicked', reason: '访问密码已更改，请重新输入密码加入' })); } catch (e) {}
          setTimeout(function () { try { c.ws.close(); } catch (e) {} }, 200);
        }
      });
    }
    return;
  }

  // 房主导入配置：全量替换白板内容（覆盖当前元素并清空撤销历史）
  if (msg.type === 'import') {
    if (!client.owner) return;
    if (!Array.isArray(msg.elements) || msg.elements.length > MAX_ELEMENTS) return;
    var clean = [];
    for (var ei = 0; ei < msg.elements.length; ei++) {
      if (validElement(msg.elements[ei])) clean.push(msg.elements[ei]);
    }
    room.elements = clean;
    room.undo.length = 0;
    room.redo.length = 0;
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
    applyUndoRedo(room, msg.type === 'undo');
    return;
  }

  if (client.readonly) return; // 只读客户端一律拒绝改动类消息

  room.lastModified = now(); // 可编辑成员的改动消息视为内容修改（供回收判定）

  switch (msg.type) {
    case 'add':
      if (validElement(msg.element) && room.elements.length < MAX_ELEMENTS) {
        if (msg.live) {
          // 绘制过程中的实时预览：不记录撤销历史（完成时统一 commit），访问者实时看到创建过程
          room.elements.push(msg.element);
          broadcast(room, { type: 'element_added', element: msg.element }, client.uid);
        } else {
          pushHistory(room);
          room.elements.push(msg.element);
          broadcast(room, { type: 'element_added', element: msg.element }, client.uid);
        }
      }
      break;

    case 'update': {
      var idx = findIndexById(room, msg.id);
      if (idx < 0) return;
      var patch = sanitizePatch(msg.patch);
      var keys = Object.keys(patch);
      if (!keys.length) return;
      if (msg.commit) {
        if (msg.undo && typeof msg.undo === 'object' && msg.undo.id === msg.id && ELEMENT_TYPES[msg.undo.type]) {
          // 拖动/变换期间已有节流更新先行改动元素，
          // 这里用拖动起点的元素快照作为历史条目，确保撤销能回到拖动前状态
          var snap = [];
          for (var si = 0; si < room.elements.length; si++) {
            if (room.elements[si].id === msg.id) snap.push(JSON.parse(JSON.stringify(msg.undo)));
            else snap.push(room.elements[si]);
          }
          room.undo.push(JSON.stringify(snap));
          if (room.undo.length > UNDO_DEPTH) room.undo.shift();
          room.redo.length = 0;
        } else {
          pushHistory(room);
        }
      }
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (k === 'points') {
          room.elements[idx].points = patch[k].map(function (p) { return [p[0], p[1]]; });
        } else {
          room.elements[idx][k] = patch[k];
        }
      }
      broadcast(room, { type: 'element_updated', id: msg.id, patch: patch, commit: !!msg.commit }, client.uid);
      break;
    }

    case 'delete': {
      var di = findIndexById(room, msg.id);
      if (di >= 0) {
        pushHistory(room);
        room.elements.splice(di, 1);
        broadcast(room, { type: 'element_deleted', id: msg.id }, client.uid);
      }
      break;
    }

    case 'clear':
      if (room.elements.length) {
        pushHistory(room);
        room.elements.length = 0;
        broadcast(room, { type: 'board_cleared' }, client.uid);
      }
      break;

    case 'reorder':
      if (reorderElement(room, msg.id, msg.action)) {
        pushHistory(room);
        broadcast(room, { type: 'reordered', id: msg.id, action: msg.action }, client.uid);
      }
      break;

    default:
      break;
  }
}

function applyUndoRedo(room, isUndo) {
  if (isUndo) {
    if (!room.undo.length) return;
    room.redo.push(JSON.stringify(room.elements));
    room.elements = JSON.parse(room.undo.pop());
  } else {
    if (!room.redo.length) return;
    room.undo.push(JSON.stringify(room.elements));
    room.elements = JSON.parse(room.redo.pop());
  }
  room.lastModified = now();
  broadcastState(room);
}

function sendRaw(client, msg) {
  if (client.ws && client.ws.readyState === 1) {
    try { client.ws.send(JSON.stringify(msg)); } catch (e) {}
  }
}

function deny(ws, error) {
  try { ws.send(JSON.stringify({ type: 'join_result', ok: false, error: error })); } catch (e) {}
  setTimeout(function () { try { ws.close(); } catch (e) {} }, 300);
}

/* ---------------- HTTP 服务 ---------------- */
function readBody(req, cb) {
  var chunks = [];
  var size = 0;
  req.on('data', function (c) {
    size += c.length;
    if (size > MAX_BODY) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', function () { cb(null, Buffer.concat(chunks).toString('utf8')); });
  req.on('error', function (e) { cb(e); });
}

function serveStatic(req, res) {
  var pathname;
  try { pathname = decodeURIComponent(url.parse(req.url).pathname); }
  catch (e) { res.writeHead(400); res.end(); return; }
  if (pathname === '/') pathname = '/index.html';
  var fp = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (fp.indexOf(PUBLIC_DIR) !== 0) { res.writeHead(403); res.end(); return; }
  fs.readFile(fp, function (err, data) {
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

var server = http.createServer(function (req, res) {
  var u = url.parse(req.url, true);
  if (req.method === 'POST' && u.pathname === '/api/create') {
    readBody(req, function (err, body) {
      if (err) { res.writeHead(400); res.end('{"ok":false,"error":"bad request"}'); return; }
      var data = {};
      try { data = JSON.parse(body || '{}'); } catch (e) {}
      // 可选的自定义房间号：仅允许大写字母 + 数字，1-10 位
      var rid = String(data.roomId || '').trim().toUpperCase();
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
      var room = createRoom(String(data.name || ''), String(data.pwd || ''), rid || null);
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
    var rid2 = String(u.query.id || '').trim().toUpperCase();
    var room2 = rooms[rid2];
    // 密码校验规则与 tryJoin 一致：无密码则通过；有密码则需匹配（创建者凭 key 不受限）
    var pwdOk2 = !room2 || !room2.pwd || (String(u.query.pwd || '') === room2.pwd);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ ok: true, exists: !!room2, pwdOk: pwdOk2 }));
    return;
  }

  /* ---------------- 管理员（HTTP 基本认证；账号由启动参数配置） ---------------- */
  if (u.pathname === '/admin' || u.pathname === '/admin.html') {
    if (ADMIN_ENABLED && !basicAuthOk(req)) { needAuth(res); return; }
    fs.readFile(path.join(PUBLIC_DIR, 'admin.html'), function (err, data) {
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
    readBody(req, function (err, body) {
      if (err) { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end('{"ok":false,"error":"bad request"}'); return; }
      var data = {};
      try { data = JSON.parse(body || '{}'); } catch (e) {}
      var r = rooms[data.id];
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
    var ids = Object.keys(rooms);
    for (var ai = 0; ai < ids.length; ai++) deleteRoom(rooms[ids[ai]]);
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
var wss = new WebSocketServer({ server: server, path: '/ws', maxPayload: MAX_MSG, perMessageDeflate: false });

function tryJoin(ws, msg, req) {
  var room = rooms[msg.room];
  if (!room || room.deleted) { deny(ws, '房间不存在，请检查房间号'); return null; }

  var isOwner = msg.key && msg.key === room.ownerKey;
  var pwdOk = !room.pwd || (msg.pwd || '') === room.pwd;
  if (!isOwner && !pwdOk) { deny(ws, '房间密码错误'); return null; }

  // 只读权限由分享链接中的 ro=1 决定（创建者始终可编辑）
  var readonly = isOwner ? false : (msg.ro === '1');
  var client = {
    uid: randId(10, 'abcdefghijklmnopqrstuvwxyz0123456789'),
    // 创建者的名字始终显示为“房主”
    name: isOwner ? '房主' : (String(msg.name || '').slice(0, 20) || ('访客' + Math.floor(Math.random() * 900 + 100))),
    // 房主标记颜色始终为红色；访客从非红色色板中随机分配
    color: isOwner ? '#E53935' : USER_COLORS[1 + Math.floor(Math.random() * (USER_COLORS.length - 1))],
    readonly: readonly,
    owner: isOwner,
    ws: ws
  };
  room.clients[client.uid] = client;
  room.lastActive = now();
  client._room = room;

  sendRaw(client, {
    type: 'welcome',
    self: { uid: client.uid, name: client.name, color: client.color, readonly: client.readonly, owner: client.owner },
    room: { id: room.id, name: room.name, pwd: room.pwd, shareUrl: shareUrl(req, room) },
    elements: room.elements,
    users: listUsers(room),
    undoable: room.undo.length > 0,
    redoable: room.redo.length > 0
  });
  broadcast(room, { type: 'user_joined', user: { uid: client.uid, name: client.name, color: client.color, readonly: client.readonly } }, client.uid);
  return client;
}

wss.on('connection', function (ws, req) {
  var client = null;
  var joined = false;
  // 若 8 秒内未发送 hello，关闭连接（保护资源）
  var helloTimer = setTimeout(function () {
    if (!joined) { try { ws.close(); } catch (e) {} }
  }, 8000);

  ws.on('message', function (data) {
    var msg;
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
  ws.on('close', function () {
    if (joined && client && roomOf(client).clients[client.uid]) {
      var r = roomOf(client);
      delete r.clients[client.uid];
      broadcast(r, { type: 'user_left', uid: client.uid });
    }
  });
  ws.on('error', function () {});
});

function roomOf(client) {
  return client && client._room;
}

/* 空闲房间自动回收：空白板无访问 1 小时删除；有内容白板无访问或修改 7 天删除（不阻塞进程退出） */
setInterval(function () {
  var t = now();
  Object.keys(rooms).forEach(function (id) {
    var r = rooms[id];
    if (!r) return;
    var lastMod = r.lastModified || r.lastActive;
    var idle = t - Math.max(r.lastActive, lastMod);
    var ttl = r.elements.length ? ROOM_TTL_CONTENT_MS : ROOM_TTL_EMPTY_MS;
    if (idle > ttl) delete rooms[id];
  });
}, 10 * 60 * 1000).unref();

server.listen(PORT, '0.0.0.0', function () {
  console.log('共享白板服务已启动: http://localhost:' + PORT);
});
