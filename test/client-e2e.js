'use strict';
/* ============================================================
 * 端到端测试：jsdom 模拟真实用户在画布上绘制/切工具/撤销，
 * 验证 客户端 -> 服务端 -> 其他客户端 的完整协同链路。
 * 仅覆盖主要功能：创建/加入、绘制与协同广播、选择编辑
 * （拖动/缩放/旋转/复位）、只读限制、激光笔、分享、退出、
 * 隐藏工具栏、管理员控制台、首页加入预检。
 * ============================================================ */
var http = require('http');
var fs = require('fs');
var path = require('path');
var spawn = require('child_process').spawn;
var JSDOM = require('jsdom').JSDOM;
var WebSocket = require('ws');

var PORT = 18124;
var BASE = 'http://127.0.0.1:' + PORT;
var passed = 0, failed = 0, results = [];

function check(name, cond, extra) {
  if (cond) { passed++; results.push('PASS  ' + name); }
  else { failed++; results.push('FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}
function waitServer() {
  return new Promise(function (resolve) {
    var t = 0;
    var timer = setInterval(function () {
      t += 200;
      var req = http.get(BASE + '/', function () { clearInterval(timer); resolve(true); });
      req.on('error', function () { if (t > 10000) { clearInterval(timer); resolve(false); } });
    }, 200);
  });
}
function xhrPost(p, data) {
  return new Promise(function (resolve) {
    var body = JSON.stringify(data);
    var req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      function (res) {
        var buf = '';
        res.on('data', function (c) { buf += c; });
        res.on('end', function () { try { resolve(JSON.parse(buf)); } catch (e) { resolve({}); } });
      });
    req.on('error', function () { resolve({}); });
    req.end(body);
  });
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function getJson(p) {
  return new Promise(function (resolve) {
    var req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' }, function (res) {
      var buf = '';
      res.on('data', function (c) { buf += c; });
      res.on('end', function () {
        var d = {};
        try { d = JSON.parse(buf); } catch (e) {}
        resolve({ status: res.statusCode, data: d });
      });
    });
    req.on('error', function () { resolve({ status: 0, data: {} }); });
    req.end();
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

function bootBoard(room, key, name, extraQuery, ctxLog) {
  return new Promise(function (resolve, reject) {
    var html = fs.readFileSync(path.join(__dirname, '..', 'public', 'board.html'), 'utf8');
    var js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'board.js'), 'utf8');
    var u = BASE + '/board.html?room=' + room + '&key=' + key + '&name=' + encodeURIComponent(name) + (extraQuery || '');
    var dom = new JSDOM(html, {
      url: u,
      runScripts: 'outside-only',
      pretendToBeVisual: true
    });
    var win = dom.window;
    var ctxTarget = { __paths: [], __p: null };
    var ctxStub = new Proxy(ctxTarget, {
      get: function (t, k) {
        if (k === 'measureText') return function () { return { width: 10 }; };
        if (k === '__paths') return t.__paths;
        if (k === 'beginPath') return function () { t.__p = []; };
        if (k === 'moveTo' || k === 'lineTo') return function (x, y) { if (t.__p) t.__p.push([x, y]); };
        if (k === 'stroke') return function () { if (t.__p) { t.__paths.push(t.__p); t.__p = null; } };
        return function () {};
      },
      set: function (t, k, v) {
        // 记录绘制时的颜色状态（激光笔轨迹断言用）
        if (ctxLog && (k === 'strokeStyle' || k === 'fillStyle')) ctxLog.push(k + '=' + v);
        return true;
      }
    });
    win.HTMLCanvasElement.prototype.getContext = function () { return ctxStub; };
    win.__ctx = ctxStub;
    win.WebSocket = WebSocket;
    var errs = [];
    win.addEventListener('error', function (e) { errs.push(String(e.error || e.message)); });
    try { win.eval(js); } catch (e) { errs.push(String(e && e.message)); }
    if (errs.length) { reject(new Error(errs.join('; '))); return; }
    resolve({ win: win, errs: errs, html: html });
  });
}

async function main() {
  var server = spawn('node', [path.join(__dirname, '..', 'server.js'),
    '--admin-user=e2eadmin', '--admin-pass=e2epass'], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'ignore', 'inherit']
  });
  var ok = await waitServer();
  if (!ok) { console.log('服务启动失败'); process.exit(1); }

  try {
    var cr = await xhrPost('/api/create', { name: 'E2E房', pwd: '' });
    var roomId = cr.id, key = cr.ownerKey;

    /* 观察端 B：原始 ws 客户端加入房间（与真实客户端一致：裸 /ws + hello） */
    var wsB = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
    var msgsB = [];
    wsB.on('message', function (d) { msgsB.push(JSON.parse(String(d))); });
    await waitFor(function () { return wsB.readyState === 1; }, 3000);
    wsB.send(JSON.stringify({ type: 'hello', room: roomId, name: '观察端B' }));
    await waitFor(function () { return msgsB.some(function (m) { return m.type === 'welcome'; }); }, 3000);

    /* 用户 A：jsdom 加载白板 */
    var A = await bootBoard(roomId, key, '用户A');
    var win = A.win;
    // 非只读用户（房主/访问者）：页面初始化（欢迎消息到达前）应立即显示「退出」按钮
    check('进入页面立即显示退出按钮（无需等待欢迎消息）',
      win.document.getElementById('btnExit').className.indexOf('hidden') < 0,
      'cls=' + win.document.getElementById('btnExit').className);
    await waitFor(function () { return win.document.getElementById('roomCode').textContent === roomId; }, 3000);
    check('jsdom 客户端加入房间并渲染房间号', win.document.getElementById('roomCode').textContent === roomId);

    /* 1. 画笔绘制：创建过程实时显示（mousedown 即广播）+ 完成提交完整轨迹 */
    var canvas = win.document.getElementById('board');
    function fire(el, type, x, y) {
      el.dispatchEvent(new win.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
    }
    fire(canvas, 'mousedown', 200, 200);
    fire(win, 'mousemove', 250, 220);
    fire(win, 'mousemove', 300, 240);
    fire(win, 'mousemove', 350, 260);
    fire(win, 'mouseup', 350, 260);

    var livePen = await waitFor(function () {
      for (var i = 0; i < msgsB.length; i++) {
        if (msgsB[i].type === 'element_added' && msgsB[i].element.type === 'pen') return msgsB[i].element;
      }
      return null;
    }, 3000);
    check('画笔创建过程实时显示（mousedown 即广播初始点）', !!livePen && livePen.points.length === 1,
      livePen ? 'points=' + livePen.points.length : '未收到');
    var addedPen = livePen;
    var penCommit = await waitFor(function () {
      for (var i = 0; i < msgsB.length; i++) {
        var m = msgsB[i];
        if (m.type === 'element_updated' && m.commit === true && m.patch && m.patch.points && m.patch.points.length >= 4) return m.patch.points;
      }
      return null;
    }, 3000);
    check('画笔完成提交完整轨迹（多点）', !!penCommit && penCommit.length >= 4, penCommit ? 'points=' + penCommit.length : '未收到');

    /* 2. 矩形绘制：创建过程实时显示 + 完成提交中心/尺寸正确 */
    var rectBtn = win.document.querySelector('[data-tool="rect"]');
    rectBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check('点击工具按钮后矩形工具激活', rectBtn.className.indexOf('active') >= 0);
    fire(canvas, 'mousedown', 100, 100);
    fire(win, 'mousemove', 200, 180);
    fire(win, 'mouseup', 200, 180);
    var liveRect = await waitFor(function () {
      for (var i = 0; i < msgsB.length; i++) {
        if (msgsB[i].type === 'element_added' && msgsB[i].element.type === 'rect') return msgsB[i].element;
      }
      return null;
    }, 3000);
    check('矩形创建过程实时显示（mousedown 即广播初始元素）', !!liveRect && liveRect.w === 0 && liveRect.h === 0,
      liveRect ? JSON.stringify({ w: liveRect.w, h: liveRect.h }) : '未收到');
    var rectCommit = await waitFor(function () {
      for (var i = 0; i < msgsB.length; i++) {
        var m = msgsB[i];
        if (m.type === 'element_updated' && m.commit === true && m.patch && m.patch.w === 100 && m.patch.h === 80) return m.patch;
      }
      return null;
    }, 3000);
    check('矩形绘制完成提交（中心/尺寸正确）',
      !!rectCommit && rectCommit.x === 150 && rectCommit.y === 140,
      rectCommit ? JSON.stringify(rectCommit) : '未收到');

    /* 3. 选中 + 拖动移动（update commit 广播） */
    var selBtn = win.document.querySelector('[data-tool="select"]');
    selBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    fire(canvas, 'mousedown', 150, 140);   // 命中矩形中心
    fire(win, 'mousemove', 190, 180);      // 移动 (40,40)
    fire(win, 'mouseup', 190, 180);
    var moved = await waitFor(function () {
      for (var i = 0; i < msgsB.length; i++) {
        if (msgsB[i].type === 'element_updated' && msgsB[i].commit === true && msgsB[i].patch.x === 190) return msgsB[i];
      }
      return null;
    }, 3000);
    check('选中图案拖动后 update 广播（commit 且位置正确）',
      !!moved && moved.patch.y === 180, moved ? JSON.stringify(moved.patch) : '未收到');

    /* 4. 撤销按钮 -> state 广播（回退最近一次移动） */
    win.document.getElementById('btnUndo').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    var undoState = await waitFor(function () {
      for (var i = 0; i < msgsB.length; i++) {
        if (msgsB[i].type === 'state' && msgsB[i].elements.length === 2) return msgsB[i];
      }
      return null;
    }, 3000);
    var rectAfterUndo = null;
    if (undoState) {
      for (var i = 0; i < undoState.elements.length; i++) {
        if (undoState.elements[i].type === 'rect') rectAfterUndo = undoState.elements[i];
      }
    }
    check('撤销按钮生效并广播（矩形回到原位 150,140）',
      !!rectAfterUndo && rectAfterUndo.x === 150 && rectAfterUndo.y === 140 && undoState.redoable === true,
      rectAfterUndo ? JSON.stringify({ x: rectAfterUndo.x, y: rectAfterUndo.y }) : '未收到');

    /* 5. 只读访客加入验证只读 UI：进入页面立即显示只读界面（URL 带 ro=1），
     * 而非先加载全部功能再隐藏（欢迎消息到达前即已应用） */
    var C = await bootBoard(roomId, '', '只读访客', '&ro=1');
    var winC = C.win;
    await waitFor(function () { return winC.document.getElementById('roBadge').className.indexOf('hidden') < 0; }, 3000);
    check('只读用户加载后立即显示只读界面（编辑/属性/撤销/清空/复制/删除全隐藏，只读徽标与退出按钮显示）',
      winC.document.querySelector('[data-tool="pen"]').className.indexOf('hidden') >= 0 &&
      winC.document.querySelector('[data-tool="select"]').className.indexOf('hidden') >= 0 &&
      winC.document.getElementById('btnPanelTop').className.indexOf('hidden') >= 0 &&
      winC.document.getElementById('panel').className.indexOf('hidden') >= 0 &&
      winC.document.getElementById('btnUndo').className.indexOf('hidden') >= 0 &&
      winC.document.getElementById('btnClearTop').className.indexOf('hidden') >= 0 &&
      winC.document.getElementById('btnCopy').className.indexOf('hidden') >= 0 &&
      winC.document.getElementById('btnDelete').className.indexOf('hidden') >= 0 &&
      winC.document.getElementById('roBadge').className.indexOf('hidden') < 0 &&
      winC.document.getElementById('btnExit').className.indexOf('hidden') < 0,
      'pen=' + winC.document.querySelector('[data-tool="pen"]').className +
      ' undo=' + winC.document.getElementById('btnUndo').className +
      ' ro=' + winC.document.getElementById('roBadge').className);
    check('只读访客顶部栏无多余分割线（全部隐藏）',
      winC.document.querySelectorAll('#topbar .sep:not(.hidden)').length === 0,
      '可见分隔线数=' + winC.document.querySelectorAll('#topbar .sep:not(.hidden)').length);

    /* 6. 只读访客尝试绘制不产生广播 */
    var before = msgsB.length;
    var canvasC = winC.document.getElementById('board');
    function fireC(el, type, x, y) {
      el.dispatchEvent(new winC.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
    }
    fireC(canvasC, 'mousedown', 50, 50);
    fireC(winC, 'mousemove', 80, 80);
    fireC(winC, 'mouseup', 80, 80);
    await sleep(500);
    check('只读访客的绘制未产生任何广播', msgsB.length === before, '新消息数=' + (msgsB.length - before));

    /* 7. 浏览器内无运行时错误 */
    check('jsdom 会话无运行时错误', A.errs.length === 0 && C.errs.length === 0, (A.errs.concat(C.errs)).join(';'));

    /* 8. 文本工具：点击画布就地输入（无弹窗），blur 提交并广播 */
    var textBtn = win.document.querySelector('[data-tool="text"]');
    textBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    fire(canvas, 'mousedown', 300, 300);
    check('文本工具点击画布就地显示输入框（无弹窗）',
      !win.document.getElementById('textModal') &&
      win.document.getElementById('inlineText').className.indexOf('hidden') < 0,
      'inlineText=' + win.document.getElementById('inlineText').className);
    win.document.getElementById('inlineText').value = '你好白板';
    win.document.getElementById('inlineText').dispatchEvent(new win.MouseEvent('blur', { bubbles: false }));
    var addedText = await waitFor(function () {
      for (var i = 0; i < msgsB.length; i++) {
        if (msgsB[i].type === 'element_added' && msgsB[i].element.type === 'text') return msgsB[i].element;
      }
      return null;
    }, 3000);
    check('文本元素被广播', !!addedText && addedText.text === '你好白板', addedText ? addedText.text : '未收到');
    check('文本位置 = 输入框内文字起点（左上角对齐，默认字号 20）',
      !!addedText && addedText.x === 306 && addedText.y === 305 && addedText.fontSize === 20,
      addedText ? ('x=' + addedText.x + ' y=' + addedText.y + ' fs=' + addedText.fontSize) : '未收到');
    check('内联输入框提交后隐藏', win.document.getElementById('inlineText').className.indexOf('hidden') >= 0);

    /* 9. 选中画笔图案：包围盒正常且广播选中状态 */
    var selBtn2 = win.document.querySelector('[data-tool="select"]');
    selBtn2.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    fire(canvas, 'mousedown', 200, 200);   // 命中画笔起点
    fire(win, 'mouseup', 200, 200);
    check('画笔图案可被选中（包围盒正常）',
      win.document.getElementById('selInfo').textContent.indexOf('画笔') >= 0,
      win.document.getElementById('selInfo').textContent);
    var gotSelB = await waitFor(function () {
      for (var i = 0; i < msgsB.length; i++) {
        if (msgsB[i].type === 'selection' && msgsB[i].ids && msgsB[i].ids.indexOf(addedPen.id) >= 0) return true;
      }
      return null;
    }, 3000);
    check('选中状态广播给其他成员', gotSelB === true);

    /* 10. RGB 滑块自定义颜色生效 */
    var rgbR = win.document.getElementById('rgbR');
    rgbR.value = 255;
    rgbR.dispatchEvent(new win.MouseEvent('input', { bubbles: true }));
    check('RGB 滑块调色生效（红色通道）',
      win.document.getElementById('rgbHexInput').value === '#FF0000',
      win.document.getElementById('rgbHexInput').value);

    /* 10b. 属性面板实时调整选中图案（透明度/填充色/透明/hex 输入） */
    var selBtnA = win.document.querySelector('[data-tool="select"]');
    selBtnA.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    fire(canvas, 'mousedown', 150, 140);   // 选中矩形（中心）
    fire(win, 'mouseup', 150, 140);
    await sleep(80);
    check('选中矩形后属性面板同步显示元素属性', win.document.getElementById('opacityRange').value === '100',
      'opacity=' + win.document.getElementById('opacityRange').value);
    var opBase = msgsB.length;
    win.document.getElementById('opacityRange').value = 50;
    win.document.getElementById('opacityRange').dispatchEvent(new win.MouseEvent('input', { bubbles: true }));
    win.document.getElementById('opacityRange').dispatchEvent(new win.MouseEvent('change', { bubbles: true }));
    var opUpdated = await waitFor(function () {
      for (var i = opBase; i < msgsB.length; i++) {
        var m = msgsB[i];
        if (m.type === 'element_updated' && m.id === liveRect.id && m.commit && m.patch.opacity === 0.5) return m;
      }
      return null;
    }, 3000);
    check('透明度实时调整广播（commit）', !!opUpdated);
    // 常用色第一行 = 黑 灰 浅灰 红 蓝 绿，第二行 = 白 棕 橙 黄 紫 粉（jsdom 中 style.background 解析为 rgb 形式）
    var palette6 = win.document.getElementById('palette').children;
    check('常用色第一行 = 黑 灰 浅灰 红 蓝 绿，第二行 = 白 棕 橙 黄 紫 粉',
      palette6.length >= 12 &&
      (palette6[0].style.background || '').indexOf('0, 0, 0') >= 0 &&
      (palette6[1].style.background || '').indexOf('97, 97, 97') >= 0 &&
      (palette6[2].style.background || '').indexOf('189, 189, 189') >= 0 &&
      (palette6[3].style.background || '').indexOf('229, 57, 53') >= 0 &&
      (palette6[4].style.background || '').indexOf('30, 136, 229') >= 0 &&
      (palette6[5].style.background || '').indexOf('67, 160, 71') >= 0 &&
      (palette6[6].style.background || '').indexOf('255, 255, 255') >= 0 &&
      (palette6[7].style.background || '').indexOf('109, 76, 65') >= 0 &&
      (palette6[8].style.background || '').indexOf('251, 140, 0') >= 0 &&
      (palette6[9].style.background || '').indexOf('253, 216, 53') >= 0 &&
      (palette6[10].style.background || '').indexOf('142, 36, 170') >= 0 &&
      (palette6[11].style.background || '').indexOf('240, 98, 146') >= 0,
      'swatches=' + [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(function (i) { return palette6[i].style.background + '/' + palette6[i].className; }).join(', '));
    // 选中色块应有选中框（active 类，当前描边色为黑色）
    check('选中色块带选中框（active）',
      palette6[0].className.indexOf('active') >= 0,
      palette6[0].className);
    // 切「填充」目标，点红色 → 矩形填充变红（描边保持黑）
    var fillBase = msgsB.length;
    win.document.getElementById('btnColorFill').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check('填充目标切换高亮', win.document.getElementById('btnColorFill').className.indexOf('active') >= 0);
    var redSw = null;
    for (var si = 0; si < palette6.length; si++) {
      if ((palette6[si].style.background || '').indexOf('229, 57, 53') >= 0) redSw = palette6[si];
    }
    redSw.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    var fillUpdated = await waitFor(function () {
      for (var i = fillBase; i < msgsB.length; i++) {
        var m = msgsB[i];
        if (m.type === 'element_updated' && m.id === liveRect.id && m.commit && m.patch.fill === '#E53935') return m;
      }
      return null;
    }, 3000);
    check('矩形填充色实时调整（填充与描边可不同色）', !!fillUpdated,
      fillUpdated ? JSON.stringify(fillUpdated.patch) : '未收到');
    // 输入框不再接受 transparent（透明填充已移除），应提示格式错误
    win.document.getElementById('rgbHexInput').value = 'transparent';
    win.document.getElementById('rgbHexInput').dispatchEvent(new win.MouseEvent('change', { bubbles: true }));
    check('输入框不接受 transparent（提示格式错误）',
      win.document.getElementById('statusLine').textContent.indexOf('颜色格式') >= 0 &&
      win.document.getElementById('rgbHexInput').value === '#E53935',
      win.document.getElementById('statusLine').textContent + ' / hex=' + win.document.getElementById('rgbHexInput').value);
    // 自定义颜色手动输入 hex
    win.document.getElementById('rgbHexInput').value = '#00FF00';
    win.document.getElementById('rgbHexInput').dispatchEvent(new win.MouseEvent('change', { bubbles: true }));
    check('自定义颜色手动输入生效（#00FF00）',
      win.document.getElementById('rgbHexInput').value === '#00FF00' &&
      win.document.getElementById('rgbG').value === '255' &&
      win.document.getElementById('rgbB').value === '0',
      win.document.getElementById('rgbHexInput').value);
    win.document.getElementById('rgbHexInput').value = 'zzz';
    win.document.getElementById('rgbHexInput').dispatchEvent(new win.MouseEvent('change', { bubbles: true }));
    check('非法 hex 输入提示格式错误',
      win.document.getElementById('statusLine').textContent.indexOf('颜色格式') >= 0,
      win.document.getElementById('statusLine').textContent);
    // 切回描边目标（后续绘制用描边色）
    win.document.getElementById('btnColorStroke').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check('切回描边目标生效', win.document.getElementById('btnColorStroke').className.indexOf('active') >= 0);

    /* 10c2. 填充目标残留修复：切「填充」选色后，选中其它图案透明度不归零、颜色目标回描边 */
    win.document.getElementById('btnColorFill').dispatchEvent(new win.MouseEvent('click', { bubbles: true })); // 填充目标
    win.document.getElementById('rgbHexInput').value = '#FF00FF';
    win.document.getElementById('rgbHexInput').dispatchEvent(new win.MouseEvent('change', { bubbles: true })); // fillColor 变粉
    var selBtnLine = win.document.querySelector('[data-tool="select"]');
    selBtnLine.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    fire(canvas, 'mousedown', 250, 220);   // 画笔轨迹中段（远离矩形编辑框，避免命中矩形拖动）
    fire(win, 'mouseup', 250, 220);
    check('选中其它图案后透明度不归零、颜色目标回描边',
      win.document.getElementById('opacityVal').textContent !== '0%' &&
      win.document.getElementById('btnColorStroke').className.indexOf('active') >= 0 &&
      win.document.getElementById('rgbHexInput').value === '#FF0000',
      'op=' + win.document.getElementById('opacityVal').textContent +
      ' strokeActive=' + win.document.getElementById('btnColorStroke').className +
      ' hex=' + win.document.getElementById('rgbHexInput').value);
    // 未选中（切画笔工具）点色板选色 → 新建图案使用该颜色（修复"新建图案颜色无法修改"）
    win.document.querySelector('[data-tool="pen"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    palette6[3].dispatchEvent(new win.MouseEvent('click', { bubbles: true })); // 红（未选中 → 描边目标）
    var penBase = msgsB.length;
    fire(canvas, 'mousedown', 400, 100);
    fire(win, 'mousemove', 460, 160);
    fire(win, 'mouseup', 460, 160);
    var penNew = await waitFor(function () {
      for (var i = penBase; i < msgsB.length; i++) {
        if (msgsB[i].type === 'element_added' && msgsB[i].element.type === 'pen') return msgsB[i].element;
      }
      return null;
    }, 3000);
    check('未选中时选色后新建图案使用该颜色（描边红）',
      !!penNew && penNew.stroke === '#E53935',
      penNew ? penNew.stroke : '未收到');

    /* 10c. 面板控件显隐：矩形显示线宽与描边/填充、隐藏字号；文本只字号；未选中全部恢复 */
    var selBtnR = win.document.querySelector('[data-tool="select"]');
    selBtnR.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    fire(canvas, 'mousedown', 150, 140);   // 选中矩形
    fire(win, 'mouseup', 150, 140);
    check('选中矩形：显示线宽、隐藏字号、显示描边/填充',
      win.document.getElementById('widthCtrl').className.indexOf('hidden') < 0 &&
      win.document.getElementById('fontCtrl').className.indexOf('hidden') >= 0 &&
      win.document.getElementById('colorTargetCtrls').style.display !== 'none',
      'width=' + win.document.getElementById('widthCtrl').className + ' font=' + win.document.getElementById('fontCtrl').className + ' target=' + win.document.getElementById('colorTargetCtrls').style.display);
    // 切到画笔工具（未选中）→ 线宽/字号/描边填充全部恢复显示
    win.document.querySelector('[data-tool="pen"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check('切到其它工具（未选中）：线宽/字号/描边填充恢复显示',
      win.document.getElementById('widthCtrl').className.indexOf('hidden') < 0 &&
      win.document.getElementById('fontCtrl').className.indexOf('hidden') < 0 &&
      win.document.getElementById('colorTargetCtrls').style.display !== 'none',
      'width=' + win.document.getElementById('widthCtrl').className + ' font=' + win.document.getElementById('fontCtrl').className + ' target=' + win.document.getElementById('colorTargetCtrls').style.display);
    // 选中文本：只显示字号，隐藏线宽与描边/填充
    var selBtnT = win.document.querySelector('[data-tool="select"]');
    selBtnT.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    fire(canvas, 'mousedown', 312, 318);   // 文本「你好白板」中心（左上角 306,305 + 半宽高）
    fire(win, 'mouseup', 312, 318);
    check('选中文本：只显示字号、隐藏线宽与描边/填充',
      win.document.getElementById('selInfo').textContent.indexOf('文本') >= 0 &&
      win.document.getElementById('fontCtrl').className.indexOf('hidden') < 0 &&
      win.document.getElementById('widthCtrl').className.indexOf('hidden') >= 0 &&
      win.document.getElementById('colorTargetCtrls').style.display === 'none',
      'sel=' + win.document.getElementById('selInfo').textContent +
      ' font=' + win.document.getElementById('fontCtrl').className +
      ' width=' + win.document.getElementById('widthCtrl').className +
      ' target=' + win.document.getElementById('colorTargetCtrls').style.display);

    /* 10c3. 滑块已滑过部分渐变着色 + 文本字号调整同步包围盒 + 缩放字号越界完全定格 */
    check('滑块已滑过部分渐变着色（paintRange 生效）',
      win.document.getElementById('opacityRange').style.backgroundImage.indexOf('linear-gradient') >= 0 &&
      win.document.getElementById('fontRange').style.backgroundImage.indexOf('linear-gradient') >= 0 &&
      win.document.getElementById('rgbR').style.backgroundImage.indexOf('linear-gradient') >= 0,
      win.document.getElementById('opacityRange').style.backgroundImage);
    check('切换选中后滑块渐变按当前值重绘（含 100%）',
      win.document.getElementById('opacityRange').style.backgroundImage.indexOf('100%') >= 0,
      win.document.getElementById('opacityRange').style.backgroundImage);
    var fsBase = msgsB.length;
    var fontR = win.document.getElementById('fontRange');
    fontR.value = 60;
    fontR.dispatchEvent(new win.MouseEvent('input', { bubbles: true }));
    fontR.dispatchEvent(new win.MouseEvent('change', { bubbles: true }));
    var fsUpdated = await waitFor(function () {
      for (var i = fsBase; i < msgsB.length; i++) {
        var m = msgsB[i];
        if (m.type === 'element_updated' && m.id === addedText.id && m.commit && m.patch.fontSize === 60) return m;
      }
      return null;
    }, 3000);
    check('文本字号调整同步重算包围盒（选择框随字号变化）',
      !!fsUpdated && fsUpdated.patch.w === 12 && fsUpdated.patch.h === 78,
      fsUpdated ? JSON.stringify(fsUpdated.patch) : '未收到');
    // 改回字号 20（避免影响后续全局字号）
    fontR.value = 20;
    fontR.dispatchEvent(new win.MouseEvent('input', { bubbles: true }));
    fontR.dispatchEvent(new win.MouseEvent('change', { bubbles: true }));
    await sleep(150);
    // 文本缩放：拖右下角手柄到极远 → 字号 400；再拖更远 → 越界完全定格（无新广播）
    // 文本 bbox (306,305)-(318,331)，中心 (312,318)，外扩10 手柄右下 (328,341)，锚 (296,295)
    fire(canvas, 'mousedown', 328, 341);
    fire(win, 'mousemove', 2000, 2000);
    fire(win, 'mouseup', 2000, 2000);
    var z1 = await waitFor(function () {
      for (var i = 0; i < msgsB.length; i++) {
        var m = msgsB[i];
        if (m.type === 'element_updated' && m.id === addedText.id && m.commit && m.patch.fontSize === 400) return m;
      }
      return null;
    }, 3000);
    check('文本缩放到字号上限 400（整体等比）', !!z1 && z1.patch.w === 240 && z1.patch.h === 520,
      z1 ? JSON.stringify(z1.patch) : '未收到');
    // 第二次拖更远（缩放后右下手柄 (746,1025)）：字号越界 → 完全定格，不产生新广播
    var zBase2 = msgsB.length;
    fire(canvas, 'mousedown', 746, 1025);
    fire(win, 'mousemove', 3000, 3000);
    fire(win, 'mouseup', 3000, 3000);
    await sleep(500);
    var zExtra = msgsB.slice(zBase2).filter(function (m) { return m.type === 'element_updated' && m.id === addedText.id; });
    check('字号越界后继续缩放完全定格（无新广播）', zExtra.length === 0, 'extra=' + zExtra.length);

    /* 10d. 油漆桶使用面板当前颜色（选色后直接填充） */
    win.document.getElementById('rgbHexInput').value = '#00FF00';
    win.document.getElementById('rgbHexInput').dispatchEvent(new win.MouseEvent('change', { bubbles: true }));
    var bucketBase = msgsB.length;
    win.document.querySelector('[data-tool="bucket"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    fire(canvas, 'mousedown', 150, 140);   // 命中矩形
    fire(win, 'mouseup', 150, 140);
    var bucketUpdated = await waitFor(function () {
      for (var i = bucketBase; i < msgsB.length; i++) {
        var m = msgsB[i];
        if (m.type === 'element_updated' && m.id === liveRect.id && m.commit && m.patch.fill === '#00ff00') return m;
      }
      return null;
    }, 3000);
    check('油漆桶使用面板当前颜色填充（fill=#00ff00）', !!bucketUpdated,
      bucketUpdated ? JSON.stringify(bucketUpdated.patch) : '未收到');
    check('RGB 滑块渐变跟随当前颜色（syncRgbUI 重绘）',
      win.document.getElementById('rgbG').style.backgroundImage.indexOf('100%') >= 0,
      win.document.getElementById('rgbG').style.backgroundImage);

    /* 11. 右侧面板可折叠：收起后隐藏、展开入口在顶部栏「属性」按钮 */
    var panelA = win.document.getElementById('panel');
    win.document.getElementById('btnPanelToggle').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check('面板可折叠', panelA.className.indexOf('collapsed') >= 0);
    win.document.getElementById('btnPanelTop').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check('顶部栏「属性」按钮可展开面板', panelA.className.indexOf('collapsed') < 0);

    /* 12. 图片工具：打开相册弹窗 */
    var imgBtn = win.document.querySelector('[data-tool="image"]');
    imgBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check('图片弹窗打开', win.document.getElementById('imgModal').className.indexOf('hidden') < 0);
    win.document.getElementById('btnCloseImg').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

    /* 13. 分享弹窗：默认可编辑链接，勾选只读后带 ro=1；导出配置所有人可用、导入仅房主 */
    win.document.getElementById('btnShare').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    var urlEdit = win.document.getElementById('shareUrlInput').value;
    win.document.getElementById('shareModeRO').checked = true;
    win.document.getElementById('shareModeRO').dispatchEvent(new win.MouseEvent('change', { bubbles: true }));
    var urlRO = win.document.getElementById('shareUrlInput').value;
    check('分享链接默认可编辑（无 ro=1）', urlEdit.indexOf('ro=1') < 0, urlEdit);
    check('勾选只读后分享链接带 ro=1', urlRO.indexOf('ro=1') > 0, urlRO);
    check('分享弹窗含导出配置按钮（所有成员可用）', !!win.document.getElementById('btnExportCfg'));
    check('房主可见导入配置按钮', win.document.getElementById('btnImportCfg').className.indexOf('hidden') < 0,
      'cls=' + win.document.getElementById('btnImportCfg').className);
    // 点击导出配置：mock URL.createObjectURL 后走 Blob 下载分支（jsdom 无原生实现）
    win.URL.createObjectURL = function () { return 'blob:mock'; };
    win.URL.revokeObjectURL = function () {};
    win.document.getElementById('btnExportCfg').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check('导出配置按钮可点击且提示已导出',
      win.document.getElementById('statusLine').textContent.indexOf('已导出白板配置') >= 0,
      win.document.getElementById('statusLine').textContent);
    win.document.getElementById('btnCloseShare').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));

    /* 14. 旋转：拖拽旋转更新 rotation，单击旋转圈复位归 0 */
    var selBtn3 = win.document.querySelector('[data-tool="select"]');
    selBtn3.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    fire(canvas, 'mousedown', 150, 140);   // 选中矩形（中心）
    fire(win, 'mouseup', 150, 140);
    fire(canvas, 'mousedown', 150, 66);    // 旋转手柄（中心正上方）
    fire(win, 'mousemove', 220, 66);
    fire(win, 'mouseup', 220, 66);
    var rotated = await waitFor(function () {
      for (var i = 0; i < msgsB.length; i++) {
        var m = msgsB[i];
        if (m.type === 'element_updated' && m.id === liveRect.id && m.commit &&
            typeof m.patch.rotation === 'number' && Math.abs(m.patch.rotation - 43.4) < 4) return m;
      }
      return null;
    }, 3000);
    check('拖拽旋转更新 rotation（≈43.4°）', !!rotated, rotated ? rotated.patch.rotation : '未收到');
    fire(canvas, 'mousedown', 201, 86);    // 旋转后手柄位置
    fire(win, 'mouseup', 201, 86);
    var resetRot = await waitFor(function () {
      for (var i = 0; i < msgsB.length; i++) {
        var m = msgsB[i];
        if (m.type === 'element_updated' && m.id === liveRect.id && m.commit &&
            m.patch.rotation === 0) return m;
      }
      return null;
    }, 3000);
    check('单击旋转圈重置 rotation 为 0', !!resetRot);

    /* 15. 房间设置弹窗：改名（在线访问者同步更新）+ 修改 / 取消访问密码（访问者被强制退出） */
    var RO = await bootBoard(roomId, '', '改名观察');
    var winRO = RO.win;
    await waitFor(function () { return winRO.document.getElementById('roomCode').textContent === roomId; }, 3000);
    var kickedAlerts = [];
    winRO.alert = function (m) { kickedAlerts.push(m); };
    // 15a 改名：本次不动密码
    win.document.getElementById('roomName').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check('点击房间名打开房间设置弹窗', win.document.getElementById('roomModal').className.indexOf('hidden') < 0);
    win.document.getElementById('roomNameInput').value = '第三轮新名字';
    win.document.getElementById('btnRoomOk').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    var renamedMsg = await waitFor(function () {
      for (var i = 0; i < msgsB.length; i++) {
        if (msgsB[i].type === 'room_renamed' && msgsB[i].name === '第三轮新名字') return msgsB[i];
      }
      return null;
    }, 3000);
    check('创建者重命名广播成功', !!renamedMsg);
    check('房主界面房间名已更新', win.document.getElementById('roomName').textContent === '第三轮新名字' &&
      win.document.title.indexOf('第三轮新名字') >= 0,
      win.document.getElementById('roomName').textContent + ' / ' + win.document.title);
    check('在线访问者界面房间名同步更新',
      winRO.document.getElementById('roomName').textContent === '第三轮新名字' &&
      winRO.document.title.indexOf('第三轮新名字') >= 0,
      winRO.document.getElementById('roomName').textContent + ' / ' + winRO.document.title);
    // 15b 修改访问密码：广播 + 旧密码失效 / 新密码生效 + 访问者被强制退出
    win.document.getElementById('roomName').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    win.document.getElementById('roomPwdInput').value = 'newpwd789';
    win.document.getElementById('btnRoomOk').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    var pwdMsg = await waitFor(function () {
      for (var i = 0; i < msgsB.length; i++) {
        if (msgsB[i].type === 'room_password_changed' && msgsB[i].pwd === 'newpwd789') return msgsB[i];
      }
      return null;
    }, 3000);
    check('房主修改访问密码广播成功', !!pwdMsg, pwdMsg ? JSON.stringify(pwdMsg) : '未收到');
    var pwdNone2 = await getJson('/api/room?id=' + roomId);
    var pwdNew2 = await getJson('/api/room?id=' + roomId + '&pwd=newpwd789');
    check('改密后未输密码预检 pwdOk=false', pwdNone2.status === 200 && pwdNone2.data.pwdOk === false,
      'pwdOk=' + pwdNone2.data.pwdOk);
    check('改密后新密码预检 pwdOk=true', pwdNew2.status === 200 && pwdNew2.data.pwdOk === true,
      'pwdOk=' + pwdNew2.data.pwdOk);
    var kicked = await waitFor(function () {
      for (var i = 0; i < kickedAlerts.length; i++) {
        if (String(kickedAlerts[i]).indexOf('密码') >= 0) return kickedAlerts[i];
      }
      return null;
    }, 3000);
    check('改密后在线访问者被强制退出并提示重新输入密码', !!kicked, 'alerts=' + kickedAlerts.join('|'));
    // 改密会强制断开所有非房主（观察端 wsB 也被踢）：重建观察端（用新密码加入），供后续测试使用
    try { wsB.close(); } catch (e) {}
    wsB = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
    msgsB = [];
    wsB.on('message', function (d) { msgsB.push(JSON.parse(String(d))); });
    await waitFor(function () { return wsB.readyState === 1; }, 3000);
    wsB.send(JSON.stringify({ type: 'hello', room: roomId, pwd: 'newpwd789', name: '观察端B2' }));
    await waitFor(function () { return msgsB.some(function (m) { return m.type === 'welcome'; }); }, 3000);
    // 15c 改回空密码（恢复无密码房间，供后续测试继续加入），顺便验证可取消密码
    win.document.getElementById('roomName').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    win.document.getElementById('roomPwdInput').value = '';
    win.document.getElementById('btnRoomOk').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    var pwdCleared = await waitFor(function () {
      for (var i = 0; i < msgsB.length; i++) {
        if (msgsB[i].type === 'room_password_changed' && msgsB[i].pwd === '') return msgsB[i];
      }
      return null;
    }, 3000);
    check('房主可取消访问密码（清空后广播）', !!pwdCleared);
    var pwdNone3 = await getJson('/api/room?id=' + roomId);
    check('取消密码后预检 pwdOk=true', pwdNone3.status === 200 && pwdNone3.data.pwdOk === true,
      'pwdOk=' + pwdNone3.data.pwdOk);

    /* 16. 直线缩放：被拖角点跟随鼠标（锚角固定、方向保持）；单击旋转圈复位恢复原始长度 */
    var lineBtn = win.document.querySelector('[data-tool="line"]');
    lineBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    fire(canvas, 'mousedown', 100, 620);
    fire(win, 'mousemove', 300, 620);
    fire(win, 'mouseup', 300, 620);
    var lineEl = await waitFor(function () {
      for (var i = 0; i < msgsB.length; i++) {
        if (msgsB[i].type === 'element_added' && msgsB[i].element.type === 'line' && msgsB[i].element.y1 === 620) return msgsB[i].element;
      }
      return null;
    }, 3000);
    var lineCommit = await waitFor(function () {
      for (var i = 0; i < msgsB.length; i++) {
        var m = msgsB[i];
        if (m.type === 'element_updated' && m.commit && m.id === (lineEl ? lineEl.id : '') &&
            m.patch && m.patch.x2 === 300) return m.patch;
      }
      return null;
    }, 3000);
    check('直线已创建（供缩放/复位测试）', !!lineEl && !!lineCommit && lineCommit.x1 === 100,
      lineCommit ? JSON.stringify(lineCommit) : '未收到');
    var selBtn4 = win.document.querySelector('[data-tool="select"]');
    selBtn4.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    fire(canvas, 'mousedown', 200, 620);
    fire(win, 'mouseup', 200, 620);
    await sleep(80);
    // 水平线：中心(200,620) hw=110 hh=10.5 → 被拖角点 (310,609.5)，锚角=对角 (90,630.5)
    // 统一锚点缩放：startDist=dist(角点,锚角)=221，拖到 (390,579.5) → f≈1.37694
    //   左端 (100,620)→(103.77,616.04)，右端 (300,620)→(379.16,616.04)（方向保持水平）
    var lineBase = msgsB.length;
    fire(canvas, 'mousedown', 310, 609.5);
    fire(win, 'mousemove', 350, 594.5);
    fire(win, 'mousemove', 390, 579.5);
    fire(win, 'mouseup', 390, 579.5);
    var lineScaled = await waitFor(function () {
      for (var i = lineBase; i < msgsB.length; i++) {
        var m = msgsB[i];
        if (m.type === 'element_updated' && m.id === lineEl.id && m.commit &&
            Math.abs(m.patch.x1 - 103.77) < 0.5 && Math.abs(m.patch.y1 - 616.04) < 0.5 &&
            Math.abs(m.patch.x2 - 379.16) < 0.5 && Math.abs(m.patch.y2 - 616.04) < 0.5) return m;
      }
      return null;
    }, 3000);
    check('直线缩放：被拖角点跟随鼠标（锚角固定、方向保持）', !!lineScaled, lineScaled ? JSON.stringify(lineScaled.patch) : '未收到');
    // 复位：缩放后直线 (103.77,616.04)→(379.16,616.04)，中心(241.46,616.04) hw≈147.69 hh=10.5
    //   旋转手柄位于 (241.46, 616.04-10.5-24)=(241.46,581.54)
    lineBase = msgsB.length;
    fire(canvas, 'mousedown', 241.46, 581.54);
    fire(win, 'mouseup', 241.46, 581.54);
    var lineReset = await waitFor(function () {
      for (var i = lineBase; i < msgsB.length; i++) {
        var m = msgsB[i];
        if (m.type === 'element_updated' && m.id === lineEl.id && m.commit &&
            Math.abs(m.patch.x1 - 141.46) < 0.5 && Math.abs(m.patch.x2 - 341.46) < 0.5 &&
            Math.abs(m.patch.y1 - 616.04) < 0.5 && Math.abs(m.patch.y2 - 616.04) < 0.5 &&
            Math.abs((m.patch.x2 - m.patch.x1) - 200) < 1) return m;
      }
      return null;
    }, 3000);
    check('直线复位：恢复原始长度且中心/方向不变（坐标不跳回）', !!lineReset, lineReset ? JSON.stringify(lineReset.patch) : '未收到');

    /* 17. 激光笔：松开后轨迹渐隐保留、再次点击立即清除；颜色与用户标记一致且房主为红 */
    var ctxLog = [];
    var D = await bootBoard(cr.id, key, '激光用户', '', ctxLog);
    var winD = D.win;
    await waitFor(function () { return winD.document.getElementById('roomCode').textContent === cr.id; }, 3000);
    await waitFor(function () { return winD.document.getElementById('usersBox').innerHTML.indexOf('房主') >= 0; }, 3000);
    check('房主用户标记颜色为红色', winD.document.getElementById('usersBox').innerHTML.indexOf('background:#e53935') >= 0);
    var canvasD = winD.document.getElementById('board');
    function fireD(el, type, x, y) {
      el.dispatchEvent(new winD.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
    }
    winD.document.querySelector('[data-tool="laser"]').dispatchEvent(new winD.MouseEvent('click', { bubbles: true }));
    // 激光消息节流 30ms：两次移动之间需间隔，否则会被节流丢弃（真实浏览器事件频率足够）
    fireD(canvasD, 'mousedown', 100, 100);
    await sleep(50);
    fireD(winD, 'mousemove', 160, 100);
    await sleep(50);
    fireD(winD, 'mousemove', 220, 100);
    await sleep(50);
    fireD(winD, 'mouseup', 220, 100);   // 松开
    await sleep(300);
    var trailAfterRelease = ctxLog.filter(function (s) { return s.indexOf('strokeStyle=rgba(229,57,53,') === 0; }).length;
    check('激光笔松开后轨迹未立即消失（仍渲染渐隐线）', trailAfterRelease > 0, 'rgba 轨迹段=' + trailAfterRelease);
    var headRed = ctxLog.filter(function (s) { return s === 'fillStyle=#E53935'; }).length;
    check('激光笔颜色与房主标记一致（红色）', headRed > 0);
    fireD(canvasD, 'mousedown', 300, 300);
    fireD(winD, 'mouseup', 300, 300);
    await sleep(120);
    var tailStart = ctxLog.length;
    await sleep(250);
    var residual = ctxLog.slice(tailStart).filter(function (s) { return s.indexOf('strokeStyle=rgba(229,57,53,') === 0; }).length;
    check('再次点击后残留轨迹立即消失', residual === 0, '残留 rgba 段=' + residual);
    check('激光窗口无运行时错误', D.errs.length === 0, D.errs.join(';'));

    /* 18. 只读用户只能分享只读链接 */
    winC.document.getElementById('btnShare').dispatchEvent(new winC.MouseEvent('click', { bubbles: true }));
    check('只读用户分享弹窗隐藏「可编辑」选项',
      winC.document.getElementById('shareModeEditRow').className.indexOf('hidden') >= 0);
    check('只读用户看不到导入配置按钮',
      winC.document.getElementById('btnImportCfg').className.indexOf('hidden') >= 0,
      'cls=' + winC.document.getElementById('btnImportCfg').className);
    var roShareUrl = winC.document.getElementById('shareUrlInput').value;
    check('只读用户分享链接强制带 ro=1', roShareUrl.indexOf('ro=1') > 0, roShareUrl);
    winC.document.getElementById('btnCloseShare').dispatchEvent(new winC.MouseEvent('click', { bubbles: true }));

    /* 19. 顶部栏按钮（清空/复制/删除/退出）与房主退出弹窗 */
    var topActions = win.document.getElementById('topbar').querySelector('.top-actions');
    check('清空/复制/删除/退出按钮均在顶部栏',
      topActions.contains(win.document.getElementById('btnClearTop')) &&
      topActions.contains(win.document.getElementById('btnCopy')) &&
      topActions.contains(win.document.getElementById('btnDelete')) &&
      topActions.contains(win.document.getElementById('btnExit')));
    win.document.getElementById('btnExit').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check('点击退出弹出退出确认框', win.document.getElementById('exitModal').className.indexOf('hidden') < 0);
    check('房主退出框显示房主链接与复制/删除入口',
      win.document.getElementById('exitOwnerBox').className.indexOf('hidden') < 0 &&
      win.document.getElementById('ownerUrlInput').value.indexOf('?room=' + roomId + '&key=') > 0 &&
      !!win.document.getElementById('btnCopyOwnerUrl') && !!win.document.getElementById('btnDeleteRoom'));
    win.document.getElementById('btnExitCancel').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check('退出框可取消关闭', win.document.getElementById('exitModal').className.indexOf('hidden') >= 0);

    /* 20. 隐藏工具栏：隐藏所有菜单，可切换退出 */
    check('按钮已命名为「隐藏工具栏」', win.document.getElementById('btnFullscreen').textContent === '隐藏工具栏');
    win.document.getElementById('btnFullscreen').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check('隐藏工具栏启用（body 标记）', win.document.body.className.indexOf('wb-present') >= 0);
    check('隐藏工具栏浮层可见（显示工具栏/全屏按钮）',
      win.document.getElementById('presentActions').className.indexOf('hidden') < 0 &&
      win.document.getElementById('btnExitPresent').className.indexOf('hidden') < 0 &&
      win.document.getElementById('btnPresentFull').className.indexOf('hidden') < 0);
    win.document.getElementById('btnExitPresent').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check('隐藏工具栏可退出', win.document.body.className.indexOf('wb-present') < 0 &&
      win.document.getElementById('presentActions').className.indexOf('hidden') >= 0);

    /* 21. 顶部「复制」与「删除」：复制一份选中图案；选中后点删除才删 */
    var selBtn7 = win.document.querySelector('[data-tool="select"]');
    selBtn7.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    fire(canvas, 'mousedown', 241.46, 616.04);   // 选中已复位的直线（中点）
    fire(win, 'mouseup', 241.46, 616.04);
    await sleep(80);
    var copyBase = msgsB.length;
    win.document.getElementById('btnCopy').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    var copiedLine = await waitFor(function () {
      for (var i = copyBase; i < msgsB.length; i++) {
        var m = msgsB[i];
        if (m.type === 'element_added' && m.element.type === 'line' &&
            Math.abs(m.element.x1 - 165.46) < 0.5 && Math.abs(m.element.y1 - 640.04) < 0.5 &&
            Math.abs(m.element.x2 - 365.46) < 0.5 && Math.abs(m.element.y2 - 640.04) < 0.5) return m.element;
      }
      return null;
    }, 3000);
    check('复制按钮：复制一份选中图案（偏移 24px）', !!copiedLine, copiedLine ? JSON.stringify(copiedLine) : '未收到');
    check('复制后选中副本', !!copiedLine && win.document.getElementById('selInfo').textContent.indexOf('直线（已选中）') >= 0,
      win.document.getElementById('selInfo').textContent);
    var delBase = msgsB.length;
    win.document.getElementById('btnDelete').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    var deletedCopy = await waitFor(function () {
      for (var i = delBase; i < msgsB.length; i++) {
        if (msgsB[i].type === 'element_deleted' && copiedLine && msgsB[i].id === copiedLine.id) return msgsB[i];
      }
      return null;
    }, 3000);
    check('删除按钮：选中图案后点击才删除（副本被删）', !!deletedCopy);
    check('删除后选择被清空', win.document.getElementById('selInfo').textContent === '未选中',
      win.document.getElementById('selInfo').textContent);

    /* 22. 框选多选：整体移动 / 缩放 / 复位 */
    var rectBtn8 = win.document.querySelector('[data-tool="rect"]');
    rectBtn8.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    function waitRectFinal(expX, expY) {
      return waitFor(function () {
        for (var i = 0; i < msgsB.length; i++) {
          var m = msgsB[i];
          if (m.type === 'element_updated' && m.commit && m.patch &&
              m.patch.x === expX && m.patch.y === expY && m.patch.w !== undefined) return m.id;
        }
        return null;
      }, 3000);
    }
    fire(canvas, 'mousedown', 200, 500);
    fire(win, 'mousemove', 300, 580);
    fire(win, 'mouseup', 300, 580);
    var g1id = await waitRectFinal(250, 540);
    fire(canvas, 'mousedown', 350, 500);
    fire(win, 'mousemove', 450, 580);
    fire(win, 'mouseup', 450, 580);
    var g2id = await waitRectFinal(400, 540);
    var g1 = { id: g1id }, g2 = { id: g2id };
    check('组测试矩形已创建', !!g1.id && !!g2.id && g1.id !== g2.id, 'g1=' + g1.id + ' g2=' + g2.id);
    var selBtn8 = win.document.querySelector('[data-tool="select"]');
    selBtn8.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    fire(canvas, 'mousedown', 180, 480);
    fire(win, 'mousemove', 320, 540);
    fire(win, 'mousemove', 470, 600);
    fire(win, 'mouseup', 470, 600);
    check('框选后显示已选中 2 个图案', win.document.getElementById('selInfo').textContent === '已选中 2 个图案',
      win.document.getElementById('selInfo').textContent);
    // 框选多选广播：观察端收到包含两个矩形 id 的 selection 消息（访问者看到完整多选状态）
    var gotMultiSel = await waitFor(function () {
      for (var i = 0; i < msgsB.length; i++) {
        var m = msgsB[i];
        if (m.type === 'selection' && m.ids && m.ids.length === 2 &&
            m.ids.indexOf(g1.id) >= 0 && m.ids.indexOf(g2.id) >= 0) return true;
      }
      return null;
    }, 3000);
    check('框选多选广播：其他成员收到完整 ids（两个矩形）', gotMultiSel === true);
    // 组移动：点组内矩形1中心 (250,540) 拖到 (270,560)，两个矩形同步平移 (20,20)
    var gmBase = msgsB.length;
    fire(canvas, 'mousedown', 250, 540);
    fire(win, 'mousemove', 260, 550);
    fire(win, 'mousemove', 270, 560);
    fire(win, 'mouseup', 270, 560);
    var gMoved = await waitFor(function () {
      var ok1 = false, ok2 = false;
      for (var i = gmBase; i < msgsB.length; i++) {
        var m = msgsB[i];
        if (m.type === 'element_updated' && m.commit && m.id === g1.id &&
            Math.abs(m.patch.x - 270) < 0.5 && Math.abs(m.patch.y - 560) < 0.5) ok1 = true;
        if (m.type === 'element_updated' && m.commit && m.id === g2.id &&
            Math.abs(m.patch.x - 420) < 0.5 && Math.abs(m.patch.y - 560) < 0.5) ok2 = true;
      }
      return ok1 && ok2;
    }, 3000);
    check('组移动：两个矩形同步平移', !!gMoved);
    // 组缩放：拖组框右下角 (480,610)（锚角=对角(210,510)，startDist≈287.92）到 (580,660) → f≈1.3867
    var gsBase = msgsB.length;
    fire(canvas, 'mousedown', 480, 610);
    fire(win, 'mousemove', 530, 635);
    fire(win, 'mousemove', 580, 660);
    fire(win, 'mouseup', 580, 660);
    var gScaled = await waitFor(function () {
      var ok1 = false, ok2 = false;
      for (var i = gsBase; i < msgsB.length; i++) {
        var m = msgsB[i];
        if (m.type === 'element_updated' && m.commit && m.id === g1.id &&
            Math.abs(m.patch.x - 293.2) < 0.5 && Math.abs(m.patch.y - 579.33) < 0.5 &&
            Math.abs(m.patch.w - 138.67) < 0.5 && Math.abs(m.patch.h - 110.93) < 0.5) ok1 = true;
        if (m.type === 'element_updated' && m.commit && m.id === g2.id &&
            Math.abs(m.patch.x - 501.2) < 0.5 && Math.abs(m.patch.y - 579.33) < 0.5 &&
            Math.abs(m.patch.w - 138.67) < 0.5 && Math.abs(m.patch.h - 110.93) < 0.5) ok2 = true;
      }
      return ok1 && ok2;
    }, 3000);
    check('组缩放：两个矩形绕锚角等比缩放', !!gScaled);
    // 组复位：缩放后组框中心(387.2,579.33) hh≈75.47 → 旋转手柄 (387.2,479.86)；单击复位
    var grBase = msgsB.length;
    fire(canvas, 'mousedown', 387.2, 479.86);
    fire(win, 'mouseup', 387.2, 479.86);
    var gReset = await waitFor(function () {
      var ok1 = false, ok2 = false;
      for (var i = grBase; i < msgsB.length; i++) {
        var m = msgsB[i];
        if (m.type === 'element_updated' && m.commit && m.id === g1.id &&
            m.patch.w === 100 && m.patch.h === 80 && m.patch.rotation === 0 &&
            Math.abs(m.patch.x - 293.2) < 0.5 && Math.abs(m.patch.y - 579.33) < 0.5) ok1 = true;
        if (m.type === 'element_updated' && m.commit && m.id === g2.id &&
            m.patch.w === 100 && m.patch.h === 80 && m.patch.rotation === 0 &&
            Math.abs(m.patch.x - 501.2) < 0.5 && Math.abs(m.patch.y - 579.33) < 0.5) ok2 = true;
      }
      return ok1 && ok2;
    }, 3000);
    check('组复位：恢复原始尺寸且位置不变', !!gReset);

    /* 23. 选中后：鼠标在编辑框内即可拖动（不必精确点到图案上） */
    var rectBtn10 = win.document.querySelector('[data-tool="rect"]');
    rectBtn10.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    fire(canvas, 'mousedown', 300, 300);
    fire(win, 'mousemove', 400, 380);
    fire(win, 'mouseup', 400, 380);
    var boxEl = await waitFor(function () {
      for (var i = 0; i < msgsB.length; i++) {
        var m = msgsB[i];
        if (m.type === 'element_updated' && m.commit && m.patch &&
            m.patch.x === 350 && m.patch.y === 340 && m.patch.w === 100) return { id: m.id, w: m.patch.w };
      }
      return null;
    }, 3000);
    check('框内拖动测试矩形已创建', !!boxEl);
    selBtn8.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    fire(canvas, 'mousedown', 350, 340);   // 点矩形中心选中
    fire(win, 'mouseup', 350, 340);
    await sleep(80);
    // 点 (402,348)：编辑框内（|dx|=52≤60）、图案外（x 超出 2px）、远离四角与旋转手柄 → 应整体拖动
    var inBoxBase = msgsB.length;
    fire(canvas, 'mousedown', 402, 348);
    fire(win, 'mousemove', 460, 400);
    fire(win, 'mouseup', 460, 400);
    var inBoxMoved = await waitFor(function () {
      for (var i = inBoxBase; i < msgsB.length; i++) {
        var m = msgsB[i];
        if (m.type === 'element_updated' && m.commit && m.id === boxEl.id &&
            Math.abs(m.patch.x - 408) < 0.5 && Math.abs(m.patch.y - 392) < 0.5) return m;
      }
      return null;
    }, 3000);
    check('选中后点编辑框内空白（图案外）即可拖动', !!inBoxMoved,
      inBoxMoved ? JSON.stringify(inBoxMoved.patch) : '未收到');

    /* 24. 访问者（可编辑、非房主）退出弹窗：无复制链接/删除入口 */
    var E = await bootBoard(roomId, '', '访问者E');
    var winE = E.win;
    await waitFor(function () { return winE.document.getElementById('roomCode').textContent === roomId; }, 3000);
    check('访问者也显示退出按钮', winE.document.getElementById('btnExit').className.indexOf('hidden') < 0);
    winE.document.getElementById('btnExit').dispatchEvent(new winE.MouseEvent('click', { bubbles: true }));
    check('访问者点击退出弹出退出确认框', winE.document.getElementById('exitModal').className.indexOf('hidden') < 0);
    check('访问者退出框不显示房主专属复制/删除入口',
      winE.document.getElementById('exitOwnerBox').className.indexOf('hidden') >= 0);
    winE.document.getElementById('btnExitCancel').dispatchEvent(new winE.MouseEvent('click', { bubbles: true }));

    /* 25. 适应画布不显示 NaN% */
    win.document.getElementById('btnZoomFit').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    var label = win.document.getElementById('btnZoomLabel').textContent;
    check('适应画布显示正常百分比', label.indexOf('NaN') < 0 && label.indexOf('%') > 0, label);

    /* 25b. 菜单栏导出图片按钮（真实导出到 PNG 由浏览器验证；jsdom 下点击不产生运行时错误） */
    var errCntBefore = A.errs.length;
    win.document.getElementById('btnExportImg').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check('顶部栏导出图片按钮存在且可点击无运行时错误',
      !!win.document.getElementById('btnExportImg') && A.errs.length === errCntBefore, A.errs.join(';'));

    /* 25c. 房主导入配置：确认覆盖后全量替换（观察端收到完整新元素） */
    win.confirm = function () { return true; };
    var importEls = [
      { id: 'imp1', type: 'rect', x: 100, y: 100, w: 80, h: 60, stroke: '#000', fill: 'rgba(0,0,0,0)', strokeWidth: 4, rotation: 0 },
      { id: 'imp2', type: 'text', x: 300, y: 300, text: '导入文本', fontSize: 40, fill: '#333', stroke: '#333', opacity: 1, rotation: 0, w: 100, h: 40 }
    ];
    var impFile = new win.File([JSON.stringify({ type: 'shared-whiteboard-config', version: 1, elements: importEls })], 'cfg.json', { type: 'application/json' });
    var importInput = win.document.getElementById('importFile');
    Object.defineProperty(importInput, 'files', { value: [impFile], configurable: true });
    importInput.dispatchEvent(new win.MouseEvent('change', { bubbles: true }));
    await sleep(400);
    var importDiag = 'files=' + importInput.files.length +
      ' status=' + win.document.getElementById('statusLine').textContent +
      ' errs=' + A.errs.join(';');
    var importedState = await waitFor(function () {
      for (var i = 0; i < msgsB.length; i++) {
        var m = msgsB[i];
        if (m.type === 'state' && m.elements && m.elements.length === 2 &&
            m.elements[0].id === 'imp1' && m.elements[1].id === 'imp2') return m;
      }
      return null;
    }, 3000);
    check('房主导入配置覆盖白板并广播（观察端收到完整新元素）', !!importedState,
      importedState ? JSON.stringify(importedState.elements) : importDiag);
    check('导入后房主本地选择被清空', win.document.getElementById('selInfo').textContent === '未选中',
      win.document.getElementById('selInfo').textContent);

    /* 26. 管理员控制台：HTTP 基本认证（启动参数 --admin-user/--admin-pass）
     * 查看全部白板 / 伪装成房主进入 / 删除指定白板 / 删除全部白板 */
    var AUTH = 'Basic ' + Buffer.from('e2eadmin:e2epass').toString('base64');
    function adminReq(method, p, body) {
      return new Promise(function (resolve) {
        var buf = '';
        var req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: method,
          headers: { 'Authorization': AUTH, 'Content-Type': 'application/json' } }, function (res) {
          res.on('data', function (c) { buf += c; });
          res.on('end', function () { try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); } catch (e) { resolve({ status: res.statusCode, data: {} }); } });
        });
        req.on('error', function () { resolve({ status: 0, data: {} }); });
        req.end(body ? JSON.stringify(body) : null);
      });
    }
    function noAuthGet(p) {
      return new Promise(function (resolve) {
        var req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' }, function (res) {
          res.resume();
          res.on('end', function () { resolve(res.statusCode); });
        });
        req.on('error', function () { resolve(0); });
        req.end();
      });
    }
    var unauth = await noAuthGet('/api/admin/rooms');
    check('未认证访问管理接口返回 401', unauth === 401, 'status=' + unauth);
    // 首页管理员入口：始终显示（未配置时进入管理页再提示配置）
    var idxHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    var idxDom = new JSDOM(idxHtml, { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
    var winIdx = idxDom.window;
    var idxScripts = idxDom.window.document.querySelectorAll('script');
    for (var isi = 0; isi < idxScripts.length; isi++) {
      try { winIdx.eval(idxScripts[isi].textContent || ''); } catch (e2) {}
    }
    check('首页显示管理员登录入口',
      winIdx.document.getElementById('adminLink').className.indexOf('hidden') < 0,
      'cls=' + winIdx.document.getElementById('adminLink').className);
    // 静态检查：伪装进入不带 name 参数（服务端按房主强制显示「房主」）；
    // 退出登录用错误凭据 XHR 覆盖缓存而非 logout:logout@ 跳转（避免地址栏残留错误凭据无法再登录）
    var adminHtmlSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
    check('管理员进入白板的链接不带 name 参数', adminHtmlSrc.indexOf('&name=') < 0,
      '链接中仍含 name 参数');
    check('管理员退出登录不再使用 logout:logout@ 跳转',
      adminHtmlSrc.indexOf("location.href = 'http://logout:logout@'") < 0 &&
      adminHtmlSrc.indexOf("'logout', 'logout'") > 0,
      '退出登录实现未更新');

    /* 27. 首页加入预检：房间号不存在 / 密码错误直接提示，不进入白板页面 */
    var noRoom = await getJson('/api/room?id=ZZZZZ');
    check('不存在房间的预检接口返回 exists=false', noRoom.status === 200 && noRoom.data.exists === false,
      'status=' + noRoom.status + ' exists=' + noRoom.data.exists);
    var yesRoom = await getJson('/api/room?id=' + roomId);
    check('存在房间的预检接口返回 exists=true', yesRoom.status === 200 && yesRoom.data.exists === true,
      'status=' + yesRoom.status + ' exists=' + yesRoom.data.exists);
    var pwdRoom = await xhrPost('/api/create', { name: '带密码预检', pwd: 'abc123' });
    var pwdBad = await getJson('/api/room?id=' + pwdRoom.id + '&pwd=wrong');
    var pwdGood = await getJson('/api/room?id=' + pwdRoom.id + '&pwd=abc123');
    var pwdMissing = await getJson('/api/room?id=' + pwdRoom.id);
    var pwdNone = await getJson('/api/room?id=' + roomId);
    check('密码错误的预检返回 pwdOk=false', pwdBad.status === 200 && pwdBad.data.exists === true && pwdBad.data.pwdOk === false,
      'status=' + pwdBad.status + ' pwdOk=' + pwdBad.data.pwdOk);
    check('密码正确的预检返回 pwdOk=true', pwdGood.status === 200 && pwdGood.data.pwdOk === true,
      'pwdOk=' + pwdGood.data.pwdOk);
    check('带密码房间未输密码预检返回 pwdOk=false', pwdMissing.status === 200 && pwdMissing.data.pwdOk === false,
      'pwdOk=' + pwdMissing.data.pwdOk);
    check('无密码房间预检返回 pwdOk=true', pwdNone.status === 200 && pwdNone.data.exists === true && pwdNone.data.pwdOk === true,
      'pwdOk=' + pwdNone.data.pwdOk);
    // jsdom 模拟：输入不存在的房间号点加入 → 显示提示且不跳转
    function bootIndex() {
      var dom = new JSDOM(idxHtml, { url: BASE + '/', runScripts: 'outside-only', pretendToBeVisual: true });
      var w = dom.window;
      var sc = dom.window.document.querySelectorAll('script');
      for (var si = 0; si < sc.length; si++) {
        try { w.eval(sc[si].textContent || ''); } catch (e9) {}
      }
      return w;
    }
    var wIdx = bootIndex();
    var locBefore = wIdx.location.href;
    wIdx.document.getElementById('jRoom').value = 'ZZZZZ';
    wIdx.document.getElementById('btnJoin').dispatchEvent(new wIdx.MouseEvent('click', { bubbles: true }));
    var joinMsgText = await waitFor(function () {
      var m = wIdx.document.getElementById('joinMsg').textContent;
      return m && m.indexOf('不存在') > 0 ? m : null;
    }, 3000);
    check('加入不存在的房间：页面直接提示且不跳转',
      !!joinMsgText && wIdx.location.href === locBefore,
      'msg=' + joinMsgText + ' 跳转=' + (wIdx.location.href !== locBefore));
    var wpIdx = bootIndex();
    var pLocBefore = wpIdx.location.href;
    wpIdx.document.getElementById('jRoom').value = pwdRoom.id;
    wpIdx.document.getElementById('jPwd').value = 'bad';
    wpIdx.document.getElementById('btnJoin').dispatchEvent(new wpIdx.MouseEvent('click', { bubbles: true }));
    var pwdMsgText = await waitFor(function () {
      var m = wpIdx.document.getElementById('joinMsg').textContent;
      return m && m.indexOf('密码错误') > 0 ? m : null;
    }, 3000);
    check('加入密码错误的房间：页面直接提示且不跳转',
      !!pwdMsgText && wpIdx.location.href === pLocBefore,
      'msg=' + pwdMsgText + ' 跳转=' + (wpIdx.location.href !== pLocBefore));

    /* 27b. 文本输入框随内容自适应宽高（高度按行数/换行，宽度按最长行） */
    win.document.querySelector('[data-tool="text"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    fire(canvas, 'mousedown', 100, 500);
    fire(win, 'mouseup', 100, 500);
    var ta3 = win.document.getElementById('inlineText');
    ta3.value = '第一行\n第二行';
    ta3.dispatchEvent(new win.Event('input', { bubbles: true }));
    var hAuto = parseFloat(ta3.style.height) || 0;
    check('文本输入框随内容变高（2 行时高度自适应）', hAuto > 40, 'h=' + hAuto);
    ta3.value = '一';
    ta3.dispatchEvent(new win.Event('input', { bubbles: true }));
    var h1 = parseFloat(ta3.style.height) || 0;
    check('文本输入框单行高度回落', h1 > 0 && h1 < hAuto, 'h1=' + h1 + ' h2=' + hAuto);
    ta3.dispatchEvent(new win.KeyboardEvent('keydown', { keyCode: 27, bubbles: true }));
    check('文本输入框 Esc 取消（自适应不残留）',
      win.document.getElementById('inlineText').className.indexOf('hidden') >= 0,
      'cls=' + win.document.getElementById('inlineText').className);

    /* 27c. 双击文本再次编辑（选择工具下 dblclick 进入编辑，改文提交广播） */
    win.document.querySelector('[data-tool="text"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    fire(canvas, 'mousedown', 150, 450);
    fire(win, 'mouseup', 150, 450);
    var taD = win.document.getElementById('inlineText');
    taD.value = '原始内容';
    taD.dispatchEvent(new win.Event('input', { bubbles: true }));
    taD.dispatchEvent(new win.MouseEvent('blur', { bubbles: false }));
    var editTarget = await waitFor(function () {
      for (var i = 0; i < msgsB.length; i++) {
        var m = msgsB[i];
        if (m.type === 'element_added' && m.element.type === 'text' && m.element.text === '原始内容') return m.element;
      }
      return null;
    }, 3000);
    // 若文本未创建，后续断言自然失败，无需单独准备断言
    win.document.querySelector('[data-tool="select"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    // 文本渲染起点屏幕位置 = 输入框提交起点（左 150+6、上 450+2+0.15*字号），与 view 无关（往返恒等）
    var stY = 450 + 2 + Math.round(editTarget.fontSize * 0.15);
    fire(canvas, 'mousedown', 156, stY);
    fire(win, 'mouseup', 156, stY);
    canvas.dispatchEvent(new win.MouseEvent('dblclick', { clientX: 156, clientY: stY, bubbles: true }));
    var taE = win.document.getElementById('inlineText');
    check('双击文本进入编辑且带原文', taE.className.indexOf('hidden') < 0 && taE.value === '原始内容',
      'hidden=' + taE.className + ' val=' + taE.value);
    taE.value = '修改后内容';
    taE.dispatchEvent(new win.Event('input', { bubbles: true }));
    taE.dispatchEvent(new win.MouseEvent('blur', { bubbles: false }));
    var editUpdated = await waitFor(function () {
      for (var i = 0; i < msgsB.length; i++) {
        var m = msgsB[i];
        if (m.type === 'element_updated' && m.id === editTarget.id && m.commit && m.patch.text === '修改后内容') return m;
      }
      return null;
    }, 3000);
    check('双击编辑提交广播更新（文字/字号/几何）', !!editUpdated,
      editUpdated ? JSON.stringify(editUpdated.patch) : '未收到');
    check('编辑提交 patch 携带 fontSize（远端字号同步）',
      !!editUpdated && editUpdated.patch.fontSize === 20,
      editUpdated ? 'fs=' + editUpdated.patch.fontSize : '未收到');
    /* 27d. 编辑已有文本时输入框按文本字号自适应（不按全局字号测量导致单行换行/高度错） */
    var fontR2 = win.document.getElementById('fontRange');
    fontR2.value = 60;
    fontR2.dispatchEvent(new win.MouseEvent('input', { bubbles: true }));
    fontR2.dispatchEvent(new win.MouseEvent('change', { bubbles: true }));
    await sleep(150);
    // 27c 编辑提交后文本起点屏幕 = (162, 460)（往返恒等），字号 60 不改变 x/y
    canvas.dispatchEvent(new win.MouseEvent('dblclick', { clientX: 162, clientY: 460, bubbles: true }));
    var taF = win.document.getElementById('inlineText');
    var hF = parseFloat(taF.style.height) || 0;
    check('编辑大字号文本时输入框按文本字号自适应（非全局字号）',
      taF.className.indexOf('hidden') < 0 && hF >= 60,
      'hidden=' + taF.className + ' h=' + hF + ' fs=' + taF.style.fontSize);
    taF.dispatchEvent(new win.KeyboardEvent('keydown', { keyCode: 27, bubbles: true }));

    /* 28. 管理员：列表 / 伪装进入 / 删除 */
    var roomList = await adminReq('GET', '/api/admin/rooms');
    var hasMain = roomList.data && roomList.data.rooms && roomList.data.rooms.some(function (r) { return r.id === roomId; });
    check('认证后查看全部白板（含主房间）', roomList.status === 200 && roomList.data.ok && hasMain,
      'status=' + roomList.status);
    var adminCr = await xhrPost('/api/create', { name: '管理专测' });
    check('管理员测试房间已创建', !!adminCr.id);
    var adminList2 = await adminReq('GET', '/api/admin/rooms');
    var adminRoomMeta = null;
    if (adminList2.data && adminList2.data.rooms) {
      for (var rj = 0; rj < adminList2.data.rooms.length; rj++) {
        if (adminList2.data.rooms[rj].id === adminCr.id) adminRoomMeta = adminList2.data.rooms[rj];
      }
    }
    check('管理列表返回房间 ownerKey（供伪装进入）', !!adminRoomMeta && typeof adminRoomMeta.ownerKey === 'string' && adminRoomMeta.ownerKey.length > 0);
    check('管理列表返回最后修改时间', !!adminRoomMeta && typeof adminRoomMeta.lastModified === 'number' && adminRoomMeta.lastModified > 0,
      'lastModified=' + (adminRoomMeta && adminRoomMeta.lastModified));
    check('admin 页面含最后修改列与在线「现在」显示',
      adminHtmlSrc.indexOf('最后修改') >= 0 && adminHtmlSrc.indexOf('lastModified') >= 0 &&
      adminHtmlSrc.indexOf('现在') >= 0,
      'admin 页面未包含最后修改/现在逻辑');
    var D2 = await bootBoard(adminCr.id, adminRoomMeta ? adminRoomMeta.ownerKey : '', '管理伪装');
    var winD2 = D2.win;
    await waitFor(function () { return winD2.document.getElementById('roomCode').textContent === adminCr.id; }, 3000);
    check('伪装成房主进入：房间名带房主标记',
      winD2.document.getElementById('roomName').className.indexOf('owner') >= 0,
      'cls=' + winD2.document.getElementById('roomName').className);
    check('伪装成房主进入：退出按钮可见',
      winD2.document.getElementById('btnExit').className.indexOf('hidden') < 0);
    var delOne = await adminReq('POST', '/api/admin/delete_room', { id: adminCr.id });
    var roomList3 = await adminReq('GET', '/api/admin/rooms');
    var hasAdminRoom = roomList3.data && roomList3.data.rooms && roomList3.data.rooms.some(function (r) { return r.id === adminCr.id; });
    check('删除指定白板成功且列表中消失', delOne.status === 200 && delOne.data.ok && !hasAdminRoom,
      'status=' + delOne.status);
    // 删除全部白板（会断开所有连接，必须放最后）
    var delAll = await adminReq('POST', '/api/admin/delete_all');
    var roomList4 = await adminReq('GET', '/api/admin/rooms');
    var emptyOk = roomList4.data && roomList4.data.rooms && roomList4.data.rooms.length === 0;
    check('删除全部白板成功且列表为空', delAll.status === 200 && delAll.data.ok && delAll.data.deleted >= 1 && emptyOk,
      'deleted=' + (delAll.data.deleted) + ' status=' + delAll.status);

    try { wsB.close(); } catch (e) {}

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
