'use strict';
/* ============================================================
 * 集成测试：自动在随机端口启动 server.js，验证核心协同逻辑
 * 覆盖：创建房间（含自定义房间号）/ 密码校验 / 分享时只读(ro=1) /
 *       元素增删广播 / 撤销重做 / 选中状态广播 / 激光笔 /
 *       创建者重命名 / 创建者删除白板 / 房主名称
 * 连接方式与真实客户端一致：连 /ws 后首条消息发送 hello 加入
 * ============================================================ */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 18123;
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
let passed = 0, failed = 0;

function check(name, cond, extra) {
  if (cond) { passed++; results.push('PASS  ' + name); }
  else { failed++; results.push('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

function xhrPost(pathname, data) {
  return new Promise((resolve) => {
    const body = JSON.stringify(data);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let r = {}; try { r = JSON.parse(buf); } catch (e) {}
        resolve({ status: res.statusCode, body: r });
      });
    });
    req.on('error', () => resolve({ status: 0, body: {} }));
    req.end(body);
  });
}

function waitServer(ms) {
  return new Promise((resolve) => {
    let t = 0;
    const timer = setInterval(() => {
      t += 200;
      const req = http.get(BASE + '/', () => { clearInterval(timer); resolve(true); });
      req.on('error', () => { if (t > 10000) { clearInterval(timer); resolve(false); } });
    }, 200);
  });
}

