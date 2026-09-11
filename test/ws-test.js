'use strict';
/* ============================================================
 * 集成测试：自动在随机端口启动 server.js，验证核心协同逻辑
 * 覆盖：创建房间（含自定义房间号）/ 密码校验 / 分享时只读(ro=1) /
 *       元素增删广播 / 撤销重做 / 选中状态广播 / 激光笔 /
 *       创建者重命名 / 创建者删除白板 / 房主名称
 * 连接方式与真实客户端一致：连 /ws 后首条消息发送 hello 加入
 * ============================================================ */
var http = require('http');
var spawn = require('child_process').spawn;
var path = require('path');

var PORT = 18123;
var BASE = 'http://127.0.0.1:' + PORT;
var results = [];
var passed = 0, failed = 0;

function check(name, cond, extra) {
  if (cond) { passed++; results.push('PASS  ' + name); }
  else { failed++; results.push('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

function xhrPost(pathname, data) {
  return new Promise(function (resolve) {
    var body = JSON.stringify(data);
    var req = http.request({
      host: '127.0.0.1', port: PORT, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, function (res) {
      var buf = '';
      res.on('data', function (c) { buf += c; });
      res.on('end', function () {
        var r = {}; try { r = JSON.parse(buf); } catch (e) {}
        resolve({ status: res.statusCode, body: r });
      });
    });
    req.on('error', function () { resolve({ status: 0, body: {} }); });
    req.end(body);
  });
}

function waitServer(ms) {
  return new Promise(function (resolve) {
    var t = 0;
    var timer = setInterval(function () {
      t += 200;
      var req = http.get(BASE + '/', function () { clearInterval(timer); resolve(true); });
      req.on('error', function () { if (t > 10000) { clearInterval(timer); resolve(false); } });
    }, 200);
  });
}

/* 连 /ws（无查询参数），打开后发送 hello 完成加入 */
function openWS(params) {
  return new Promise(function (resolve, reject) {
    var WebSocket = require('ws');
    var ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
    var msgs = [];
    var timer = setTimeout(function () { reject(new Error('open timeout')); }, 3000);
    ws.on('message', function (d) { msgs.push(JSON.parse(String(d))); });
    ws.on('open', function () {
      clearTimeout(timer);
      ws.send(JSON.stringify({
        type: 'hello',
        room: params.room,
        pwd: params.pwd || '',
        key: params.key || '',
        ro: params.ro || '',
        name: params.name || ''
      }));
      resolve({ ws: ws, msgs: msgs });
    });
    ws.on('error', function (e) { clearTimeout(timer); reject(e); });
  });
}

function waitFor(fn, ms) {
  return new Promise(function (resolve) {
    var t = 0;
    var timer = setInterval(function () {
      t += 50;
      var v = fn();
      if (v) { clearInterval(timer); resolve(v); }
      else if (t > ms) { clearInterval(timer); resolve(null); }
    }, 50);
  });
}

function closeWS(c) { try { c.ws.close(); } catch (e) {} }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function main() {
  var server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'ignore', 'inherit']
  });
  var ok = await waitServer(3000);
  if (!ok) { console.log('服务启动失败'); process.exit(1); }

  try {
    /* 0. 自定义房间号：合法 / 非法 / 重复 */
    var cr0 = await xhrPost('/api/create', { name: '自定义房', pwd: '', roomId: 'MYROOM1' });
    check('自定义房间号创建成功', cr0.status === 200 && cr0.body.ok === true && cr0.body.id === 'MYROOM1', JSON.stringify(cr0.body));
    var cr0b = await xhrPost('/api/create', { name: '重复房', pwd: '', roomId: 'myroom1' });
    check('重复房间号被拒绝（大小写归一）', cr0b.status === 200 && cr0b.body.ok === false && cr0b.body.error.indexOf('占用') >= 0, JSON.stringify(cr0b.body));
    var cr0c = await xhrPost('/api/create', { name: '非法房', pwd: '', roomId: 'ab-12' });
    check('非法房间号被拒绝（仅大写字母+数字）', cr0c.status === 200 && cr0c.body.ok === false && cr0c.body.error.indexOf('大写字母') >= 0, JSON.stringify(cr0c.body));

    /* 1. 创建房间（只读权限由分享链接 ro=1 决定，创建接口不接收 readonly） */
    var cr = await xhrPost('/api/create', { name: '测试房', pwd: 'abc123' });
    check('创建房间返回 ok', cr.status === 200 && cr.body.ok === true, JSON.stringify(cr.body));
    check('创建房间返回房间号/钥匙/分享链接', !!(cr.body.id && cr.body.ownerKey && cr.body.shareUrl));
    check('分享链接默认不带只读标记', cr.body.shareUrl.indexOf('ro=1') < 0, cr.body.shareUrl);
    var roomId = cr.body.id, key = cr.body.ownerKey;

    /* 2. 房主连接（名字固定为“房主”） */
    var owner = await openWS({ room: roomId, key: key, name: '随便起的名' });
    var welcome = await waitFor(function () {
      for (var i = 0; i < owner.msgs.length; i++) if (owner.msgs[i].type === 'welcome') return owner.msgs[i];
      return null;
    }, 2000);
    check('房主 welcome 且非只读', !!welcome && welcome.self.readonly === false, JSON.stringify(welcome));
    check('房主名字始终显示为“房主”', !!welcome && welcome.self.name === '房主', welcome && welcome.self.name);
    check('房主标记颜色始终为红色', !!welcome && welcome.self.color === '#E53935', welcome && welcome.self.color);
    check('welcome 携带房间分享链接', !!welcome && typeof welcome.room.shareUrl === 'string' && welcome.room.shareUrl.indexOf('room=' + roomId) >= 0);

    /* 3. 密码错误拒绝 */
    var bad = await openWS({ room: roomId, pwd: 'wrong' });
    var badMsg = await waitFor(function () {
      for (var i = 0; i < bad.msgs.length; i++) if (bad.msgs[i].type === 'join_result') return bad.msgs[i];
      return null;
    }, 1500);
    check('错误密码被拒绝', !!badMsg && badMsg.ok === false && badMsg.error.indexOf('密码') >= 0, JSON.stringify(badMsg));
    closeWS(bad);

    /* 4. 正确密码访客（未带 ro=1）默认可编辑 */
    var guest = await openWS({ room: roomId, pwd: 'abc123', name: '访客A' });
    var gw = await waitFor(function () {
      for (var i = 0; i < guest.msgs.length; i++) if (guest.msgs[i].type === 'welcome') return guest.msgs[i];
      return null;
    }, 2000);
    check('访客（无 ro）welcome 且可编辑', !!gw && gw.self.readonly === false, JSON.stringify(gw));
    check('房主收到 user_joined 广播', owner.msgs.some(function (m) { return m.type === 'user_joined' && m.user.name === '访客A'; }));

    /* 5. 房主新增元素，访客收到广播 */
    var el = { id: 'e1', type: 'rect', x: 100, y: 100, w: 80, h: 40, stroke: '#E53935', fill: 'none', opacity: 1, rotation: 0, strokeWidth: 4 };
    owner.ws.send(JSON.stringify({ type: 'add', element: el }));
    var gotAdded = await waitFor(function () {
      for (var i = 0; i < guest.msgs.length; i++) if (guest.msgs[i].type === 'element_added' && guest.msgs[i].element.id === 'e1') return true;
      return null;
    }, 1500);
    check('访客收到 element_added', gotAdded === true);

    /* 6. 只读访客（分享链接带 ro=1）加入且被限制 */
    var roGuest = await openWS({ room: roomId, pwd: 'abc123', name: '只读访客', ro: '1' });
    var rw = await waitFor(function () {
      for (var i = 0; i < roGuest.msgs.length; i++) if (roGuest.msgs[i].type === 'welcome') return roGuest.msgs[i];
      return null;
    }, 2000);
    check('只读访客 welcome 且为只读', !!rw && rw.self.readonly === true, JSON.stringify(rw));
    var before = owner.msgs.length;
    roGuest.ws.send(JSON.stringify({ type: 'add', element: { id: 'eBad', type: 'rect', x: 1, y: 1, w: 5, h: 5 } }));
    await new Promise(function (r) { setTimeout(r, 600); });
    check('只读访客的 add 未被转发', owner.msgs.length === before, 'owner msgs: ' + owner.msgs.length);

    /* 7. 撤销：只读忽略，房主生效并广播 */
    roGuest.ws.send(JSON.stringify({ type: 'undo' }));
    await new Promise(function (r) { setTimeout(r, 300); });
    var st1 = await waitFor(function () {
      for (var i = 0; i < roGuest.msgs.length; i++) if (roGuest.msgs[i].type === 'state') return roGuest.msgs[i];
      return null;
    }, 1500);
    check('只读 undo 被忽略（无 state 广播）', st1 === null);

    owner.ws.send(JSON.stringify({ type: 'undo' }));
    var st2 = await waitFor(function () {
      var arr = owner.msgs.concat(guest.msgs).concat(roGuest.msgs);
      for (var i = 0; i < arr.length; i++) if (arr[i].type === 'state') return arr[i];
      return null;
    }, 1500);
    check('房主 undo 广播 state', !!st2 && st2.elements.length === 0 && st2.undoable === false && st2.redoable === true);

    /* 8. update + delete 广播 */
    var el2 = { id: 'e2', type: 'line', x1: 0, y1: 0, x2: 50, y2: 50, stroke: '#000', strokeWidth: 2, opacity: 1 };
    owner.ws.send(JSON.stringify({ type: 'add', element: el2 }));
    await waitFor(function () {
      for (var i = 0; i < guest.msgs.length; i++) if (guest.msgs[i].type === 'element_added' && guest.msgs[i].element.id === 'e2') return true;
      return null;
    }, 1500);
    owner.ws.send(JSON.stringify({ type: 'update', id: 'e2', patch: { x2: 99, y2: 88 }, commit: true }));
    var gotUpd = await waitFor(function () {
      for (var i = 0; i < guest.msgs.length; i++) if (guest.msgs[i].type === 'element_updated' && guest.msgs[i].id === 'e2' && guest.msgs[i].patch.x2 === 99) return true;
      return null;
    }, 1500);
    check('访客收到 element_updated', gotUpd === true);
    owner.ws.send(JSON.stringify({ type: 'delete', id: 'e2' }));
    var gotDel = await waitFor(function () {
      for (var i = 0; i < guest.msgs.length; i++) if (guest.msgs[i].type === 'element_deleted' && guest.msgs[i].id === 'e2') return true;
      return null;
    }, 1500);
    check('访客收到 element_deleted', gotDel === true);

    /* 9. 选中状态广播（多选 ids 数组，让访问者看到编辑状态） */
    owner.ws.send(JSON.stringify({ type: 'sel', ids: ['e1', 'eBad'] }));
    var gotSel = await waitFor(function () {
      for (var i = 0; i < guest.msgs.length; i++) if (guest.msgs[i].type === 'selection' && guest.msgs[i].ids && guest.msgs[i].ids.length === 2 && guest.msgs[i].ids.indexOf('e1') >= 0) return true;
      return null;
    }, 1500);
    check('选中状态广播（含多选 ids）给其他成员', gotSel === true);
    owner.ws.send(JSON.stringify({ type: 'sel', ids: [] }));
    var gotSelClear = await waitFor(function () {
      for (var i = 0; i < guest.msgs.length; i++) if (guest.msgs[i].type === 'selection' && (!guest.msgs[i].ids || !guest.msgs[i].ids.length)) return true;
      return null;
    }, 1500);
    check('取消选中状态广播', gotSelClear === true);

    /* 10. 激光笔广播：使用者与访问者都能看到轨迹（含发起者） */
    roGuest.ws.send(JSON.stringify({ type: 'laser', x: 10, y: 20, active: true }));
    var gotLaser = await waitFor(function () {
      for (var i = 0; i < owner.msgs.length; i++) if (owner.msgs[i].type === 'laser' && owner.msgs[i].active) return true;
      return null;
    }, 1500);
    check('激光笔广播给其他成员', gotLaser === true);
    var gotLaserSelf = await waitFor(function () {
      for (var i = 0; i < roGuest.msgs.length; i++) if (roGuest.msgs[i].type === 'laser' && roGuest.msgs[i].active) return true;
      return null;
    }, 1500);
    check('激光笔也回传发起者（自己可见轨迹）', gotLaserSelf === true);

    /* 11. 创建者重命名白板（访客改名被忽略） */
    guest.ws.send(JSON.stringify({ type: 'rename', name: '偷偷改名' }));
    await new Promise(function (r) { setTimeout(r, 300); });
    owner.ws.send(JSON.stringify({ type: 'rename', name: '新产品评审会' }));
    var gotRenamed = await waitFor(function () {
      var arr = owner.msgs.concat(guest.msgs).concat(roGuest.msgs);
      for (var i = 0; i < arr.length; i++) if (arr[i].type === 'room_renamed') return arr[i];
      return null;
    }, 1500);
    check('创建者改名广播给所有成员', !!gotRenamed && gotRenamed.name === '新产品评审会', JSON.stringify(gotRenamed));

    /* 12. 房主修改访问密码（访客被拒；广播给所有成员；旧密码失效、新密码生效） */
    guest.ws.send(JSON.stringify({ type: 'pwd_change', pwd: 'hack' }));
    await sleep(300);
    owner.ws.send(JSON.stringify({ type: 'pwd_change', pwd: 'newpwd456' }));
    var gotPwd = await waitFor(function () {
      var arr = owner.msgs.concat(guest.msgs).concat(roGuest.msgs);
      for (var i = 0; i < arr.length; i++) if (arr[i].type === 'room_password_changed') return arr[i];
      return null;
    }, 1500);
    check('房主修改访问密码广播给所有成员', !!gotPwd && gotPwd.pwd === 'newpwd456', JSON.stringify(gotPwd));
    var gotKick = await waitFor(function () {
      var arr = guest.msgs.concat(roGuest.msgs);
      for (var i = 0; i < arr.length; i++) if (arr[i].type === 'pwd_kicked') return arr[i];
      return null;
    }, 1500);
    check('改密后访问者收到 pwd_kicked 被强制退出', !!gotKick && gotKick.reason.indexOf('密码') >= 0, JSON.stringify(gotKick));
    var oldJoin = await openWS({ room: roomId, pwd: 'abc123' });
    var oldRes = await waitFor(function () {
      for (var i = 0; i < oldJoin.msgs.length; i++) if (oldJoin.msgs[i].type === 'join_result') return oldJoin.msgs[i];
      return null;
    }, 1500);
    check('改密后旧密码无法加入', !!oldRes && oldRes.ok === false, JSON.stringify(oldRes));
    closeWS(oldJoin);
    var newJoin = await openWS({ room: roomId, pwd: 'newpwd456' });
    var newRes = await waitFor(function () {
      for (var i = 0; i < newJoin.msgs.length; i++) if (newJoin.msgs[i].type === 'welcome') return newJoin.msgs[i];
      return null;
    }, 1500);
    check('改密后新密码可加入', !!newRes, JSON.stringify(newRes));
    closeWS(newJoin);
    // 原 guest / roGuest 已被密码变更强制断开，后续测试新建访客
    closeWS(guest);
    closeWS(roGuest);
    var guest2 = await openWS({ room: roomId, pwd: 'newpwd456', name: '访客2' });
    await waitFor(function () {
      for (var i = 0; i < guest2.msgs.length; i++) if (guest2.msgs[i].type === 'welcome') return true;
      return null;
    }, 1500);

    /* 13. 房主导入配置（访客被拒；非法元素被过滤；覆盖全部元素并广播 state） */
    guest2.ws.send(JSON.stringify({ type: 'import', elements: [{ id: 'x1', type: 'rect' }] }));
    await sleep(300);
    var importEls = [
      { id: 'i1', type: 'rect', x: 10, y: 10, w: 50, h: 40, stroke: '#000', fill: 'rgba(0,0,0,0)', strokeWidth: 4, rotation: 0 },
      { id: 'i2', type: 'line', x1: 0, y1: 0, x2: 60, y2: 60, stroke: '#f00', strokeWidth: 2, rotation: 0 },
      { id: 'bad', type: 'nonsense' }
    ];
    owner.ws.send(JSON.stringify({ type: 'import', elements: importEls }));
    var gotState = await waitFor(function () {
      var arr = owner.msgs.concat(guest2.msgs);
      for (var i = 0; i < arr.length; i++) {
        var m = arr[i];
        if (m.type === 'state' && m.elements && m.elements.length === 2) return m;
      }
      return null;
    }, 1500);
    check('房主导入配置覆盖白板并广播 state（非法元素被过滤）',
      !!gotState && gotState.elements[0].id === 'i1' && gotState.elements[1].id === 'i2',
      JSON.stringify(gotState && gotState.elements));

    /* 14. 创建者删除白板：通知所有成员 + 房间从内存清除 */
    var gone = false;
    guest2.ws.on('message', function (d) {
      var m = JSON.parse(String(d));
      if (m.type === 'room_deleted') gone = true;
    });
    owner.ws.send(JSON.stringify({ type: 'delete_room' }));
    await waitFor(function () { return gone; }, 1500);
    check('成员收到 room_deleted', gone === true);
    var after = await openWS({ room: roomId, pwd: 'newpwd456' });
    var goneMsg = await waitFor(function () {
      for (var i = 0; i < after.msgs.length; i++) if (after.msgs[i].type === 'join_result') return after.msgs[i];
      return null;
    }, 1500);
    check('删除后房间不可再加入', !!goneMsg && goneMsg.ok === false, JSON.stringify(goneMsg));
    closeWS(after);

    closeWS(owner);
    closeWS(guest2);
    closeWS(guest);
    closeWS(roGuest);

  } catch (e) {
    failed++;
    results.push('FAIL  异常: ' + e.message);
  } finally {
    try { server.kill(); } catch (e) {}
  }

  console.log(results.join('\n'));
  console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  process.exit(failed ? 1 : 0);
}

main();