/* 连 /ws（无查询参数），打开后发送 hello 完成加入 */
function openWS(params) {
  return new Promise((resolve, reject) => {
    const WebSocket = require('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const msgs = [];
    const timer = setTimeout(() => reject(new Error('open timeout')), 3000);
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    ws.on('open', () => {
      clearTimeout(timer);
      ws.send(JSON.stringify({
        type: 'hello',
        room: params.room,
        pwd: params.pwd || '',
        key: params.key || '',
        ro: params.ro || '',
        name: params.name || ''
      }));
      resolve({ ws, msgs });
    });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function waitFor(fn, ms) {
  return new Promise((resolve) => {
    let t = 0;
    const timer = setInterval(() => {
      t += 50;
      const v = fn();
      if (v) { clearInterval(timer); resolve(v); }
      else if (t > ms) { clearInterval(timer); resolve(null); }
    }, 50);
  });
}

function closeWS(c) { try { c.ws.close(); } catch (e) {} }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'ignore', 'inherit']
  });
  const ok = await waitServer(3000);
  if (!ok) { console.log('服务启动失败'); process.exit(1); }

  try {
    /* 0. 自定义房间号：合法 / 非法 / 重复 */
    const cr0 = await xhrPost('/api/create', { name: '自定义房', pwd: '', roomId: 'MYROOM1' });
    check('自定义房间号创建成功', cr0.status === 200 && cr0.body.ok === true && cr0.body.id === 'MYROOM1', JSON.stringify(cr0.body));
    const cr0b = await xhrPost('/api/create', { name: '重复房', pwd: '', roomId: 'myroom1' });
    check('重复房间号被拒绝（大小写归一）', cr0b.status === 200 && cr0b.body.ok === false && cr0b.body.error.indexOf('占用') >= 0, JSON.stringify(cr0b.body));
    const cr0c = await xhrPost('/api/create', { name: '非法房', pwd: '', roomId: 'ab-12' });
    check('非法房间号被拒绝（仅大写字母+数字）', cr0c.status === 200 && cr0c.body.ok === false && cr0c.body.error.indexOf('大写字母') >= 0, JSON.stringify(cr0c.body));

    /* 1. 创建房间（只读权限由分享链接 ro=1 决定，创建接口不接收 readonly） */
    const cr = await xhrPost('/api/create', { name: '测试房', pwd: 'abc123' });
    check('创建房间返回 ok', cr.status === 200 && cr.body.ok === true, JSON.stringify(cr.body));
    check('创建房间返回房间号/钥匙/分享链接', !!(cr.body.id && cr.body.ownerKey && cr.body.shareUrl));
    check('分享链接默认不带只读标记', cr.body.shareUrl.indexOf('ro=1') < 0, cr.body.shareUrl);
    const roomId = cr.body.id, key = cr.body.ownerKey;

    /* 2. 房主连接（名字固定为“房主”） */
    const owner = await openWS({ room: roomId, key, name: '随便起的名' });
    const welcome = await waitFor(() => {
      for (let i = 0; i < owner.msgs.length; i++) if (owner.msgs[i].type === 'welcome') return owner.msgs[i];
      return null;
    }, 2000);
    check('房主 welcome 且非只读', !!welcome && welcome.self.readonly === false, JSON.stringify(welcome));
    check('房主名字始终显示为“房主”', !!welcome && welcome.self.name === '房主', welcome && welcome.self.name);
    check('房主标记颜色始终为红色', !!welcome && welcome.self.color === '#E53935', welcome && welcome.self.color);
    check('welcome 携带房间分享链接', !!welcome && typeof welcome.room.shareUrl === 'string' && welcome.room.shareUrl.indexOf('room=' + roomId) >= 0);

    /* 3. 密码错误拒绝 */
    const bad = await openWS({ room: roomId, pwd: 'wrong' });
    const badMsg = await waitFor(() => {
      for (let i = 0; i < bad.msgs.length; i++) if (bad.msgs[i].type === 'join_result') return bad.msgs[i];
      return null;
    }, 1500);
    check('错误密码被拒绝', !!badMsg && badMsg.ok === false && badMsg.error.indexOf('密码') >= 0, JSON.stringify(badMsg));
    closeWS(bad);

    /* 4. 正确密码访客（未带 ro=1）默认可编辑 */
    const guest = await openWS({ room: roomId, pwd: 'abc123', name: '访客A' });
    const gw = await waitFor(() => {
      for (let i = 0; i < guest.msgs.length; i++) if (guest.msgs[i].type === 'welcome') return guest.msgs[i];
      return null;
    }, 2000);
    check('访客（无 ro）welcome 且可编辑', !!gw && gw.self.readonly === false, JSON.stringify(gw));
    check('房主收到 user_joined 广播', owner.msgs.some((m) => m.type === 'user_joined' && m.user.name === '访客A'));

    /* 5. 房主新增元素，访客收到广播 */
    const el = { id: 'e1', type: 'rect', x: 100, y: 100, w: 80, h: 40, stroke: '#E53935', fill: 'none', opacity: 1, rotation: 0, strokeWidth: 4 };
    owner.ws.send(JSON.stringify({ type: 'add', element: el }));
    const gotAdded = await waitFor(() => {
      for (let i = 0; i < guest.msgs.length; i++) if (guest.msgs[i].type === 'element_added' && guest.msgs[i].element.id === 'e1') return true;
      return null;
    }, 1500);
    check('访客收到 element_added', gotAdded === true);

    /* 6. 只读访客（分享链接带 ro=1）加入且被限制 */
    const roGuest = await openWS({ room: roomId, pwd: 'abc123', name: '只读访客', ro: '1' });
    const rw = await waitFor(() => {
      for (let i = 0; i < roGuest.msgs.length; i++) if (roGuest.msgs[i].type === 'welcome') return roGuest.msgs[i];
      return null;
    }, 2000);
    check('只读访客 welcome 且为只读', !!rw && rw.self.readonly === true, JSON.stringify(rw));
    const before = owner.msgs.length;
    roGuest.ws.send(JSON.stringify({ type: 'add', element: { id: 'eBad', type: 'rect', x: 1, y: 1, w: 5, h: 5 } }));
    await sleep(600);
    check('只读访客的 add 未被转发', owner.msgs.length === before, `owner msgs: ${owner.msgs.length}`);

    /* 7. 撤销：只读忽略，房主生效并广播 */
    roGuest.ws.send(JSON.stringify({ type: 'undo' }));
    await sleep(300);
    const st1 = await waitFor(() => {
      for (let i = 0; i < roGuest.msgs.length; i++) if (roGuest.msgs[i].type === 'state') return roGuest.msgs[i];
      return null;
    }, 1500);
    check('只读 undo 被忽略（无 state 广播）', st1 === null);

    owner.ws.send(JSON.stringify({ type: 'undo' }));
    const st2 = await waitFor(() => {
      // 撤销/重做后 state 只校正其他成员（操作人本地已执行，无需收到）
      const arr = guest.msgs.concat(roGuest.msgs);
      for (let i = 0; i < arr.length; i++) if (arr[i].type === 'state') return arr[i];
      return null;
    }, 1500);
    const ownerGotState = owner.msgs.some((m) => m.type === 'state');
    check('撤销/重做操作人无需收到 state 校正（只广播其他成员）',
      ownerGotState === false && !!st2, `ownerState=${ownerGotState}`);
    check('其他成员收到 state 校正（可撤销 → 可重做）',
      !!st2 && st2.elements.length === 0 && st2.undoable === false && st2.redoable === true);
    check('state 携带操作时间线（history/historyIndex）',
      !!st2 && Array.isArray(st2.history) && st2.history.length === 1 && st2.historyIndex === -1,
      st2 ? `h=${st2.history && st2.history.length} i=${st2.historyIndex}` : '未收到');

    /* 8. update + delete 广播 */
    const el2 = { id: 'e2', type: 'line', x1: 0, y1: 0, x2: 50, y2: 50, stroke: '#000', strokeWidth: 2, opacity: 1 };
    owner.ws.send(JSON.stringify({ type: 'add', element: el2 }));
    await waitFor(() => {
      for (let i = 0; i < guest.msgs.length; i++) if (guest.msgs[i].type === 'element_added' && guest.msgs[i].element.id === 'e2') return true;
      return null;
    }, 1500);
    owner.ws.send(JSON.stringify({ type: 'update', id: 'e2', patch: { x2: 99, y2: 88 }, commit: true }));
    const gotUpd = await waitFor(() => {
      for (let i = 0; i < guest.msgs.length; i++) if (guest.msgs[i].type === 'element_updated' && guest.msgs[i].id === 'e2' && guest.msgs[i].patch.x2 === 99) return guest.msgs[i];
      return null;
    }, 1500);
    check('访客收到 element_updated', !!gotUpd);
    check('element_updated 广播携带更新前快照（before，供远端镜像撤销栈）',
      !!gotUpd && gotUpd.before && gotUpd.before.id === 'e2' && gotUpd.before.x2 === 50,
      gotUpd ? JSON.stringify(gotUpd.before) : '未收到');
    owner.ws.send(JSON.stringify({ type: 'delete', id: 'e2' }));
    const gotDel = await waitFor(() => {
      for (let i = 0; i < guest.msgs.length; i++) if (guest.msgs[i].type === 'element_deleted' && guest.msgs[i].id === 'e2') return true;
      return null;
    }, 1500);
    check('访客收到 element_deleted', gotDel === true);

    /* 9. 选中状态广播（多选 ids 数组，让访问者看到编辑状态） */
    owner.ws.send(JSON.stringify({ type: 'sel', ids: ['e1', 'eBad'] }));
    const gotSel = await waitFor(() => {
      for (let i = 0; i < guest.msgs.length; i++) if (guest.msgs[i].type === 'selection' && guest.msgs[i].ids && guest.msgs[i].ids.length === 2 && guest.msgs[i].ids.indexOf('e1') >= 0) return true;
      return null;
    }, 1500);
    check('选中状态广播（含多选 ids）给其他成员', gotSel === true);
    owner.ws.send(JSON.stringify({ type: 'sel', ids: [] }));
    const gotSelClear = await waitFor(() => {
      for (let i = 0; i < guest.msgs.length; i++) if (guest.msgs[i].type === 'selection' && (!guest.msgs[i].ids || !guest.msgs[i].ids.length)) return true;
      return null;
    }, 1500);
    check('取消选中状态广播', gotSelClear === true);

    /* 10. 激光笔广播：只给其他成员（发起者本地渲染，不回传自身） */
    roGuest.ws.send(JSON.stringify({ type: 'laser', x: 10, y: 20, active: true }));
    const gotLaser = await waitFor(() => {
      for (let i = 0; i < owner.msgs.length; i++) if (owner.msgs[i].type === 'laser' && owner.msgs[i].active) return true;
      return null;
    }, 1500);
    check('激光笔广播给其他成员', gotLaser === true);
    let gotLaserSelf = false;
    for (let lsi = 0; lsi < roGuest.msgs.length; lsi++) {
      if (roGuest.msgs[lsi].type === 'laser' && roGuest.msgs[lsi].active) { gotLaserSelf = true; break; }
    }
    check('激光笔不回传发起者（本地渲染自己轨迹）', gotLaserSelf === false);

    /* 11. 创建者重命名白板（访客改名被忽略） */
    guest.ws.send(JSON.stringify({ type: 'rename', name: '偷偷改名' }));
    await sleep(300);
    owner.ws.send(JSON.stringify({ type: 'rename', name: '新产品评审会' }));
    const gotRenamed = await waitFor(() => {
      const arr = owner.msgs.concat(guest.msgs).concat(roGuest.msgs);
      for (let i = 0; i < arr.length; i++) if (arr[i].type === 'room_renamed') return arr[i];
      return null;
    }, 1500);
    check('创建者改名广播给所有成员', !!gotRenamed && gotRenamed.name === '新产品评审会', JSON.stringify(gotRenamed));

    /* 12. 房主修改访问密码（访客被拒；广播给所有成员；旧密码失效、新密码生效） */
    guest.ws.send(JSON.stringify({ type: 'pwd_change', pwd: 'hack' }));
    await sleep(300);
    owner.ws.send(JSON.stringify({ type: 'pwd_change', pwd: 'newpwd456' }));
    const gotPwd = await waitFor(() => {
      const arr = owner.msgs.concat(guest.msgs).concat(roGuest.msgs);
      for (let i = 0; i < arr.length; i++) if (arr[i].type === 'room_password_changed') return arr[i];
      return null;
    }, 1500);
    check('房主修改访问密码广播给所有成员', !!gotPwd && gotPwd.pwd === 'newpwd456', JSON.stringify(gotPwd));
    const gotKick = await waitFor(() => {
      const arr = guest.msgs.concat(roGuest.msgs);
      for (let i = 0; i < arr.length; i++) if (arr[i].type === 'pwd_kicked') return arr[i];
      return null;
    }, 1500);
    check('改密后访问者收到 pwd_kicked 被强制退出', !!gotKick && gotKick.reason.indexOf('密码') >= 0, JSON.stringify(gotKick));
    const oldJoin = await openWS({ room: roomId, pwd: 'abc123' });
    const oldRes = await waitFor(() => {
      for (let i = 0; i < oldJoin.msgs.length; i++) if (oldJoin.msgs[i].type === 'join_result') return oldJoin.msgs[i];
      return null;
    }, 1500);
    check('改密后旧密码无法加入', !!oldRes && oldRes.ok === false, JSON.stringify(oldRes));
    closeWS(oldJoin);
    const newJoin = await openWS({ room: roomId, pwd: 'newpwd456' });
    const newRes = await waitFor(() => {
      for (let i = 0; i < newJoin.msgs.length; i++) if (newJoin.msgs[i].type === 'welcome') return newJoin.msgs[i];
      return null;
    }, 1500);
    check('改密后新密码可加入', !!newRes, JSON.stringify(newRes));
    closeWS(newJoin);
    // 原 guest / roGuest 已被密码变更强制断开，后续测试新建访客
    closeWS(guest);
    closeWS(roGuest);
    const guest2 = await openWS({ room: roomId, pwd: 'newpwd456', name: '访客2' });
    await waitFor(() => {
      for (let i = 0; i < guest2.msgs.length; i++) if (guest2.msgs[i].type === 'welcome') return true;
      return null;
    }, 1500);

    /* 13. 房主导入配置（访客被拒；非法元素被过滤；覆盖全部元素并广播 state） */
    guest2.ws.send(JSON.stringify({ type: 'import', elements: [{ id: 'x1', type: 'rect' }] }));
    await sleep(300);
    const importEls = [
      { id: 'i1', type: 'rect', x: 10, y: 10, w: 50, h: 40, stroke: '#000', fill: 'rgba(0,0,0,0)', strokeWidth: 4, rotation: 0 },
      { id: 'i2', type: 'line', x1: 0, y1: 0, x2: 60, y2: 60, stroke: '#f00', strokeWidth: 2, rotation: 0 },
      { id: 'bad', type: 'nonsense' }
    ];
    owner.ws.send(JSON.stringify({ type: 'import', elements: importEls }));
    const gotState = await waitFor(() => {
      const arr = owner.msgs.concat(guest2.msgs);
      for (let i = 0; i < arr.length; i++) {
        const m = arr[i];
        if (m.type === 'state' && m.elements && m.elements.length === 2) return m;
      }
      return null;
    }, 1500);
    check('房主导入配置覆盖白板并广播 state（非法元素被过滤）',
      !!gotState && gotState.elements[0].id === 'i1' && gotState.elements[1].id === 'i2',
      JSON.stringify(gotState && gotState.elements));
    check('导入后 state 携带图片池与空时间线（全量替换）',
      !!gotState && Array.isArray(gotState.images) && gotState.images.length === 0 &&
      Array.isArray(gotState.history) && gotState.history.length === 0 && gotState.historyIndex === -1,
      gotState ? `imgs=${gotState.images && gotState.images.length} h=${gotState.history && gotState.history.length} i=${gotState.historyIndex}` : '未收到');

    /* 15. 图片池去重（复制图片不重复存储）+ 新成员访问时获取全部缓存数据（含撤销/重做历史） */
    const cr3 = await xhrPost('/api/create', { name: '图片池房', pwd: '' });
    const roomId3 = cr3.body.id, key3 = cr3.body.ownerKey;
    const owner3 = await openWS({ room: roomId3, key: key3, name: '房主3' });
    await waitFor(() => owner3.msgs.some((m) => m.type === 'welcome'), 2000);
    // 非 live 添加矩形 → 服务器时间线 1 条（add 操作记录）
    owner3.ws.send(JSON.stringify({ type: 'add', element: { id: 'r3', type: 'rect', x: 1, y: 1, w: 10, h: 10 } }));
    await waitFor(() => owner3.msgs.some((m) => m.type === 'history' && m.undoable), 1500);
    // 新访客加入 → welcome 一次性携带全部元素 + 图片池 + 操作时间线
    const guest3 = await openWS({ room: roomId3, name: '访客3' });
    const w3 = await waitFor(() => guest3.msgs.find((m) => m.type === 'welcome'), 2000);
    check('welcome 携带全部元素与操作时间线（含历史记录）',
      !!w3 && w3.elements.length === 1 && Array.isArray(w3.images) && w3.images.length === 0 &&
      Array.isArray(w3.history) && w3.history.length === 1 && w3.history[0].t === 'add' &&
      w3.historyIndex === 0 && w3.undoable === true,
      w3 ? `els=${w3.elements && w3.elements.length} imgs=${w3.images && w3.images.length} h=${w3.history && w3.history.length} i=${w3.historyIndex}` : '未收到');
    // 访客撤销（服务器权威执行并广播）→ state 携带时间线（指针回退到初始）
    guest3.ws.send(JSON.stringify({ type: 'undo' }));
    const st3 = await waitFor(() => {
      const arr = owner3.msgs.concat(guest3.msgs);
      return arr.find((m) => m.type === 'state');
    }, 1500);
    check('撤销后 state 携带时间线（指针 -1，可重做）',
      !!st3 && st3.elements.length === 0 && Array.isArray(st3.history) && st3.history.length === 1 &&
      st3.historyIndex === -1 && st3.redoable === true,
      st3 ? `els=${st3.elements && st3.elements.length} h=${st3.history && st3.history.length} i=${st3.historyIndex}` : '未收到');
    // 图片：新插入（带 src）→ 入池并广播 image_added；复制（同 imageId 无 src）→ 复用，不重复存储/广播
    owner3.ws.send(JSON.stringify({ type: 'add', element: { id: 'i1', type: 'image', imageId: 'pic1', src: 'data:image/png;base64,AAAA', x: 1, y: 1, w: 5, h: 5 } }));
    await waitFor(() => owner3.msgs.some((m) => m.type === 'image_added' && m.image.id === 'pic1'), 1500);
    owner3.ws.send(JSON.stringify({ type: 'add', element: { id: 'i2', type: 'image', imageId: 'pic1', x: 20, y: 20, w: 5, h: 5 } })); // 复制图片：仅 imageId 引用
    await sleep(400);
    let imgAddedCount = 0;
    for (let mi = 0; mi < owner3.msgs.length; mi++) {
      if (owner3.msgs[mi].type === 'image_added' && owner3.msgs[mi].image.id === 'pic1') imgAddedCount++;
    }
    check('复制图片不重复广播 image_added（仅首次入池广播）', imgAddedCount === 1, `count=${imgAddedCount}`);
    // 新访客 welcome：images 仅 1 条（去重），两个图片元素都只引用 imageId 且不带 src
    const guest3b = await openWS({ room: roomId3, name: '访客3b' });
    const w3b = await waitFor(() => guest3b.msgs.find((m) => m.type === 'welcome'), 2000);
    const imgEls3 = w3b ? w3b.elements.filter((e) => e.type === 'image') : [];
    const imgEl1 = w3b ? w3b.elements.find((e) => e.id === 'i1') : null;
    check('复制图片不重复存储（imageId 去重，图片池仅 1 条）',
      !!w3b && w3b.images.length === 1 && imgEls3.length === 2 && w3b.images[0].id === 'pic1' && w3b.images[0].src === 'data:image/png;base64,AAAA',
      w3b ? `imgs=${w3b.images.length} imgEls=${imgEls3.length}` : '未收到');
    check('图片元素只存 imageId 引用（不携带 src）',
      !!imgEl1 && imgEl1.imageId === 'pic1' && imgEl1.src === undefined,
      imgEl1 ? JSON.stringify(imgEl1) : '未收到');
    closeWS(owner3);
    closeWS(guest3);
    closeWS(guest3b);

    /* 14. 创建者删除白板：通知所有成员 + 房间从内存清除 */
    let gone = false;
    guest2.ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.type === 'room_deleted') gone = true;
    });
    owner.ws.send(JSON.stringify({ type: 'delete_room' }));
    await waitFor(() => gone, 1500);
    check('成员收到 room_deleted', gone === true);
    const after = await openWS({ room: roomId, pwd: 'newpwd456' });
    const goneMsg = await waitFor(() => {
      for (let i = 0; i < after.msgs.length; i++) if (after.msgs[i].type === 'join_result') return after.msgs[i];
      return null;
    }, 1500);
    check('删除后房间不可再加入', !!goneMsg && goneMsg.ok === false, JSON.stringify(goneMsg));
    closeWS(after);

    closeWS(owner);
    closeWS(guest2);
    closeWS(guest);
    closeWS(roGuest);

    /* 16. 操作时间线语义（PS 式单条时间线）：连续撤销 → 重做 → 新操作截断未来 */
    const cr4 = await xhrPost('/api/create', { name: '时间线房', pwd: '' });
    const roomId4 = cr4.body.id, key4 = cr4.body.ownerKey;
    const owner4 = await openWS({ room: roomId4, key: key4, name: '房主4' });
    await waitFor(() => owner4.msgs.some((m) => m.type === 'welcome'), 2000);
    // 撤销/重做的操作人无需收到 state 校正，因此由访客 4 接收并验证服务器权威时间线
    const guest4 = await openWS({ room: roomId4, name: '访客4' });
    await waitFor(() => guest4.msgs.some((m) => m.type === 'welcome'), 2000);
    const lastState4 = () => {
      const arr = guest4.msgs;
      for (let i = arr.length - 1; i >= 0; i--) if (arr[i].type === 'state') return arr[i];
      return null;
    };
    // 添加矩形 + 直线 → 时间线 2 条，指针在末尾（不可重做）
    owner4.ws.send(JSON.stringify({ type: 'add', element: { id: 'a1', type: 'rect', x: 0, y: 0, w: 5, h: 5 } }));
    await waitFor(() => owner4.msgs.some((m) => m.type === 'history' && m.undoable), 1500);
    owner4.ws.send(JSON.stringify({ type: 'add', element: { id: 'a2', type: 'line', x1: 0, y1: 0, x2: 5, y2: 5 } }));
    await waitFor(() => owner4.msgs.some((m) => m.type === 'history' && m.undoable && m.redoable === false), 1500);
    // 连续撤销两次 → 空画布，指针 -1
    owner4.ws.send(JSON.stringify({ type: 'undo' }));
    await waitFor(() => lastState4() && lastState4().elements.length === 1, 1500);
    owner4.ws.send(JSON.stringify({ type: 'undo' }));
    const stUndoAll = await waitFor(() => { const s = lastState4(); return s && s.elements.length === 0 ? s : null; }, 1500);
    check('连续撤销回到初始（指针 -1，可重做）',
      !!stUndoAll && stUndoAll.historyIndex === -1 && stUndoAll.history.length === 2 && stUndoAll.redoable === true,
      stUndoAll ? `h=${stUndoAll.history.length} i=${stUndoAll.historyIndex}` : '未收到');
    // 重做一次 → 恢复矩形（指针 0）
    owner4.ws.send(JSON.stringify({ type: 'redo' }));
    const stRedo1 = await waitFor(() => { const s = lastState4(); return s && s.elements.length === 1 ? s : null; }, 1500);
    check('重做恢复矩形（指针 0，可撤销可重做）',
      !!stRedo1 && stRedo1.historyIndex === 0 && stRedo1.elements[0].id === 'a1' && stRedo1.redoable === true,
      stRedo1 ? `els=${stRedo1.elements && stRedo1.elements.map((e) => e.id).join(',')} i=${stRedo1.historyIndex}` : '未收到');
    // 撤销矩形后添加新元素（圆形）→ 未来分支（直线 a2）被截断
    owner4.ws.send(JSON.stringify({ type: 'undo' }));
    await waitFor(() => { const s = lastState4(); return s && s.elements.length === 0 && s.historyIndex === -1 ? true : null; }, 1500);
    owner4.ws.send(JSON.stringify({ type: 'add', element: { id: 'a3', type: 'circle', x: 0, y: 0, w: 3, h: 3 } }));
    await waitFor(() => owner4.msgs.some((m) => m.type === 'history' && m.undoable && m.redoable === false), 1500);
    owner4.ws.send(JSON.stringify({ type: 'undo' }));
    const stTrunc = await waitFor(() => { const s = lastState4(); return s && s.elements.length === 0 ? s : null; }, 1500);
    check('新操作截断未来（撤销到初始后新操作清空旧时间线，仅剩 a3）',
      !!stTrunc && stTrunc.history.length === 1 && stTrunc.historyIndex === -1 && stTrunc.history[0].el.id === 'a3',
      stTrunc ? `h=${stTrunc.history && stTrunc.history.map((o) => o.el && o.el.id).join(',')} i=${stTrunc.historyIndex}` : '未收到');
    // 重做 → 恢复的是新元素 a3（而非被截断的 a2）
    owner4.ws.send(JSON.stringify({ type: 'redo' }));
    const stRedo3 = await waitFor(() => { const s = lastState4(); return s && s.elements.length === 1 ? s : null; }, 1500);
    check('重做恢复的是新元素 a3（旧时间线已清空）',
      !!stRedo3 && stRedo3.elements[0].id === 'a3' && stRedo3.historyIndex === 0 && stRedo3.history.length === 1,
      stRedo3 ? `els=${stRedo3.elements && stRedo3.elements.map((e) => e.id).join(',')} i=${stRedo3.historyIndex}` : '未收到');
    closeWS(owner4);
    closeWS(guest4);

    /* 17. 房间设置「只读用户禁用激光笔」：开启后在线只读成员 laser 被忽略，新加入只读成员同样禁用 */
    const cr5 = await xhrPost('/api/create', { name: '激光策略房', pwd: '' });
    const roomId5 = cr5.body.id;
    const owner5 = await openWS({ room: roomId5, key: cr5.body.ownerKey, name: '房主5' });
    await waitFor(() => owner5.msgs.some((m) => m.type === 'welcome'), 2000);
    const ro1 = await openWS({ room: roomId5, name: 'ro1访客', ro: '1' });
    const w5 = await waitFor(() => ro1.msgs.find((m) => m.type === 'welcome'), 2000);
    check('默认只读用户可用激光笔（noLaser=false）', !!w5 && w5.self.readonly === true && w5.self.noLaser === false, JSON.stringify(w5 && w5.self));
    // 房主开启「只读用户禁用激光笔」→ 广播策略，在线只读成员 laser 被忽略
    owner5.ws.send(JSON.stringify({ type: 'room_settings', noLaserRO: true }));
    const gotPolicy = await waitFor(() => owner5.msgs.some((m) => m.type === 'room_laser_policy' && m.noLaserRO === true), 1500);
    check('房主开启只读禁用激光笔并广播策略', gotPolicy === true);
    const base5 = owner5.msgs.length;
    ro1.ws.send(JSON.stringify({ type: 'laser', x: 10, y: 20, active: true }));
    await sleep(400);
    const gotLaser5 = owner5.msgs.slice(base5).some((m) => m.type === 'laser');
    check('开启后在线只读成员激光消息被忽略（不广播）', gotLaser5 === false, `laser=${gotLaser5}`);
    // 新加入的只读成员：welcome 携带 noLaser=true
    const ro1b = await openWS({ room: roomId5, name: 'ro1访客b', ro: '1' });
    const w5b = await waitFor(() => ro1b.msgs.find((m) => m.type === 'welcome'), 2000);
    check('新加入只读成员 welcome 带 noLaser=true', !!w5b && w5b.self.noLaser === true, JSON.stringify(w5b && w5b.self));
    // 可编辑访客不受影响（激光正常）
    const guest5 = await openWS({ room: roomId5, name: '编辑访客' });
    await waitFor(() => guest5.msgs.some((m) => m.type === 'welcome'), 2000);
    const base5c = owner5.msgs.length;
    guest5.ws.send(JSON.stringify({ type: 'laser', x: 5, y: 6, active: true }));
    const gotLaser5c = await waitFor(() => owner5.msgs.slice(base5c).some((m) => m.type === 'laser'), 1500);
    check('可编辑访客激光消息正常广播', gotLaser5c === true);
    // 房主关闭策略 → 只读成员恢复激光
    owner5.ws.send(JSON.stringify({ type: 'room_settings', noLaserRO: false }));
    await waitFor(() => owner5.msgs.some((m) => m.type === 'room_laser_policy' && m.noLaserRO === false), 1500);
    const base5d = owner5.msgs.length;
    ro1b.ws.send(JSON.stringify({ type: 'laser', x: 7, y: 8, active: true }));
    const gotLaser5d = await waitFor(() => owner5.msgs.slice(base5d).some((m) => m.type === 'laser'), 1500);
    check('关闭后只读成员激光恢复', gotLaser5d === true);
    closeWS(owner5);
    closeWS(ro1);
    closeWS(ro1b);
    closeWS(guest5);

    /* 18. 房间设置「可编辑用户禁止编辑」：开启后可编辑访客降级为只读（改动被拒），新加入同样降级；关闭恢复 */
    const cr6 = await xhrPost('/api/create', { name: '禁编房', pwd: '' });
    const roomId6 = cr6.body.id;
    const owner6 = await openWS({ room: roomId6, key: cr6.body.ownerKey, name: '房主6' });
    await waitFor(() => owner6.msgs.some((m) => m.type === 'welcome'), 2000);
    const guest6 = await openWS({ room: roomId6, name: '可编辑6' });
    const w6 = await waitFor(() => guest6.msgs.find((m) => m.type === 'welcome'), 2000);
    check('默认可编辑访客（baseReadonly=false, readonly=false）', !!w6 && w6.self.readonly === false && w6.self.baseReadonly === false, JSON.stringify(w6 && w6.self));
    const base6 = owner6.msgs.length;
    guest6.ws.send(JSON.stringify({ type: 'add', element: { id: 'g6r', type: 'rect', x: 1, y: 2, w: 30, h: 20 } }));
    const gotAdd6 = await waitFor(() => owner6.msgs.slice(base6).some((m) => m.type === 'element_added' && m.element && m.element.id === 'g6r'), 1500);
    check('开启前可编辑访客添加图案正常广播', gotAdd6 === true);
    // 房主开启 forceRO → 广播策略，在线可编辑访客降级
    owner6.ws.send(JSON.stringify({ type: 'room_settings', forceRO: true }));
    await waitFor(() => owner6.msgs.some((m) => m.type === 'room_edit_policy' && m.forceRO === true), 1500);
    const base6b = owner6.msgs.length;
    guest6.ws.send(JSON.stringify({ type: 'add', element: { id: 'g6b', type: 'rect', x: 3, y: 4, w: 30, h: 20 } }));
    await sleep(400);
    const gotAdd6b = owner6.msgs.slice(base6b).some((m) => m.type === 'element_added' && m.element && m.element.id === 'g6b');
    check('开启后在线可编辑访客添加图案被拒（降级为只读）', gotAdd6b === false);
    // 新加入的可编辑访客同样降级
    const guest6b = await openWS({ room: roomId6, name: '可编辑6b' });
    const w6b = await waitFor(() => guest6b.msgs.find((m) => m.type === 'welcome'), 2000);
    check('开启后新加入可编辑访客 welcome 为只读', !!w6b && w6b.self.readonly === true && w6b.self.baseReadonly === false, JSON.stringify(w6b && w6b.self));
    // 关闭后恢复
    owner6.ws.send(JSON.stringify({ type: 'room_settings', forceRO: false }));
    await waitFor(() => owner6.msgs.some((m) => m.type === 'room_edit_policy' && m.forceRO === false), 1500);
    const base6c = owner6.msgs.length;
    guest6.ws.send(JSON.stringify({ type: 'add', element: { id: 'g6c', type: 'rect', x: 5, y: 6, w: 30, h: 20 } }));
    const gotAdd6c = await waitFor(() => owner6.msgs.slice(base6c).some((m) => m.type === 'element_added' && m.element && m.element.id === 'g6c'), 1500);
    check('关闭后可编辑访客恢复添加图案', gotAdd6c === true);
    // forceRO 关闭后服务端同步重算 noLaser：可编辑访客（即使 noLaserRO 开启）激光消息正常
    owner6.ws.send(JSON.stringify({ type: 'room_settings', noLaserRO: true }));
    await waitFor(() => owner6.msgs.some((m) => m.type === 'room_laser_policy' && m.noLaserRO === true), 1500);
    const base6d = owner6.msgs.length;
    guest6.ws.send(JSON.stringify({ type: 'laser', x: 9, y: 10, active: true }));
    const gotLaser6 = await waitFor(() => owner6.msgs.slice(base6d).some((m) => m.type === 'laser'), 1500);
    check('forceRO 关闭后可编辑访客激光正常（noLaser 仅对只读生效）', gotLaser6 === true);
    owner6.ws.send(JSON.stringify({ type: 'room_settings', noLaserRO: false }));
    await waitFor(() => owner6.msgs.some((m) => m.type === 'room_laser_policy' && m.noLaserRO === false), 1500);
    closeWS(owner6);
    closeWS(guest6);
    closeWS(guest6b);

  } catch (e) {
    failed++;
    results.push('FAIL  异常: ' + e.message);
  } finally {
    try { server.kill(); } catch (e) {}
  }

  console.log(results.join('\n'));
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
}

main();
