/* ============================================================
 * 共享白板客户端
 * 兼容 iOS 9 Safari：仅使用 ES5 语法与旧版 Web API
 * （var / function、XMLHttpRequest、WebSocket、FileReader，
 *  不使用 let/const/箭头函数/模板字符串/fetch/class）
 *
 * 主要功能：
 *  - 12 种工具：抓手 / 选择（点选+框选）/ 画笔 / 直线 / 箭头 /
 *    矩形 / 圆形 / 文本 / 图片 / 油漆桶 / 激光笔
 *  - 图案编辑：拖动移动、锚点式缩放、旋转，单击旋转圈复位到初始几何
 *  - 多选组整体移动 / 缩放 / 旋转 / 复位 / 复制 / 删除
 *  - 撤销 / 重做、清空画布、复制 / 删除选中图案
 *  - 自定义颜色（RGB 滑块）、透明度、线宽、字号、层次（置顶/上移/置底/下移）
 *  - 只读模式（ro=1）：只读用户仅查看 / 缩放 / 激光笔 / 分享只读链接 / 退出
 *  - 隐藏工具栏演示模式 + 浏览器全屏（F11）
 *  - 房主专属：重命名白板、退出（保留白板）、删除白板
 * ============================================================ */
(function () {
  'use strict';

  /* ================= 小工具 ================= */
  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function dist(x1, y1, x2, y2) { var dx = x2 - x1, dy = y2 - y1; return Math.sqrt(dx * dx + dy * dy); }
  function dist2(x1, y1, x2, y2) { var dx = x2 - x1, dy = y2 - y1; return dx * dx + dy * dy; }
  function uid() {
    return 'e' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }
  function qs(name) {
    var m = location.search.match(new RegExp('[?&]' + name + '=([^&]*)'));
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }
  function indexOfId(arr, id) {
    for (var i = 0; i < arr.length; i++) { if (arr[i].id === id) return i; }
    return -1;
  }
  function getElementById(id) {
    var i = indexOfId(elements, id);
    return i >= 0 ? elements[i] : null;
  }
  function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }
  function segPointDist(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var len2 = dx * dx + dy * dy;
    if (len2 === 0) return dist(px, py, ax, ay);
    var t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = clamp(t, 0, 1);
    return dist(px, py, ax + dx * t, ay + dy * t);
  }
  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  /* passive 特性检测：iOS 11.4+ 的 touchmove 默认 passive，必须显式关闭才能 preventDefault */
  var supportsPassive = false;
  try {
    var passiveOpts = Object.defineProperty({}, 'passive', {
      get: function () { supportsPassive = true; return false; }
    });
    window.addEventListener('test-passive', null, passiveOpts);
    window.removeEventListener('test-passive', null, passiveOpts);
  } catch (e) { /* 老浏览器忽略 */ }
  function addEvt(el, ev, fn) {
    el.addEventListener(ev, fn, supportsPassive ? { passive: false } : false);
  }

  /* ================= 全局状态 ================= */
  var PARAMS = {
    room: qs('room'), pwd: qs('pwd'), key: qs('key'), ro: qs('ro'), name: qs('name')
  };
  var ws = null;
  var connected = false;
  var roomGone = false;      // 白板已被创建者删除
  var joinFailed = false;    // 加入被拒绝（房间不存在/密码错误），停止重连
  var myUid = null, myName = '访客', myColor = '#E53935';
  var readonly = false;
  var isOwner = false;
  var roomInfo = null;
  var users = [];            // [{uid,name,color,readonly,owner}]
  var elements = [];         // 本地元素镜像（数组顺序即层次，越靠后越在上层）
  var selectedId = null;     // 主选中元素 id（单选时唯一；多选时取 selectedIds 最后一位）
  var selectedIds = [];      // 多选：选中元素 id 的有序数组（框选产生），最后一位为主选中
  var copyBuffer = null;     // 复制剪贴板：元素数组（Ctrl+C 存入，Ctrl+V 粘贴）
  var remoteSelections = {}; // uid -> 该用户当前选中的元素 id 数组（让访问者看到编辑状态）
  var undoable = false, redoable = false;
  var laserUsers = {};       // uid -> {x,y,active,trail:[]}
  var origShapes = {};       // id -> 元素初始几何快照（笔/直线/箭头「复位」用）

  var tool = 'pen';          // hand/select/pen/line/arrow/rect/circle/text/image/bucket/laser
  var color = '#000000';
  var opacity = 1;           // 默认不透明
  var strokeWidth = 4;
  var fontSize = 20;           // 新建文本默认字号
  // 颜色系统：描边色 / 填充色分离（矩形/圆形可填充与边框不同色）
  var strokeColor = '#000000';      // 新建描边色（笔/线/箭头/文本/形状描边）
  var fillColor = 'none';           // 新建填充色（矩形/圆形内部；'none'=透明）
  var colorTarget = 'stroke';       // 面板当前调整目标：'stroke' | 'fill'

  var view = { zoom: 1, panX: 0, panY: 0 };
  var drag = null;           // 当前手势状态
  var lastPointer = { x: 0, y: 0 };
  var lastUpdateSend = 0;
  var lastLaserSend = 0;

  /* ================= 画布（iOS9 单边上限 4096，按需降 dpr） ================= */
  var canvas = $('board');
  var ctx = canvas.getContext('2d');
  var dpr = 1;
  var MAX_CANVAS_DIM = 4096;

  function resizeCanvas() {
    var d = Math.min(window.devicePixelRatio || 1, 2);
    while (d > 1 && (window.innerWidth * d > MAX_CANVAS_DIM || window.innerHeight * d > MAX_CANVAS_DIM)) {
      d = Math.max(1, Math.floor(d / 2));
    }
    dpr = d;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    render();
  }
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('orientationchange', function () { setTimeout(resizeCanvas, 200); });

  var imageCache = {};
  function loadImage(src) {
    var o = { img: new Image(), loaded: false };
    o.img.onload = function () { o.loaded = true; requestRender(); };
    o.img.src = src;
    return o;
  }

  function worldToScreen(x, y) { return { x: x * view.zoom + view.panX, y: y * view.zoom + view.panY }; }
  function screenToWorld(sx, sy) { return { x: (sx - view.panX) / view.zoom, y: (sy - view.panY) / view.zoom }; }

  function setZoom(z, cx, cy) {
    z = clamp(z, 0.1, 8);
    var w = screenToWorld(cx, cy);
    view.zoom = z;
    var s = worldToScreen(w.x, w.y);
    view.panX += cx - s.x;
    view.panY += cy - s.y;
    $('btnZoomLabel').textContent = Math.round(z * 100) + '%';
    render();
  }

  /* ================= 渲染 ================= */
  var renderPending = false;
  function requestRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(function () { renderPending = false; render(); });
  }
  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

    // 图案在世界坐标绘制
    ctx.save();
    ctx.translate(view.panX, view.panY);
    ctx.scale(view.zoom, view.zoom);
    for (var i = 0; i < elements.length; i++) drawElement(elements[i]);
    ctx.restore();

    // 选中框/远程选中框在屏幕坐标绘制（selectionHandles 已换算屏幕坐标，
    // 若放在世界变换内会双重变换导致平移/缩放后偏移）
    if (tool === 'select') {
      if (selectedIds.length > 1) drawGroupSelection();
      else if (selectedId) drawSelection(getElementById(selectedId));
    }
    var rk = Object.keys(remoteSelections);
    for (var j = 0; j < rk.length; j++) {
      var rids = remoteSelections[rk[j]];
      if (!rids || !rids.length) continue;
      // 排除自己当前正在编辑的图案（避免与本地选中框重叠）
      var visible = [];
      for (var vi = 0; vi < rids.length; vi++) {
        if (rids[vi] === selectedId || selectedIds.indexOf(rids[vi]) >= 0) continue;
        visible.push(rids[vi]);
      }
      if (!visible.length) continue;
      if (visible.length === 1) drawSelection(getElementById(visible[0]));
      else drawRemoteGroupSelection(visible);
    }

    // 框选（marquee）矩形：屏幕坐标
    if (drag && drag.mode === 'marquee' && drag.moved) {
      var mw = lastPointer.x - drag.x0, mh = lastPointer.y - drag.y0;
      ctx.fillStyle = 'rgba(30, 136, 229, 0.08)';
      ctx.fillRect(drag.x0, drag.y0, mw, mh);
      ctx.strokeStyle = '#1E88E5';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(drag.x0, drag.y0, mw, mh);
      ctx.setLineDash([]);
    }

    drawLasers();
  }

  /* ================= 元素几何：各类图案的包围盒（含 pen 点集） ================= */
  function penBox(el) {
    var pts = el.points, n = pts.length;
    if (!n || !pts[0]) return { x: 0, y: 0, w: 1, h: 1 };
    var minX = pts[0][0], minY = pts[0][1], maxX = pts[0][0], maxY = pts[0][1];
    for (var i = 1; i < n; i++) {
      var px = pts[i][0], py = pts[i][1];
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
    }
    return {
      x: (minX + maxX) / 2, y: (minY + maxY) / 2,
      w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY)
    };
  }
  function elCenter(el) {
    if (el.type === 'line' || el.type === 'arrow') {
      return { x: (el.x1 + el.x2) / 2, y: (el.y1 + el.y2) / 2 };
    }
    if (el.type === 'pen') return penBox(el);
    // 文本元素 x,y 为左上角（左上角对齐），中心 = 左上角 + 尺寸一半
    if (el.type === 'text') return { x: el.x + (el.w || 1) / 2, y: el.y + (el.h || 1) / 2 };
    return { x: el.x, y: el.y };
  }
  function elSize(el) {
    if (el.type === 'line' || el.type === 'arrow') {
      return { w: Math.max(1, Math.abs(el.x2 - el.x1)), h: Math.max(1, Math.abs(el.y2 - el.y1)) };
    }
    if (el.type === 'pen') return penBox(el);
    return { w: Math.max(1, el.w || 1), h: Math.max(1, el.h || 1) };
  }

  /* ================= 多选（框选组）几何 ================= */
  /* 元素在世界坐标的轴对齐包围盒（考虑 rotation 的旋转外框） */
  function elWorldBox(el) {
    var c = elCenter(el), s = elSize(el);
    var a = el.rotation ? el.rotation * Math.PI / 180 : 0;
    var cos = Math.cos(a), sin = Math.sin(a);
    var hw = s.w / 2, hh = s.h / 2;
    var pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < 4; i++) {
      var x = c.x + pts[i][0] * cos - pts[i][1] * sin;
      var y = c.y + pts[i][0] * sin + pts[i][1] * cos;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  /* 当前选中元素数组（按 selectedIds 顺序） */
  function selEls() {
    var out = [];
    for (var i = 0; i < selectedIds.length; i++) {
      var e = getElementById(selectedIds[i]);
      if (e) out.push(e);
    }
    return out;
  }
  /* 多选组的世界坐标包围盒（所有选中元素外框并集） */
  function groupWorldBox() {
    return worldBoxOf(selEls());
  }
  /* 任意元素集合的世界坐标包围盒 */
  function worldBoxOf(els) {
    if (!els.length) return { x: 0, y: 0, w: 1, h: 1 };
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < els.length; i++) {
      var b = elWorldBox(els[i]);
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.x + b.w > maxX) maxX = b.x + b.w;
      if (b.y + b.h > maxY) maxY = b.y + b.h;
    }
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
  }
  /* 组编辑框的屏幕坐标手柄（轴对齐） */
  function groupHandles() {
    return groupHandlesOf(selEls());
  }
  /* 任意元素集合的组编辑框屏幕坐标手柄 */
  function groupHandlesOf(els) {
    var g = worldBoxOf(els);
    var sc = worldToScreen(g.x, g.y);
    var hw = g.w * view.zoom / 2 + 10, hh = g.h * view.zoom / 2 + 10;
    return {
      center: sc,
      corners: [
        { x: sc.x - hw, y: sc.y - hh }, { x: sc.x + hw, y: sc.y - hh },
        { x: sc.x + hw, y: sc.y + hh }, { x: sc.x - hw, y: sc.y + hh }
      ],
      top: { x: sc.x, y: sc.y - hh },
      rot: { x: sc.x, y: sc.y - hh - 24 }
    };
  }
  /* 对选中元素集合拍快照（id -> 深拷贝），供组操作撤销/基准 */
  function snapGroup() {
    var snaps = {};
    for (var i = 0; i < selectedIds.length; i++) {
      var el = getElementById(selectedIds[i]);
      if (el) snaps[el.id] = deepCopy(el);
    }
    return snaps;
  }
  /* 清理选中集合中已不存在的元素 id（welcome/state/删除后调用） */
  function pruneSelection() {
    var kept = [];
    for (var i = 0; i < selectedIds.length; i++) {
      if (getElementById(selectedIds[i])) kept.push(selectedIds[i]);
    }
    selectedIds = kept;
    selectedId = kept.length ? kept[kept.length - 1] : null;
    updateSelInfo();
  }

  function drawElement(el) {
    if (!el) return;
    ctx.save();
    ctx.globalAlpha = (typeof el.opacity === 'number') ? el.opacity : 1;
    var t = el.type;

    if (t === 'pen') {
      ctx.strokeStyle = el.stroke || '#000';
      ctx.lineWidth = el.strokeWidth || 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      var pts = el.points, n = pts.length;
      if (n && pts[0]) {
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (var i = 1; i < n; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      }
      ctx.stroke();
      // 只有一个点（或原地不动）时画一个圆点，否则看不见
      var pb = penBox(el);
      if (pb.w < 2 && pb.h < 2) {
        ctx.fillStyle = el.stroke || '#000';
        ctx.beginPath();
        ctx.arc(pb.x, pb.y, Math.max(1.5, (el.strokeWidth || 4) / 2), 0, Math.PI * 2);
        ctx.fill();
      }

    } else if (t === 'line' || t === 'arrow') {
      ctx.strokeStyle = el.stroke || '#000';
      ctx.lineWidth = el.strokeWidth || 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(el.x1, el.y1);
      ctx.lineTo(el.x2, el.y2);
      ctx.stroke();
      if (t === 'arrow') drawArrowHead(el);

    } else {
      ctx.translate(el.x, el.y);
      if (el.rotation) ctx.rotate(el.rotation * Math.PI / 180);

      if (t === 'rect') {
        if (el.fill && el.fill !== 'none') {
          ctx.fillStyle = el.fill;
          ctx.fillRect(-el.w / 2, -el.h / 2, el.w, el.h);
        }
        if (el.stroke && el.stroke !== 'none') {
          ctx.strokeStyle = el.stroke;
          ctx.lineWidth = el.strokeWidth || 2;
          ctx.strokeRect(-el.w / 2, -el.h / 2, el.w, el.h);
        }

      } else if (t === 'circle') {
        var sy = el.w ? (el.h / el.w) : 1;
        ctx.scale(1, sy);
        if (el.fill && el.fill !== 'none') {
          ctx.fillStyle = el.fill;
          ctx.beginPath(); ctx.arc(0, 0, el.w / 2, 0, Math.PI * 2); ctx.fill();
        }
        if (el.stroke && el.stroke !== 'none') {
          ctx.strokeStyle = el.stroke;
          ctx.lineWidth = (el.strokeWidth || 2) / sy;
          ctx.beginPath(); ctx.arc(0, 0, el.w / 2, 0, Math.PI * 2); ctx.stroke();
        }

      } else if (t === 'text') {
        // 文本元素 x,y 为文字左上角：重建变换，旋转以文字中心为原点
        ctx.restore();
        ctx.save();
        ctx.globalAlpha = (typeof el.opacity === 'number') ? el.opacity : 1;
        ctx.translate(el.x + (el.w || 1) / 2, el.y + (el.h || 1) / 2);
        if (el.rotation) ctx.rotate(el.rotation * Math.PI / 180);
        ctx.translate(-(el.w || 1) / 2, -(el.h || 1) / 2);
        ctx.fillStyle = el.stroke || '#000';
        ctx.font = (el.fontSize || 24) + 'px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        var lines = String(el.text || '').split('\n');
        var lh = (el.fontSize || 24) * 1.3;
        for (var j = 0; j < lines.length; j++) {
          ctx.fillText(lines[j], 0, j * lh);
        }

      } else if (t === 'image') {
        var im = imageCache[el.id] || (imageCache[el.id] = loadImage(el.src));
        if (im.loaded) {
          ctx.drawImage(im.img, -el.w / 2, -el.h / 2, el.w, el.h);
        } else {
          ctx.strokeStyle = '#bbb';
          ctx.lineWidth = 1;
          ctx.strokeRect(-el.w / 2, -el.h / 2, el.w, el.h);
        }
      }
    }
    ctx.restore();
  }

  function drawArrowHead(el) {
    var ang = Math.atan2(el.y2 - el.y1, el.x2 - el.x1);
    var len = Math.max(12, (el.strokeWidth || 4) * 2.5);
    var a1 = ang + Math.PI * 5 / 6, a2 = ang - Math.PI * 5 / 6;
    ctx.beginPath();
    ctx.moveTo(el.x2, el.y2);
    ctx.lineTo(el.x2 + len * Math.cos(a1), el.y2 + len * Math.sin(a1));
    ctx.moveTo(el.x2, el.y2);
    ctx.lineTo(el.x2 + len * Math.cos(a2), el.y2 + len * Math.sin(a2));
    ctx.stroke();
  }

  function selectionHandles(el) {
    var c = elCenter(el), s = elSize(el);
    var sc = worldToScreen(c.x, c.y);
    var a = el.rotation ? el.rotation * Math.PI / 180 : 0;
    var cos = Math.cos(a), sin = Math.sin(a);
    function pt(lx, ly) {
      return { x: sc.x + lx * cos - ly * sin, y: sc.y + lx * sin + ly * cos };
    }
    var hw = s.w * view.zoom / 2 + 10, hh = s.h * view.zoom / 2 + 10;
    return {
      center: sc,
      corners: [pt(-hw, -hh), pt(hw, -hh), pt(hw, hh), pt(-hw, hh)],
      top: pt(0, -hh),
      rot: pt(0, -hh - 24)
    };
  }

  function drawSelection(el) {
    if (!el) return;
    drawSelectionHandles(selectionHandles(el));
  }

  /* 多选组编辑框：轴对齐包围盒 + 四角控制点 + 顶部旋转手柄 */
  function drawGroupSelection() {
    if (!selectedIds.length) return;
    drawSelectionHandles(groupHandles());
  }

  /* 远程成员的多选组编辑框（按广播的 id 集合计算） */
  function drawRemoteGroupSelection(ids) {
    var els = [];
    for (var i = 0; i < ids.length; i++) {
      var e = getElementById(ids[i]);
      if (e) els.push(e);
    }
    if (els.length > 1) drawSelectionHandles(groupHandlesOf(els));
  }

  function drawSelectionHandles(h) {
    // 编辑框随图案边框旋转：沿四个角点绘制旋转四边形（而非轴对齐矩形）；
    // 锚点 / 线宽 / 虚线均固定为屏幕像素大小（不随画布缩放变化，保证触屏上清晰且不偏大）
    ctx.strokeStyle = '#1E88E5';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(h.corners[0].x, h.corners[0].y);
    for (var i = 1; i < 4; i++) ctx.lineTo(h.corners[i].x, h.corners[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    var r = 6;
    for (var i2 = 0; i2 < 4; i2++) {
      ctx.fillStyle = '#1E88E5';
      ctx.fillRect(h.corners[i2].x - r, h.corners[i2].y - r, r * 2, r * 2);
    }
    // 旋转手柄连接线：从旋转后的顶部中点出发
    ctx.strokeStyle = '#1E88E5';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(h.top.x, h.top.y);
    ctx.lineTo(h.rot.x, h.rot.y);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(h.rot.x, h.rot.y, 6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#1E88E5';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(h.rot.x, h.rot.y, 6, 0, Math.PI * 2); ctx.stroke();
  }

  /* ================= 激光笔渲染（使用者和访问者都显示，轨迹为逐渐消失的线） ================= */
  var LASER_TRAIL_MS = 1500; // 轨迹停留时长
  function findUser(uidKey) {
    for (var i = 0; i < users.length; i++) {
      if (users[i].uid === uidKey) return users[i];
    }
    return null;
  }
  /* 激光笔颜色与左上角用户标记颜色一致；房主始终为红色 */
  function laserColorOf(uidKey) {
    var nm = findUser(uidKey);
    if (nm) {
      if (nm.owner) return '#E53935';
      return nm.color || '#E53935';
    }
    return '#E53935';
  }
  /* 松开鼠标后轨迹不再有新的输入事件驱动渲染，用定时器让残留轨迹继续渐隐 */
  var laserFadeTimer = null;
  function scheduleLaserFade() {
    if (laserFadeTimer) return;
    laserFadeTimer = setTimeout(function () {
      laserFadeTimer = null;
      var live = false;
      var nowT = Date.now();
      var keys = Object.keys(laserUsers);
      for (var i = 0; i < keys.length && !live; i++) {
        var lu = laserUsers[keys[i]];
        if (!lu) continue;
        if (lu.active) { live = true; break; }
        for (var k = 0; k < lu.trail.length; k++) {
          if (nowT - lu.trail[k].t <= LASER_TRAIL_MS) { live = true; break; }
        }
      }
      if (live) { requestRender(); scheduleLaserFade(); }
    }, 50);
  }
  function drawLasers() {
    var nowT = Date.now();
    var keys = Object.keys(laserUsers);
    for (var i = 0; i < keys.length; i++) {
      var uidKey = keys[i];
      var lu = laserUsers[uidKey];
      if (!lu) continue;
      // 按时间过滤出存活轨迹点
      var pts = [];
      for (var k = 0; k < lu.trail.length; k++) {
        if (nowT - lu.trail[k].t <= LASER_TRAIL_MS) pts.push(lu.trail[k]);
      }
      // 松开后（active=false）不立即清空：残留轨迹继续渐隐；无残留点则跳过
      if (!lu.active && pts.length < 2) continue;
      var rgb = hexToRgb(laserColorOf(uidKey));
      // 逐渐消失的线：从旧到新逐段绘制，越旧越透明
      if (pts.length >= 2) {
        for (var j = 1; j < pts.length; j++) {
          var p0 = worldToScreen(pts[j - 1].x, pts[j - 1].y);
          var p1 = worldToScreen(pts[j].x, pts[j].y);
          var age0 = clamp(1 - (nowT - pts[j - 1].t) / LASER_TRAIL_MS, 0, 1);
          var age1 = clamp(1 - (nowT - pts[j].t) / LASER_TRAIL_MS, 0, 1);
          var a = 0.12 + 0.75 * (age0 + age1) / 2;
          ctx.strokeStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + a.toFixed(3) + ')';
          ctx.lineWidth = 3;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.stroke();
        }
      }
      // 头部圆点（仅按下/移动时显示）
      if (lu.active) {
        var s = worldToScreen(lu.x, lu.y);
        ctx.fillStyle = laserColorOf(uidKey);
        ctx.beginPath(); ctx.arc(s.x, s.y, 7, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        ctx.stroke();
        var nm = findUser(uidKey);
        if (nm) {
          ctx.font = '12px sans-serif';
          var tw = ctx.measureText(nm.name).width;
          ctx.fillStyle = 'rgba(0,0,0,0.7)';
          ctx.fillRect(s.x + 12, s.y - 26, tw + 8, 18);
          ctx.fillStyle = '#FFFFFF';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(nm.name, s.x + 16, s.y - 17);
        }
      }
    }
  }

  /* ================= 命中检测 ================= */
  function pointInRotatedRect(wx, wy, el) {
    var c = elCenter(el), s = elSize(el);
    var dx = wx - c.x, dy = wy - c.y;
    if (el.rotation) {
      var a = -el.rotation * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
      var rx = dx * cos - dy * sin, ry = dx * sin + dy * cos;
      dx = rx; dy = ry;
    }
    return Math.abs(dx) <= s.w / 2 + 6 / view.zoom && Math.abs(dy) <= s.h / 2 + 6 / view.zoom;
  }

  /* 点是否在选中元素编辑框（含 10px 外扩的旋转四边形）内 */
  function inEditBox(wx, wy, el) {
    var c = elCenter(el), s = elSize(el);
    var dx = wx - c.x, dy = wy - c.y;
    if (el.rotation) {
      var a = -el.rotation * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
      var rx = dx * cos - dy * sin, ry = dx * sin + dy * cos;
      dx = rx; dy = ry;
    }
    return Math.abs(dx) <= s.w / 2 + 10 / view.zoom && Math.abs(dy) <= s.h / 2 + 10 / view.zoom;
  }

  function hitTest(wx, wy) {
    var tol = 12 / view.zoom;
    for (var i = elements.length - 1; i >= 0; i--) {
      var el = elements[i];
      var t = el.type;
      if (t === 'pen') {
        var pts = el.points;
        for (var k = 0; k < pts.length - 1; k++) {
          if (segPointDist(wx, wy, pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]) <= tol) return el;
        }
        if (pts.length === 1 && dist2(wx, wy, pts[0][0], pts[0][1]) <= tol * tol) return el;
      } else if (t === 'line' || t === 'arrow') {
        if (segPointDist(wx, wy, el.x1, el.y1, el.x2, el.y2) <= tol) return el;
      } else if (t === 'rect' || t === 'text' || t === 'image' || t === 'circle') {
        if (pointInRotatedRect(wx, wy, el)) return el;
      }
    }
    return null;
  }

  function hitHandle(sx, sy, el) {
    return hitHandles(sx, sy, selectionHandles(el));
  }
  /* 通用手柄命中：角点=缩放，顶部圆点=旋转 */
  function hitHandles(sx, sy, h) {
    for (var i = 0; i < 4; i++) {
      if (dist2(sx, sy, h.corners[i].x, h.corners[i].y) <= 18 * 18) return 'resize';
    }
    if (dist2(sx, sy, h.rot.x, h.rot.y) <= 18 * 18) return 'rotate';
    return null;
  }

  /* ================= WebSocket ================= */
  function send(obj) {
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  }
  function connect() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    // 与 iOS9 正常示例一致：连接 /ws 不带查询参数，打开后在首条消息发送 hello 完成加入
    ws = new WebSocket(proto + location.host + '/ws');
    ws.onopen = function () {
      connected = true;
      setStatus('已连接');
      send({
        type: 'hello',
        room: PARAMS.room,
        pwd: PARAMS.pwd || '',
        key: PARAMS.key || '',
        ro: PARAMS.ro || '',
        name: PARAMS.name || ''
      });
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handleMsg(msg);
    };
    ws.onclose = function () {
      connected = false;
      if (roomGone || joinFailed) { location.href = 'index.html'; return; }
      setStatus('连接断开，正在重连…');
      setTimeout(connect, 3000);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  function handleMsg(msg) {
    switch (msg.type) {
      case 'join_result':
        joinFailed = true;
        setStatus('加入失败：' + (msg.error || '未知错误'));
        alert('加入失败：' + (msg.error || '未知错误'));
        break;

      case 'welcome':
        myUid = msg.self.uid; myName = msg.self.name; myColor = msg.self.color;
        readonly = !!msg.self.readonly;
        isOwner = !!msg.self.owner;
        roomInfo = msg.room;
        elements = msg.elements;
        users = msg.users;
        undoable = msg.undoable; redoable = msg.redoable;
        selectedId = null;
        selectedIds = [];
        captureOrigins();
        applyRoomUI();
        render();
        break;

      case 'state':
        elements = msg.elements;
        undoable = msg.undoable; redoable = msg.redoable;
        pruneSelection();
        captureOrigins();
        cleanupRemoteSelections();
        render();
        break;

      case 'element_added':
        if (indexOfId(elements, msg.element.id) < 0) {
          elements.push(msg.element);
          if (!origShapes[msg.element.id]) origShapes[msg.element.id] = deepCopy(msg.element);
        }
        render();
        break;

      case 'element_updated': {
        var el = getElementById(msg.id);
        if (el) {
          var p = msg.patch, k;
          for (k in p) { if (p.hasOwnProperty(k)) el[k] = p[k]; }
          render();
        }
        break;
      }

      case 'element_deleted': {
        var di = indexOfId(elements, msg.id);
        if (di >= 0) {
          elements.splice(di, 1);
          delete origShapes[msg.id];
          var si = selectedIds.indexOf(msg.id);
          if (si >= 0) selectedIds.splice(si, 1);
          if (selectedId === msg.id) selectedId = selectedIds.length ? selectedIds[selectedIds.length - 1] : null;
          updateSelInfo();
          cleanupRemoteSelections();
          render();
        }
        break;
      }

      case 'board_cleared':
        elements = [];
        origShapes = {};
        selectedId = null;
        selectedIds = [];
        updateSelInfo();
        cleanupRemoteSelections();
        render();
        break;

      case 'reordered':
        reorderLocal(msg.id, msg.action, true);
        break;

      case 'selection':
        if (msg.uid === myUid) break;
        if (msg.ids && msg.ids.length) remoteSelections[msg.uid] = msg.ids.slice();
        else delete remoteSelections[msg.uid];
        render();
        break;

      case 'user_joined':
        users.push(msg.user);
        renderUsers();
        break;

      case 'user_left': {
        var ui = -1;
        for (var i = 0; i < users.length; i++) { if (users[i].uid === msg.uid) { ui = i; break; } }
        if (ui >= 0) users.splice(ui, 1);
        delete remoteSelections[msg.uid];
        renderUsers();
        break;
      }

      case 'laser': {
        var lu = laserUsers[msg.uid];
        if (!lu) { lu = { x: 0, y: 0, active: false, trail: [] }; laserUsers[msg.uid] = lu; }
        // 从「松开」再次「按下」：立即清掉上一次残留轨迹；松开时不清空，让轨迹继续渐隐
        if (msg.active && !lu.active) lu.trail.length = 0;
        lu.x = msg.x; lu.y = msg.y; lu.active = msg.active;
        if (msg.active) {
          lu.trail.push({ x: msg.x, y: msg.y, t: Date.now() });
          if (lu.trail.length > 40) lu.trail.shift();
        }
        scheduleLaserFade();
        requestRender();
        break;
      }

      case 'room_renamed':
        roomInfo.name = msg.name;
        document.title = msg.name + ' - 共享白板';
        $('roomName').textContent = msg.name;
        break;

      case 'room_password_changed':
        roomInfo.pwd = msg.pwd || '';
        // 重建分享链接：房主带当前密码；访客不知新密码时链接不带密码（对方自行输入）
        shareBaseUrl = buildShareBaseUrl();
        if (isOwner) setStatus('访问密码已更新');
        break;

      case 'room_deleted':
        roomGone = true;
        try { localStorage.removeItem('wb_recent_colors'); } catch (e) {}
        alert('白板已被创建者删除');
        location.href = 'index.html';
        break;

      case 'pwd_kicked':
        roomGone = true;
        alert(msg.reason || '访问密码已更改，请重新输入密码');
        location.href = 'index.html';
        break;

      case 'pong':
        break;

      default:
        break;
    }
  }

  function cleanupRemoteSelections() {
    var rk = Object.keys(remoteSelections);
    for (var i = 0; i < rk.length; i++) {
      var rids = remoteSelections[rk[i]];
      var alive = false;
      if (rids) {
        for (var j = 0; j < rids.length; j++) {
          if (getElementById(rids[j])) { alive = true; break; }
        }
      }
      if (!alive) delete remoteSelections[rk[i]];
    }
  }

  /* 记录每个元素首次见到时的几何快照，供笔/直线/箭头「复位」到初始状态 */
  function captureOrigins() {
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (el && el.id && !origShapes[el.id]) origShapes[el.id] = deepCopy(el);
    }
  }

  /* 只读模式：直接显示只读应有的功能（隐藏一切编辑能力），
   * 进入页面时若 URL 带 ro=1 立即应用，避免先加载全部功能再隐藏 */
  function applyReadonlyUI() {
    $('roBadge').classList.remove('hidden');
    setStatus('只读模式：只能查看、缩放、激光指点');
    var btns = $('toolbar').children;
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].getAttribute('data-edit')) btns[i].classList.add('hidden');
    }
    // 顶部栏中标记 data-edit 的按钮与分隔线一并隐藏（只读时不留多余分割线）
    var topEdits = $('topbar').querySelectorAll('[data-edit]');
    for (var te = 0; te < topEdits.length; te++) topEdits[te].classList.add('hidden');
    $('btnUndo').classList.add('hidden');
    $('btnRedo').classList.add('hidden');
    $('btnClearTop').classList.add('hidden');
    $('btnCopy').classList.add('hidden');
    $('btnDelete').classList.add('hidden');
    $('btnPanelTop').classList.add('hidden');
    $('panel').classList.add('hidden');
    // 只读用户也有「退出」按钮（退出不影响白板内容）
    $('btnExit').classList.remove('hidden');
    // 只读用户只能分享只读链接：隐藏「可编辑」选项
    $('shareModeEditRow').classList.add('hidden');
    setTool('hand');
  }

  function applyRoomUI() {
    $('roomCode').textContent = roomInfo.id;
    $('roomName').textContent = roomInfo.name;
    document.title = roomInfo.name + ' - 共享白板';
    renderUsers();
    // 导入配置仅房主可用；导出配置 / 导出图片所有成员可用
    if (isOwner) $('btnImportCfg').classList.remove('hidden');
    else $('btnImportCfg').classList.add('hidden');
    // 创建者可点击房间名重命名
    if (isOwner) $('roomName').className = 'owner';
    else $('roomName').className = '';
    if (readonly) {
      applyReadonlyUI();
    } else {
      $('roBadge').classList.add('hidden');
      // 可编辑用户：编辑功能与「属性」按钮直接显示（防御性恢复，避免任何时序下被隐藏）
      var btns2 = $('toolbar').children;
      for (var j = 0; j < btns2.length; j++) {
        if (btns2[j].getAttribute('data-edit')) btns2[j].classList.remove('hidden');
      }
      var topEdits2 = $('topbar').querySelectorAll('[data-edit]');
      for (var te2 = 0; te2 < topEdits2.length; te2++) topEdits2[te2].classList.remove('hidden');
      $('btnUndo').classList.remove('hidden');
      $('btnRedo').classList.remove('hidden');
      $('btnClearTop').classList.remove('hidden');
      $('btnCopy').classList.remove('hidden');
      $('btnDelete').classList.remove('hidden');
      $('btnPanelTop').classList.remove('hidden');
      $('panel').classList.remove('hidden');
      $('shareModeEditRow').classList.remove('hidden');
      // 访问者 / 房主都有「退出」按钮
      $('btnExit').classList.remove('hidden');
    }
  }

  function renderUsers() {
    $('userCount').textContent = users.length + ' 人在线';
    var box = $('usersBox');
    if (users.length <= 1) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    // 创建者（房主）始终排第一位、红色标记
    var list = [];
    for (var i = 0; i < users.length; i++) { if (users[i].owner) list.push(users[i]); }
    for (var j = 0; j < users.length; j++) { if (!users[j].owner) list.push(users[j]); }
    var html = '';
    for (var k = 0; k < list.length; k++) {
      var u = list[k];
      // 房主标记颜色始终为红色（用户点颜色同样为红色）
      var dotColor = u.owner ? '#e53935' : u.color;
      var nmStyle = u.owner ? ' style="color:#e53935;font-weight:700"' : '';
      html += '<div class="u-row"><span class="u-dot" style="background:' + dotColor + '"></span>' +
        '<span' + nmStyle + '>' + escHtml(u.name) + '</span>' +
        (u.owner ? ' <span class="u-ro">[房主]</span>' : '') +
        (u.readonly ? ' <span class="u-ro">[只读]</span>' : '') + '</div>';
    }
    box.innerHTML = html;
  }

  function setStatus(s) { $('statusLine').textContent = s || ''; }

  /* ================= 工具切换 ================= */
  var TOOL_HINTS = {
    hand: '抓手：按住拖动平移画布',
    select: '选择：点选图案，或拖拽空白框选多个；画框移动，角点缩放，顶部圆点旋转/复位',
    pen: '画笔：按住拖动绘制',
    line: '直线：按住拖动绘制',
    arrow: '箭头：按住拖动绘制',
    rect: '矩形：按住拖动绘制',
    circle: '圆形：按住拖动绘制',
    text: '文本：点击画布，直接输入文字（双击可再次编辑）',
    image: '图片：从相册选择图片插入画布',
    bucket: '油漆桶：点击图案填充当前颜色',
    laser: '激光笔：移动指点，其他人可见'
  };
  function setTool(t) {
    if (inlineActive) commitInlineText(); // 切换工具前先提交未完成的内联文本
    tool = t;
    var btns = $('toolbar').children;
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      b.className = (b.getAttribute('data-tool') === t ? 'active' : '') +
        (b.className.indexOf('hidden') >= 0 ? ' hidden' : '') +
        (b.className.indexOf('disabled') >= 0 ? ' disabled' : '');
    }
    if (t !== 'select') setSelection(null);
    setStatus(TOOL_HINTS[t] || '');
    render();
  }
  $('toolbar').addEventListener('click', function (e) {
    if (inlineActive) commitInlineText();
    var b = e.target;
    while (b && b !== this && !b.getAttribute('data-tool')) b = b.parentNode;
    if (!b || !b.getAttribute('data-tool')) return;
    var t = b.getAttribute('data-tool');
    if (readonly && b.getAttribute('data-edit')) return;
    if (t === 'image') { showImgModal(); return; }
    setTool(t);
  });
  /* 顶部栏「清空」按钮（二次确认） */
  $('btnClearTop').addEventListener('click', confirmClear);
  /* 顶部「删除」：选中图案后点击才删除；「复制」：复制一份选中图案 */
  $('btnCopy').addEventListener('click', copySelected);
  $('btnDelete').addEventListener('click', deleteSelected);

  /* ================= 撤销 / 重做 / 层次 ================= */
  $('btnUndo').addEventListener('click', function () { send({ type: 'undo' }); });
  $('btnRedo').addEventListener('click', function () { send({ type: 'redo' }); });
  $('btnToFront').addEventListener('click', function () { if (selectedId) reorderLocal(selectedId, 'toFront', false); });
  $('btnForward').addEventListener('click', function () { if (selectedId) reorderLocal(selectedId, 'forward', false); });
  $('btnBackward').addEventListener('click', function () { if (selectedId) reorderLocal(selectedId, 'backward', false); });
  $('btnToBack').addEventListener('click', function () { if (selectedId) reorderLocal(selectedId, 'toBack', false); });

  function reorderLocal(id, action, isRemote) {
    var idx = indexOfId(elements, id);
    if (idx < 0) return;
    var el = elements.splice(idx, 1)[0];
    var ni = idx;
    if (action === 'toFront') ni = elements.length;
    else if (action === 'toBack') ni = 0;
    else if (action === 'forward') ni = Math.min(elements.length, idx + 1);
    else if (action === 'backward') ni = Math.max(0, idx - 1);
    else { elements.splice(idx, 0, el); return; }
    elements.splice(ni, 0, el);
    if (!isRemote) send({ type: 'reorder', id: id, action: action });
    render();
  }

  /* ================= 缩放（速度适中、放大缩小严格互逆） ================= */
  $('btnZoomIn').addEventListener('click', function () {
    setZoom(view.zoom * 1.15, window.innerWidth / 2, window.innerHeight / 2);
  });
  $('btnZoomOut').addEventListener('click', function () {
    setZoom(view.zoom / 1.15, window.innerWidth / 2, window.innerHeight / 2);
  });
  $('btnZoomLabel').addEventListener('click', function () { setZoom(1, window.innerWidth / 2, window.innerHeight / 2); });
  $('btnZoomFit').addEventListener('click', fitView);
  function fitView() {
    if (!elements.length) { setZoom(1, window.innerWidth / 2, window.innerHeight / 2); return; }
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    var any = false;
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (!el) continue;
      var c = elCenter(el), s = elSize(el);
      if (!isFinite(c.x) || !isFinite(c.y)) continue;
      any = true;
      minX = Math.min(minX, c.x - s.w / 2); maxX = Math.max(maxX, c.x + s.w / 2);
      minY = Math.min(minY, c.y - s.h / 2); maxY = Math.max(maxY, c.y + s.h / 2);
    }
    if (!any) { setZoom(1, window.innerWidth / 2, window.innerHeight / 2); return; }
    var bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
    var z = clamp(Math.min((window.innerWidth - 120) / bw, (window.innerHeight - 120) / bh), 0.1, 2);
    if (!isFinite(z)) z = 1;
    view.zoom = z;
    view.panX = (window.innerWidth - (minX + maxX) * z) / 2;
    view.panY = (window.innerHeight - (minY + maxY) * z) / 2;
    $('btnZoomLabel').textContent = Math.round(z * 100) + '%';
    render();
  }
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 16;      // 行模式归一化
    else if (e.deltaMode === 2) delta *= 100; // 页模式归一化
    // 指数因子严格互逆：放大再缩小同样次数能回到原位；速度放缓
    var factor = clamp(Math.exp(-delta * 0.001), 0.72, 1.39);
    setZoom(view.zoom * factor, e.clientX, e.clientY);
  }, false);

  /* ================= 颜色（常用色板 + RGB 三滑块 + 手动输入 hex）/ 透明度 / 线宽 / 字号 ================= */
  // 常用色：第一行 = 黑 灰 浅灰 红 蓝 绿；第二行 = 白 棕 橙 黄 紫 粉
  var PALETTE = ['#000000', '#616161', '#BDBDBD', '#E53935', '#1E88E5', '#43A047',
                 '#FFFFFF', '#6D4C41', '#FB8C00', '#FDD835', '#8E24AA', '#F06292'];
  var RECENT_KEY = 'wb_recent_colors';
  var recentColors = [];
  var lastStyleSend = 0;            // 属性实时调整广播节流时间戳
  var styleUndo = {};               // 样式调整撤销快照（id -> 调整前元素快照）

  function to2hex(v) {
    v = clamp(Math.round(v), 0, 255).toString(16);
    return v.length < 2 ? '0' + v : v;
  }
  function rgbToHex(r, g, b) { return '#' + to2hex(r) + to2hex(g) + to2hex(b); }
  function hexToRgb(c) {
    var s = String(c || '').replace('#', '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    var n = parseInt(s, 16);
    if (isNaN(n)) return { r: 0, g: 0, b: 0 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function syncRgbUI() {
    if (color === 'none') {
      // 旧数据元素可能带 'none' 填充：面板以黑色显示，透明度照常
      $('rgbR').value = 0; $('rgbG').value = 0; $('rgbB').value = 0;
      $('rgbPreview').className = 'rgb-preview';
      $('rgbPreview').style.background = '#000000';
      $('rgbHexInput').value = '#000000';
    } else {
      var rgb = hexToRgb(color);
      $('rgbR').value = rgb.r;
      $('rgbG').value = rgb.g;
      $('rgbB').value = rgb.b;
      $('rgbPreview').className = 'rgb-preview';
      $('rgbPreview').style.background = color;
      $('rgbHexInput').value = color.toUpperCase();
    }
    $('opacityRange').value = Math.round(opacity * 100);
    $('opacityVal').textContent = Math.round(opacity * 100) + '%';
    // RGB 滑块与透明度滑块数值更新后重绘渐变（左侧轨道颜色跟随当前值）
    paintRange($('rgbR'));
    paintRange($('rgbG'));
    paintRange($('rgbB'));
    paintRange($('opacityRange'));
  }
  /* 同步描边/填充目标按钮高亮与色板选中态（选中色块加选中框） */
  function syncColorUI() {
    $('btnColorStroke').className = colorTarget === 'stroke' ? 'active' : '';
    $('btnColorFill').className = colorTarget === 'fill' ? 'active' : '';
    var sw = $('palette').children;
    for (var i = 0; i < sw.length; i++) {
      var d = sw[i];
      var active = String(d.getAttribute('data-color') || '').toLowerCase() === String(color || '').toLowerCase();
      var cls = 'swatch';
      if (d.className.indexOf('empty') >= 0) cls += ' empty';
      if (active) cls += ' active';
      d.className = cls;
    }
  }

  function buildPalette() {
    var p = $('palette');
    for (var i = 0; i < PALETTE.length; i++) {
      (function (c) {
        var d = document.createElement('button');
        d.className = 'swatch' + (c === '#FFFFFF' ? ' empty' : '');
        d.style.background = c;
        d.setAttribute('data-color', c);
        d.addEventListener('click', function () { setColor(c, 'commit'); pushRecent(c); });
        p.appendChild(d);
      })(PALETTE[i]);
    }
    try { recentColors = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch (e) { recentColors = []; }
    if (!Array.isArray(recentColors)) recentColors = [];
    renderRecent();
    syncColorUI();
  }
  function renderRecent() {
    var r = $('recentRow');
    r.innerHTML = '';
    if (!recentColors.length) {
      var em = document.createElement('span');
      em.className = 'swatch empty';
      em.style.background = '#fff';
      em.style.opacity = '0.4';
      r.appendChild(em);
      return;
    }
    for (var i = 0; i < recentColors.length; i++) {
      (function (c) {
        var d = document.createElement('button');
        d.className = 'swatch' + (c === '#FFFFFF' ? ' empty' : '');
        d.style.background = c;
        d.addEventListener('click', function () { setColor(c, 'commit'); });
        r.appendChild(d);
      })(recentColors[i]);
    }
  }
  function pushRecent(c) {
    var arr = [c];
    for (var i = 0; i < recentColors.length; i++) {
      if (recentColors[i].toLowerCase() !== c.toLowerCase()) arr.push(recentColors[i]);
    }
    recentColors = arr.slice(0, 6);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recentColors)); } catch (e) {}
    renderRecent();
  }
  /* 设置当前颜色：mode = 'none'(仅面板) | 'live'(实时预览,节流非 commit) | 'commit'(应用并记录撤销) */
  function setColor(c, mode) {
    color = c;
    if (colorTarget === 'fill') fillColor = c;
    else strokeColor = c;
    syncColorUI();
    syncRgbUI();
    if (mode === 'live' || mode === 'commit') applyColorToSelection(mode === 'commit');
  }
  /* 切换描边 / 填充调整目标 */
  function setColorTarget(t) {
    colorTarget = t;
    color = (t === 'fill') ? fillColor : strokeColor;
    syncColorUI();
    syncRgbUI();
  }
  $('btnColorStroke').addEventListener('click', function () { setColorTarget('stroke'); });
  $('btnColorFill').addEventListener('click', function () { setColorTarget('fill'); });

  var rgbR = $('rgbR'), rgbG = $('rgbG'), rgbB = $('rgbB');
  function colorFromSliders() { return rgbToHex(Number(rgbR.value), Number(rgbG.value), Number(rgbB.value)); }
  rgbR.addEventListener('input', function () { setColor(colorFromSliders(), 'live'); });
  rgbG.addEventListener('input', function () { setColor(colorFromSliders(), 'live'); });
  rgbB.addEventListener('input', function () { setColor(colorFromSliders(), 'live'); });
  rgbR.addEventListener('change', function () { pushRecent(colorFromSliders()); setColor(colorFromSliders(), 'commit'); });
  rgbG.addEventListener('change', function () { pushRecent(colorFromSliders()); setColor(colorFromSliders(), 'commit'); });
  rgbB.addEventListener('change', function () { pushRecent(colorFromSliders()); setColor(colorFromSliders(), 'commit'); });
  /* 自定义颜色手动输入：#RRGGBB / #RGB */
  $('rgbHexInput').addEventListener('change', function () {
    var raw = String(this.value).trim();
    var v = raw.replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(v) || /^[0-9a-fA-F]{3}$/.test(v)) {
      setColor('#' + v.toLowerCase(), 'commit');
    } else {
      setStatus('颜色格式应为 #RRGGBB');
      syncRgbUI();
    }
  });
  $('rgbHexInput').addEventListener('keydown', function (e) {
    if (e.keyCode === 13) { e.preventDefault(); this.blur(); }
  }, false);

  /* ================= 滑块（range）：已滑过部分着色 + 点击轨道跳值（iPad 兼容） ================= */
  function paintRange(input) {
    if (!input || input.type !== 'range') return;
    var min = Number(input.min) || 0, max = Number(input.max) || 100;
    var v = Number(input.value);
    var pct = Math.max(0, Math.min(100, (max > min) ? (v - min) / (max - min) * 100 : 0));
    input.style.backgroundImage = 'linear-gradient(to right, #1e88e5 0%, #1e88e5 ' + pct + '%, #d5dbe3 ' + pct + '%, #d5dbe3 100%)';
  }
  function setupRange(input) {
    if (!input || input.type !== 'range') return;
    paintRange(input);
    // dragged：本次按下期间值是否已被拖动/原生跳值改过。拖动结束浏览器会合成 click，
    // 若再按松手位置跳一次值会导致「按下 32% 松开 24%」；已改过值则跳过 click 跳值。
    var dragged = false, dragTimer = null;
    function markDragged() {
      dragged = true;
      if (dragTimer) clearTimeout(dragTimer);
      dragTimer = setTimeout(function () { dragged = false; }, 400);
    }
    input.addEventListener('input', function () { markDragged(); paintRange(input); }, false);
    input.addEventListener('change', function () { paintRange(input); }, false);
    // 点击轨道直接跳值（iPad 上 -webkit-appearance:none 后点击轨道可能无效，这里兜底）
    input.addEventListener('click', function (e) {
      if (dragged) { dragged = false; return; } // 拖动/已改过值，不再跳
      var r = input.getBoundingClientRect();
      if (!r || !r.width) return;
      var pct = (e.clientX - r.left) / r.width;
      var min = Number(input.min) || 0, max = Number(input.max) || 100;
      var v = min + pct * (max - min);
      var cur = Number(input.value);
      if (Math.abs(v - cur) < 0.5) return; // 点击在圆点上（值几乎不变），避免重复触发
      input.value = Math.round(v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, false);
  }
  var setupRangeIds = ['opacityRange', 'widthRange', 'fontRange', 'rgbR', 'rgbG', 'rgbB'];
  for (var sri = 0; sri < setupRangeIds.length; sri++) setupRange($(setupRangeIds[sri]));

  var opacityRange = $('opacityRange');
  opacityRange.addEventListener('input', function () {
    opacity = Number(opacityRange.value) / 100;
    $('opacityVal').textContent = opacityRange.value + '%';
    applyStyleToSelection('opacity', opacity, false);
  });
  opacityRange.addEventListener('change', function () { applyStyleToSelection('opacity', opacity, true); });
  var widthRange = $('widthRange');
  widthRange.addEventListener('input', function () {
    strokeWidth = Number(widthRange.value);
    $('widthVal').textContent = strokeWidth;
    applyStyleToSelection('strokeWidth', strokeWidth, false);
  });
  widthRange.addEventListener('change', function () { applyStyleToSelection('strokeWidth', strokeWidth, true); });
  var fontRange = $('fontRange');
  fontRange.addEventListener('input', function () {
    fontSize = Number(fontRange.value);
    $('fontVal').textContent = fontSize;
    applyStyleToSelection('fontSize', fontSize, false);
  });
  fontRange.addEventListener('change', function () { applyStyleToSelection('fontSize', fontSize, true); });

  /* ================= 选中图案属性实时调整（需求：颜色/透明度/线宽/字号；图片仅透明度） ================= */
  /* 记录选中元素的调整前快照（一次调整过程只记一次，供提交时撤销） */
  function noteStyleUndo() {
    if (!selectedIds.length) return;
    for (var i = 0; i < selectedIds.length; i++) {
      var el = getElementById(selectedIds[i]);
      if (el && !styleUndo[el.id]) styleUndo[el.id] = deepCopy(el);
    }
  }
  /* 把当前面板颜色应用到选中元素（按元素类型过滤：填充仅矩形/圆形，其余回退描边；图片不着色） */
  function applyColorToSelection(commit) {
    if (!selectedIds.length) return;
    noteStyleUndo();
    var sends = [];
    for (var i = 0; i < selectedIds.length; i++) {
      var el = getElementById(selectedIds[i]);
      if (!el) continue;
      var patch = {};
      if (colorTarget === 'fill') {
        if (el.type === 'rect' || el.type === 'circle') patch.fill = color;
        else if (el.type !== 'image') patch.stroke = color; // 无填充能力的图案回退描边，保证切换始终生效
      } else {
        if (el.type !== 'image') patch.stroke = color;
      }
      var ks = Object.keys(patch);
      if (!ks.length) continue;
      for (var k = 0; k < ks.length; k++) el[ks[k]] = patch[ks[k]];
      sends.push({ id: el.id, patch: patch });
    }
    if (!sends.length) return;
    if (!commit) {
      var t = Date.now();
      if (t - lastStyleSend < 50) return;
      lastStyleSend = t;
    }
    for (var s = 0; s < sends.length; s++) {
      send({ type: 'update', id: sends[s].id, patch: sends[s].patch, commit: commit,
        undo: commit ? (styleUndo[sends[s].id] || null) : undefined });
    }
    if (commit) styleUndo = {};
    render();
  }
  /* 把面板数值（透明度/线宽/字号）应用到选中元素 */
  function applyStyleToSelection(field, value, commit) {
    if (!selectedIds.length) return;
    noteStyleUndo();
    var sends = [];
    for (var i = 0; i < selectedIds.length; i++) {
      var el = getElementById(selectedIds[i]);
      if (!el) continue;
      var ok = (field === 'opacity') ? true
        : (field === 'strokeWidth') ? (el.type !== 'text' && el.type !== 'image')
        : (field === 'fontSize') ? (el.type === 'text') : false;
      if (!ok) continue;
      el[field] = value;
      var patch = {}; patch[field] = value;
      if (field === 'fontSize' && el.type === 'text') {
        // 字号变化同步重算文本包围盒（选择框随之变化）
        ctx.font = value + 'px sans-serif';
        var tlines = String(el.text || '').split('\n');
        var tmaxW = 10;
        for (var ti = 0; ti < tlines.length; ti++) {
          var tw = ctx.measureText(tlines[ti]).width;
          if (tw > tmaxW) tmaxW = tw;
        }
        el.w = tmaxW + 2;
        el.h = tlines.length * value * 1.3;
        patch.w = el.w;
        patch.h = el.h;
      }
      sends.push({ id: el.id, patch: patch });
    }
    if (!sends.length) return;
    if (!commit) {
      var t = Date.now();
      if (t - lastStyleSend < 50) return;
      lastStyleSend = t;
    }
    for (var s = 0; s < sends.length; s++) {
      send({ type: 'update', id: sends[s].id, patch: sends[s].patch, commit: commit,
        undo: commit ? (styleUndo[sends[s].id] || null) : undefined });
    }
    if (commit) styleUndo = {};
    render();
  }
  /* 选中元素后：把面板控件同步为元素当前属性；并按类型显隐线宽/字号/描边填充 */
  function syncPanelFromSelection() {
    if (selectedIds.length === 1) {
      var el = getElementById(selectedId);
      if (!el) return;
      if (el.opacity !== undefined && el.opacity !== null) {
        opacity = el.opacity;
        $('opacityRange').value = Math.round(opacity * 100);
        $('opacityVal').textContent = Math.round(opacity * 100) + '%';
      }
      if (el.strokeWidth !== undefined && el.strokeWidth !== null && el.type !== 'text' && el.type !== 'image') {
        strokeWidth = el.strokeWidth;
        $('widthRange').value = strokeWidth;
        $('widthVal').textContent = strokeWidth;
      }
      if (el.fontSize !== undefined && el.fontSize !== null) {
        fontSize = el.fontSize;
        $('fontRange').value = fontSize;
        $('fontVal').textContent = fontSize;
      }
      // 面板控件显隐：图片只透明度；文本只字号；画笔/直线/箭头/矩形/圆形只线宽
      var isImage = el.type === 'image';
      var isText = el.type === 'text';
      $('fontCtrl').className = isImage || !isText ? 'ctrl hidden' : 'ctrl';
      $('widthCtrl').className = isImage || isText ? 'ctrl hidden' : 'ctrl';
      // 描边/填充目标按钮：仅矩形/圆形需要
      $('colorTargetCtrls').style.display = (el.type === 'rect' || el.type === 'circle') ? '' : 'none';
      if (el.type === 'rect' || el.type === 'circle') {
        strokeColor = (el.stroke && el.stroke !== 'none') ? el.stroke : '#000000';
        fillColor = (el.fill && el.fill !== 'none') ? el.fill : 'none';
        color = (colorTarget === 'fill') ? fillColor : strokeColor;
      } else {
        // 非矩形/圆形：单一颜色（描边），颜色目标强制切回描边，避免残留 fill 目标导致改色失效/透明度异常
        strokeColor = (el.stroke && el.stroke !== 'none') ? el.stroke : '#000000';
        colorTarget = 'stroke';
        color = strokeColor;
      }
      syncColorUI();
      syncRgbUI();
      // 面板数值更新后重绘滑块渐变（已滑过部分着色跟随当前值）
      paintRange($('opacityRange'));
      paintRange($('widthRange'));
      paintRange($('fontRange'));
    } else {
      // 未选中 / 多选：恢复线宽、字号显示；恢复描边/填充目标按钮（供绘制前预设）
      $('fontCtrl').className = 'ctrl';
      $('widthCtrl').className = 'ctrl';
      $('colorTargetCtrls').style.display = '';
      // 颜色目标切回描边：保证新建图案使用当前选中的颜色（避免残留 fill 目标导致新建图案颜色无法修改）
      colorTarget = 'stroke';
      color = strokeColor;
      syncColorUI();
      syncRgbUI();
    }
  }

  /* ================= 右侧面板折叠（收起后隐藏，展开入口在顶部栏「属性」按钮） ================= */
  function togglePanel() {
    var p = $('panel');
    var collapsed = p.className.indexOf('collapsed') >= 0;
    if (collapsed) p.className = p.className.replace(/\bcollapsed\b/g, '').replace(/\s+/g, ' ').trim();
    else p.className += ' collapsed';
    var open = collapsed;
    $('btnPanelToggle').textContent = open ? '收起' : '展开';
    $('btnPanelTop').className = open ? 'active' : '';
  }
  $('btnPanelToggle').addEventListener('click', togglePanel);
  $('btnPanelTop').addEventListener('click', togglePanel);
  $('btnPanelTop').className = 'active'; // 初始面板展开

  /* ================= 隐藏工具栏：隐藏所有菜单，右上角浮层保留「显示工具栏」与「全屏」 ================= */
  function inPresent() {
    return document.body.className.indexOf('wb-present') >= 0;
  }
  function setPresent(on) {
    var c = document.body.className;
    if (on) {
      if (c.indexOf('wb-present') < 0) document.body.className = (c + ' wb-present').replace(/\s+/g, ' ').trim();
    } else {
      document.body.className = c.replace(/\bwb-present\b/g, '').replace(/\s+/g, ' ').trim();
    }
    $('btnFullscreen').textContent = on ? '显示工具栏' : '隐藏工具栏';
    if (on) {
      $('presentActions').classList.remove('hidden');
    } else {
      $('presentActions').classList.add('hidden');
    }
    setStatus(on ? '已隐藏所有工具栏，按 Esc 或点「显示工具栏」恢复' : '');
    render();
  }
  $('btnFullscreen').addEventListener('click', function () { setPresent(!inPresent()); });
  $('btnExitPresent').addEventListener('click', function () { setPresent(false); });
  // Esc 退出「隐藏工具栏」模式（独立监听，不受弹窗遮挡影响）
  window.addEventListener('keydown', function (e) {
    if (e.keyCode === 27 && inPresent()) { e.preventDefault(); setPresent(false); }
  }, false);

  /* ================= 浏览器全屏（F11，Fullscreen API，带旧前缀降级） ================= */
  function inBrowserFull() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement ||
      document.mozFullScreenElement || document.msFullscreenElement);
  }
  function requestBrowserFull() {
    var el = document.documentElement;
    var fn = el.requestFullscreen || el.webkitRequestFullscreen ||
      el.mozRequestFullScreen || el.msRequestFullscreen;
    if (!fn) { setStatus('当前浏览器不支持全屏'); return; }
    try {
      var p = fn.call(el);
      // 全屏请求可能被浏览器拒绝（需用户手势激活），处理异步拒绝避免未捕获异常
      if (p && p.catch) p.catch(function () { setStatus('浏览器未允许全屏，请使用浏览器菜单或按 F11'); });
    } catch (e) { setStatus('全屏请求被拒绝'); }
  }
  function exitBrowserFull() {
    var fn = document.exitFullscreen || document.webkitExitFullscreen ||
      document.mozCancelFullScreen || document.msExitFullscreen;
    if (fn) {
      try {
        var p = fn.call(document);
        if (p && p.catch) p.catch(function () {});
      } catch (e) {}
    }
  }
  function updateBrowserFullBtn() {
    var on = inBrowserFull();
    var label = on ? '退出全屏' : '全屏';
    $('btnBrowserFull').textContent = label;
    $('btnBrowserFull').title = label;
    // 隐藏工具栏浮层上的全屏按钮同步状态
    $('btnPresentFull').textContent = label;
    $('btnPresentFull').title = label;
  }
  $('btnBrowserFull').addEventListener('click', function () {
    if (inBrowserFull()) exitBrowserFull();
    else requestBrowserFull();
  });
  $('btnPresentFull').addEventListener('click', function () {
    if (inBrowserFull()) exitBrowserFull();
    else requestBrowserFull();
  });
  document.addEventListener('fullscreenchange', updateBrowserFullBtn, false);
  document.addEventListener('webkitfullscreenchange', updateBrowserFullBtn, false);
  document.addEventListener('mozfullscreenchange', updateBrowserFullBtn, false);
  document.addEventListener('MSFullscreenChange', updateBrowserFullBtn, false);

  /* ================= 手势处理（鼠标 + 触摸统一） ================= */
  canvas.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    onDown(e.clientX, e.clientY);
  }, false);
  window.addEventListener('mousemove', function (e) { onMove(e.clientX, e.clientY); }, false);
  window.addEventListener('mouseup', function () { onUp(); }, false);

  /* 双击文本：再次进入内联编辑（仅选择工具；编辑中不响应） */
  canvas.addEventListener('dblclick', function (e) {
    if (readonly || inlineActive || tool !== 'select') return;
    var M = screenToWorld(e.clientX, e.clientY);
    var el = hitTest(M.x, M.y);
    if (el && el.type === 'text') {
      drag = null;
      startInlineText(el.x, el.y, el);
    }
  }, false);

  /* iPad 双击检测（Safari 触摸不合成 dblclick）：两次 tap 间隔短且位置近 → 编辑文本 */
  var lastTapT = 0, lastTapX = 0, lastTapY = 0;
  addEvt(canvas, 'touchstart', function (e) {
    e.preventDefault();
    if (e.touches.length >= 2) { startPinch(e); return; }
    var t = e.touches[0];
    var now = Date.now();
    if (!readonly && !inlineActive && tool === 'select' &&
        now - lastTapT < 350 && Math.abs(t.clientX - lastTapX) < 20 && Math.abs(t.clientY - lastTapY) < 20) {
      lastTapT = 0;
      var M2 = screenToWorld(t.clientX, t.clientY);
      var el2 = hitTest(M2.x, M2.y);
      if (el2 && el2.type === 'text') {
        drag = null;
        startInlineText(el2.x, el2.y, el2);
        return;
      }
    }
    lastTapT = now; lastTapX = t.clientX; lastTapY = t.clientY;
    onDown(t.clientX, t.clientY);
  });
  addEvt(canvas, 'touchmove', function (e) {
    e.preventDefault();
    if (drag && drag.mode === 'pinch') { doPinch(e); return; }
    if (e.touches.length >= 2) { startPinch(e); return; }
    var t = e.touches[0];
    onMove(t.clientX, t.clientY);
  });
  addEvt(canvas, 'touchend', function (e) {
    e.preventDefault();
    if (drag && drag.mode === 'pinch') { drag = null; return; }
    if (e.touches.length > 0) {
      var t = e.touches[0];
      onMove(t.clientX, t.clientY);
    }
    onUp();
  });
  addEvt(canvas, 'touchcancel', function (e) {
    e.preventDefault();
    if (drag && drag.mode === 'pinch') { drag = null; return; }
    onUp();
  });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); }, false);

  // 阻止页面滚动/橡皮筋回弹（弹窗、面板与内联文本输入框内放行，便于滚动与输入）
  document.addEventListener('touchmove', function (e) {
    var t = e.target;
    while (t && t !== document.body) {
      var cn = t.className ? String(t.className) : '';
      if (cn.indexOf('modal-box') >= 0) return;
      if (t.id === 'toolbar' || t.id === 'topbar' || t.id === 'panel' || t.id === 'inlineText') return;
      t = t.parentNode;
    }
    e.preventDefault();
  }, false);

  function startPinch(e) {
    var t0 = e.touches[0], t1 = e.touches[1];
    drag = {
      mode: 'pinch',
      lastDist: dist(t0.clientX, t0.clientY, t1.clientX, t1.clientY),
      lastMx: (t0.clientX + t1.clientX) / 2,
      lastMy: (t0.clientY + t1.clientY) / 2
    };
  }
  function doPinch(e) {
    if (e.touches.length < 2) return;
    var t0 = e.touches[0], t1 = e.touches[1];
    var d = dist(t0.clientX, t0.clientY, t1.clientX, t1.clientY);
    var mx = (t0.clientX + t1.clientX) / 2, my = (t0.clientY + t1.clientY) / 2;
    if (drag.lastDist && drag.lastDist > 0) {
      view.panX += mx - drag.lastMx;
      view.panY += my - drag.lastMy;
      // 捏合缩放加阻尼，避免速度过快
      setZoom(view.zoom * Math.pow(d / drag.lastDist, 0.75), mx, my);
    }
    drag.lastDist = d; drag.lastMx = mx; drag.lastMy = my;
  }

  function onDown(sx, sy) {
    if (!connected) return;
    // 内联文本输入中：点击画布先提交文本（本次点击不触发其它动作，避免覆盖输入内容）
    if (inlineActive) { commitInlineText(); return; }
    var w = screenToWorld(sx, sy);

    if (tool === 'laser') {
      drag = { mode: 'laser' };
      // 再次点击：立即清掉本地残留轨迹（远端用户的轨迹由广播消息中的 active 跳变清除）
      var lme = laserUsers[myUid];
      if (lme) lme.trail.length = 0;
      sendLaser(w.x, w.y, true);
      return;
    }
    if (readonly && tool !== 'hand' && tool !== 'select') return;

    lastPointer = { x: sx, y: sy };

    if (tool === 'hand') { drag = { mode: 'pan' }; return; }

    if (tool === 'select') {
      // 多选组：命中组编辑框手柄 → 整体缩放 / 旋转
      if (selectedIds.length > 1) {
        var gh = groupHandles();
        var ghh = hitHandles(sx, sy, gh);
        if (ghh === 'resize') {
          drag = { mode: 'resize', group: true, ids: selectedIds.slice(), snaps: snapGroup(), rk: resizeStartDataFromHandles(gh, sx, sy) };
          return;
        }
        if (ghh === 'rotate') {
          drag = { mode: 'rotate', group: true, ids: selectedIds.slice(), snaps: snapGroup(), sx: sx, sy: sy, click: true, baseAng: Math.atan2(sy - gh.center.y, sx - gh.center.x) };
          return;
        }
      }
      // 单选：主选中元素的手柄
      if (selectedId) {
        var sel = getElementById(selectedId);
        if (sel) {
          var h = hitHandle(sx, sy, sel);
          if (h === 'resize') {
            drag = { mode: 'resize', id: sel.id, undo: deepCopy(sel), rk: resizeStartData(sel, sx, sy) };
            return;
          }
          if (h === 'rotate') {
            var c1 = elCenter(sel), sc1 = worldToScreen(c1.x, c1.y);
            drag = { mode: 'rotate', id: sel.id, sx: sx, sy: sy, click: true, baseAng: Math.atan2(sy - sc1.y, sx - sc1.x), undo: deepCopy(sel) };
            return;
          }
        }
      }
      // 选中后：鼠标在选中图案的编辑框（旋转四边形）内即可拖动，不必精确点到图案上
      if (selectedIds.length === 1 && selectedId) {
        var s1 = getElementById(selectedId);
        if (s1 && inEditBox(w.x, w.y, s1)) {
          if (!readonly) drag = { mode: 'move', id: s1.id, undo: deepCopy(s1) };
          return;
        }
      }
      // 多选：鼠标在组编辑框内（非手柄）即可整体拖动
      if (selectedIds.length > 1) {
        var gb = groupWorldBox();
        if (w.x >= gb.x - gb.w / 2 && w.x <= gb.x + gb.w / 2 &&
            w.y >= gb.y - gb.h / 2 && w.y <= gb.y + gb.h / 2) {
          drag = { mode: 'move', group: true, ids: selectedIds.slice(), snaps: snapGroup() };
          return;
        }
      }
      var el = hitTest(w.x, w.y);
      if (el) {
        // 点中组内元素 → 移动整个组；点中组外元素 → 单选并移动
        if (selectedIds.indexOf(el.id) >= 0 && selectedIds.length > 1) {
          drag = { mode: 'move', group: true, ids: selectedIds.slice(), snaps: snapGroup() };
        } else {
          setSelection(el.id);
          if (!readonly) drag = { mode: 'move', id: el.id, undo: deepCopy(el) };
        }
      } else {
        // 空白处：清空选择并开始框选（未拖动则保持无选择）
        setSelection(null);
        drag = { mode: 'marquee', x0: sx, y0: sy, wx0: w.x, wy0: w.y, moved: false };
      }
      return;
    }

    if (tool === 'pen') {
      var penEl = { id: uid(), type: 'pen', points: [[w.x, w.y]], stroke: strokeColor, strokeWidth: strokeWidth, opacity: opacity };
      elements.push(penEl);
      setSelection(null);
      drag = { mode: 'pen', el: penEl, undo: deepCopy(penEl) };
      sendAddLive(penEl); // 创建过程实时显示给访问者（live 不记录撤销，完成时统一提交）
      render();
      return;
    }
    if (tool === 'line' || tool === 'arrow') {
      var lnEl = { id: uid(), type: tool, x1: w.x, y1: w.y, x2: w.x, y2: w.y, stroke: strokeColor, strokeWidth: strokeWidth, opacity: opacity };
      elements.push(lnEl);
      setSelection(null);
      drag = { mode: 'line', el: lnEl, undo: deepCopy(lnEl) };
      sendAddLive(lnEl);
      render();
      return;
    }
    if (tool === 'rect' || tool === 'circle') {
      var shEl = { id: uid(), type: tool, x: w.x, y: w.y, w: 0, h: 0, stroke: strokeColor, strokeWidth: strokeWidth, opacity: opacity, fill: (fillColor && fillColor !== 'none') ? fillColor : 'none', rotation: 0 };
      elements.push(shEl);
      setSelection(null);
      drag = { mode: 'rect', el: shEl, wx0: w.x, wy0: w.y, undo: deepCopy(shEl) };
      sendAddLive(shEl);
      render();
      return;
    }
    if (tool === 'text') { startInlineText(w.x, w.y); return; }
    if (tool === 'bucket') {
      var h2 = hitTest(w.x, w.y);
      if (h2) applyBucket(h2);
      return;
    }
    if (tool === 'image') { showImgModal(); return; }
  }

  function onMove(sx, sy) {
    var w = screenToWorld(sx, sy);
    if (!drag) return;
    var d = drag;

    if (d.mode === 'pan') {
      view.panX += sx - lastPointer.x;
      view.panY += sy - lastPointer.y;
      lastPointer = { x: sx, y: sy };
      render();
      return;
    }
    if (d.mode === 'pen') {
      addPenPoint(d.el, w.x, w.y);
      throttleSendUpdate(d.el.id, false); // 创建过程实时广播
      return;
    }
    if (d.mode === 'line') {
      d.el.x2 = w.x; d.el.y2 = w.y;
      throttleSendUpdate(d.el.id, false);
      render();
      return;
    }
    if (d.mode === 'rect') {
      d.el.x = (d.wx0 + w.x) / 2;
      d.el.y = (d.wy0 + w.y) / 2;
      d.el.w = Math.abs(w.x - d.wx0);
      d.el.h = Math.abs(w.y - d.wy0);
      throttleSendUpdate(d.el.id, false);
      render();
      return;
    }
    if (d.mode === 'move') {
      var dx = (sx - lastPointer.x) / view.zoom;
      var dy = (sy - lastPointer.y) / view.zoom;
      if (d.group) {
        for (var gi = 0; gi < d.ids.length; gi++) moveElementBy(d.ids[gi], dx, dy);
        throttleSendGroupUpdate(d.ids, false);
      } else {
        moveElementBy(d.id, dx, dy);
        throttleSendUpdate(d.id, false);
      }
      lastPointer = { x: sx, y: sy };
      return;
    }
    if (d.mode === 'resize') { doResize(d, sx, sy); return; }
    if (d.mode === 'rotate') { doRotate(d, sx, sy); return; }
    if (d.mode === 'marquee') {
      // 拖动超过阈值才算框选
      if (!d.moved && dist(sx, sy, d.x0, d.y0) > 3) d.moved = true;
      if (d.moved) { lastPointer = { x: sx, y: sy }; render(); }
      return;
    }
    if (d.mode === 'laser') {
      sendLaser(w.x, w.y, true);
      return;
    }
  }

  function onUp() {
    if (!drag) return;
    var d = drag;
    drag = null;
    if (d.mode === 'pen' || d.mode === 'line') {
      sendUpdateCommit(d.el.id, d.undo);
      origShapes[d.el.id] = deepCopy(d.el); // 本地绘制完成即记录初始几何，供复位恢复原始形状
    }
    else if (d.mode === 'rect') {
      // 点击（未拖拽）产生 0 尺寸矩形/圆形：给一个最小尺寸，保证可见
      if (d.el.w < 4 && d.el.h < 4) {
        var ms = Math.max(8, (d.el.strokeWidth || 4) * 2);
        d.el.w = ms; d.el.h = ms;
      }
      sendUpdateCommit(d.el.id, d.undo);
      origShapes[d.el.id] = deepCopy(d.el);
    }
    else if (d.mode === 'marquee') {
      // 框选落定：按选择矩形（世界坐标）选中相交的全部元素
      if (d.moved) {
        var w = screenToWorld(lastPointer.x, lastPointer.y);
        var rx = Math.min(d.wx0, w.x), ry = Math.min(d.wy0, w.y);
        var rw = Math.abs(w.x - d.wx0), rh = Math.abs(w.y - d.wy0);
        var ids = elementsInRect({ x: rx, y: ry, w: rw, h: rh });
        if (ids.length) {
          setSelectionMulti(ids);
          setStatus('已框选 ' + ids.length + ' 个图案');
        } else {
          setStatus('框选范围内没有图案');
        }
      }
    }
    else if (d.mode === 'rotate' && d.click) {
      // 单击旋转圆圈：复位为初始尺寸与角度（当前位置/中点/中心保持不变）
      var anyChanged = false;
      if (d.group) {
        for (var ri = 0; ri < d.ids.length; ri++) {
          var gEl = getElementById(d.ids[ri]);
          if (gEl && resetElement(gEl)) {
            sendUpdateCommit(gEl.id, d.snaps[gEl.id]);
            anyChanged = true;
          }
        }
      } else {
        var rel = getElementById(d.id);
        if (rel && resetElement(rel)) {
          sendUpdateCommit(d.id, d.undo);
          anyChanged = true;
        }
      }
      if (anyChanged) setStatus('已复位为原始尺寸');
      render();
    }
    else if (d.mode === 'move') {
      // 组移动：逐元素提交（携带各自按下时快照供撤销）
      if (d.group) {
        for (var mi = 0; mi < d.ids.length; mi++) {
          var mEl = getElementById(d.ids[mi]);
          if (mEl) sendUpdateCommit(mEl.id, d.snaps[mEl.id]);
        }
      } else {
        sendUpdateCommit(d.id, d.undo);
      }
    }
    else if (d.mode === 'resize') {
      // 缩放无变化（如文本字号越界定格）时不发空提交
      if (!d.changed) { render(); return; }
      if (d.group) {
        for (var si2 = 0; si2 < d.ids.length; si2++) {
          var sEl = getElementById(d.ids[si2]);
          if (sEl) sendUpdateCommit(sEl.id, d.snaps[sEl.id]);
        }
      } else {
        sendUpdateCommit(d.id, d.undo);
      }
    }
    else if (d.mode === 'rotate') {
      // 真实旋转拖动的提交（单击旋转圈复位已在上方 click 分支处理）
      if (d.group) {
        for (var ri2 = 0; ri2 < d.ids.length; ri2++) {
          var rEl = getElementById(d.ids[ri2]);
          if (rEl) sendUpdateCommit(rEl.id, d.snaps[rEl.id]);
        }
      } else {
        sendUpdateCommit(d.id, d.undo);
      }
    }
    else if (d.mode === 'laser') sendLaser(0, 0, false);
    render();
  }

  /* 复位单个元素：恢复原始尺寸与角度，当前位置（中心/中点/坐标）保持不变。
     返回是否有实际变化。笔/直线/箭头旋转后也能复位（恢复原始方向）。 */
  function resetElement(rel) {
    var o = origShapes[rel.id];
    if (!o) return false;
    var changed = false;
    if (rel.type === 'line' || rel.type === 'arrow') {
      // 恢复原始长度与方向，保持当前中点（坐标/位置不变）；
      // 端点顺序与原始一致（x1 在原始方向的反侧），避免箭头方向被翻转
      var mx = (rel.x1 + rel.x2) / 2, my = (rel.y1 + rel.y2) / 2;
      var origAng = Math.atan2(o.y2 - o.y1, o.x2 - o.x1);
      var origLen = Math.max(1, dist(o.x2, o.y2, o.x1, o.y1));
      var nx1 = mx - Math.cos(origAng) * origLen / 2, ny1 = my - Math.sin(origAng) * origLen / 2;
      var nx2 = mx + Math.cos(origAng) * origLen / 2, ny2 = my + Math.sin(origAng) * origLen / 2;
      if (Math.abs(nx1 - rel.x1) > 0.01 || Math.abs(ny1 - rel.y1) > 0.01 ||
          Math.abs(nx2 - rel.x2) > 0.01 || Math.abs(ny2 - rel.y2) > 0.01) {
        rel.x1 = nx1; rel.y1 = ny1; rel.x2 = nx2; rel.y2 = ny2;
        changed = true;
      }
    } else if (rel.type === 'pen') {
      // 恢复原始方向与原始包围盒尺寸，保持当前中心：
      // 先旋转回原始方向，再按旋转后的包围盒比例缩放到原始尺寸
      var cb = penBox(rel);
      var curAng = penDirAng(rel), origAng2 = penDirAng(o);
      var delta = ((origAng2 - curAng) * 180 / Math.PI + 540) % 360 - 180;
      var cx = cb.x, cy = cb.y;
      if (Math.abs(delta) > 0.01) {
        var rad = delta * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
        for (var i = 0; i < rel.points.length; i++) {
          var dx = rel.points[i][0] - cx, dy = rel.points[i][1] - cy;
          rel.points[i][0] = cx + dx * cos - dy * sin;
          rel.points[i][1] = cy + dx * sin + dy * cos;
        }
        changed = true;
      }
      var cb2 = penBox(rel), ob = penBox(o);
      var f = clamp(ob.w / Math.max(1, cb2.w), 0.05, 20);
      if (Math.abs(f - 1) > 0.001) {
        var cx2 = cb2.x, cy2 = cb2.y;
        for (var i2 = 0; i2 < rel.points.length; i2++) {
          rel.points[i2][0] = cx2 + (rel.points[i2][0] - cx2) * f;
          rel.points[i2][1] = cy2 + (rel.points[i2][1] - cy2) * f;
        }
        changed = true;
      }
    } else {
      // 矩形/圆形/文本/图片：恢复原始尺寸（宽高/字号）+ 原始旋转角度，当前位置（x/y）不变
      if (typeof rel.w === 'number' && o.w && Math.abs(rel.w - o.w) > 0.01) { rel.w = o.w; changed = true; }
      if (typeof rel.h === 'number' && o.h && Math.abs(rel.h - o.h) > 0.01) { rel.h = o.h; changed = true; }
      if (rel.type === 'text' && o.fontSize && rel.fontSize !== o.fontSize) { rel.fontSize = o.fontSize; changed = true; }
      var origRot = o.rotation || 0;
      if (Math.abs((rel.rotation || 0) - origRot) > 0.01) { rel.rotation = origRot; changed = true; }
    }
    return changed;
  }

  /* 笔的方向角：首末点连线角度；单点笔返回 0 */
  function penDirAng(el) {
    var pts = el.points;
    if (!pts || pts.length < 2) return 0;
    return Math.atan2(pts[pts.length - 1][1] - pts[0][1], pts[pts.length - 1][0] - pts[0][0]);
  }

  /* 与选择矩形（世界坐标，轴对齐）相交的所有元素 id */
  function elementsInRect(r) {
    var out = [];
    for (var i = 0; i < elements.length; i++) {
      var b = elWorldBox(elements[i]);
      if (b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y) out.push(elements[i].id);
    }
    return out;
  }

  /* ================= 具体操作 ================= */
  var TYPE_NAMES = { pen: '画笔', line: '直线', arrow: '箭头', rect: '矩形', circle: '圆形', text: '文本', image: '图片' };
  function setSelection(id) {
    setSelectionMulti(id ? [id] : []);
  }
  /* 设置多选集合：ids 有序，最后一位为主选中 */
  function setSelectionMulti(ids) {
    selectedIds = ids.slice();
    selectedId = selectedIds.length ? selectedIds[selectedIds.length - 1] : null;
    styleUndo = {}; // 样式调整撤销快照随选择变化重置
    updateSelInfo();
    syncPanelFromSelection();
    // 广播选中状态（含全部选中 id），让其他成员（含访问者）看到编辑状态
    if (connected && myUid) send({ type: 'sel', ids: selectedIds.slice() });
    render();
  }
  /* 刷新属性面板「当前图案」文案（选中/未选中/多选数量） */
  function updateSelInfo() {
    var info = $('selInfo');
    if (selectedIds.length > 1) {
      info.textContent = '已选中 ' + selectedIds.length + ' 个图案';
    } else if (selectedId) {
      var el = getElementById(selectedId);
      info.textContent = el ? (TYPE_NAMES[el.type] || el.type) + '（已选中）' : '未选中';
    } else {
      info.textContent = '未选中';
    }
  }

  function addPenPoint(el, wx, wy) {
    var pts = el.points;
    var last = pts[pts.length - 1];
    var dx = wx - last[0], dy = wy - last[1];
    var minD = 2 / view.zoom;
    if (dx * dx + dy * dy < minD * minD) return;
    if (pts.length >= 2000) return;
    pts.push([wx, wy]);
    render();
  }

  function moveElementBy(id, dx, dy) {
    var el = getElementById(id);
    if (!el) return;
    if (el.type === 'pen') {
      for (var i = 0; i < el.points.length; i++) {
        el.points[i][0] += dx; el.points[i][1] += dy;
      }
    } else if (el.type === 'line' || el.type === 'arrow') {
      el.x1 += dx; el.y1 += dy; el.x2 += dx; el.y2 += dy;
    } else {
      el.x += dx; el.y += dy;
    }
    render();
  }

  /* 缩放起始数据：所有类型统一为「对角锚点式」——锚点取被拖角点的对角（选择框角点，
     含 10px 外扩），缩放比例按「被拖角点→锚点」距离计算，保证被拖角点跟随鼠标，
     与矩形行为一致；同时避免笔等小图形因外扩偏差导致角点不贴鼠标 */
  function resizeStartData(el, sx, sy) {
    return resizeStartDataFromHandles(selectionHandles(el), sx, sy);
  }
  /* 通用：基于任意手柄（单元素或组框）计算锚点式缩放起始数据 */
  function resizeStartDataFromHandles(h, sx, sy) {
    var gi = 0, best = Infinity;
    for (var i = 0; i < 4; i++) {
      var dd = dist2(sx, sy, h.corners[i].x, h.corners[i].y);
      if (dd < best) { best = dd; gi = i; }
    }
    var g = screenToWorld(h.corners[gi].x, h.corners[gi].y);
    var a = screenToWorld(h.corners[(gi + 2) % 4].x, h.corners[(gi + 2) % 4].y);
    return { ax: a.x, ay: a.y, startDist: Math.max(1, dist(g.x, g.y, a.x, a.y)) };
  }

  function doResize(d, sx, sy) {
    var M = screenToWorld(sx, sy);
    var f = clamp(dist(M.x, M.y, d.rk.ax, d.rk.ay) / d.rk.startDist, 0.05, 20);
    var ax = d.rk.ax, ay = d.rk.ay;
    if (d.group) {
      var gAny = false;
      for (var gi = 0; gi < d.ids.length; gi++) {
        var gEl = getElementById(d.ids[gi]);
        if (!gEl) continue;
        if (scaleElAbout(gEl, d.snaps[gEl.id] || gEl, ax, ay, f)) gAny = true;
      }
      if (gAny) { d.changed = true; throttleSendGroupUpdate(d.ids, false); render(); }
      return;
    }
    var el = getElementById(d.id);
    if (!el) return;
    if (scaleElAbout(el, d.undo || el, ax, ay, f)) {
      d.changed = true;
      throttleSendUpdate(el.id, false);
      render();
    }
  }

  /* 单个元素绕锚角 (ax,ay) 等比缩放；base 为按下时快照（保证连续移动不复合缩放）
     返回 false 表示未做任何修改（文本字号越界时完全定格，不再缩放） */
  function scaleElAbout(el, base, ax, ay, f) {
    if (el.type === 'line' || el.type === 'arrow') {
      // 两端点统一绕锚角等比缩放（方向保持不变，被拖角点跟随鼠标）
      el.x1 = ax + (base.x1 - ax) * f;
      el.y1 = ay + (base.y1 - ay) * f;
      el.x2 = ax + (base.x2 - ax) * f;
      el.y2 = ay + (base.y2 - ay) * f;
      return true;
    } else if (el.type === 'pen') {
      // 画笔绕锚角等比缩放（被拖角点跟随鼠标）
      var baseP = (base && base.points) ? base.points : el.points;
      for (var i = 0; i < el.points.length; i++) {
        el.points[i][0] = ax + (baseP[i][0] - ax) * f;
        el.points[i][1] = ay + (baseP[i][1] - ay) * f;
      }
      return true;
    }
    // 矩形/圆形/文本/图片：绕锚角等比缩放，中心随锚角移动（基准同为按下时快照）
    var baseW = Math.max(1, base.w || 1);
    var baseH = Math.max(1, base.h || 1);
    if (el.type === 'text') {
      // 文本缩放同步改变字号；字号越界（<6 或 >400）时本次缩放完全不生效（整体定格）
      var baseFs = base.fontSize || el.fontSize || 20;
      var fMin = 6 / baseFs, fMax = 400 / baseFs;
      if (f < fMin || f > fMax) return false;
    }
    el.x = ax + (base.x - ax) * f;
    el.y = ay + (base.y - ay) * f;
    el.w = baseW * f;
    el.h = baseH * f;
    if (el.type === 'text') {
      el.fontSize = clamp(Math.round(baseFs * f), 6, 400);
    }
    return true;
  }

  function doRotate(d, sx, sy) {
    if (dist2(sx, sy, d.sx, d.sy) > 25) d.click = false; // 发生真实拖动则不算单击
    if (d.group) {
      var gc = groupWorldBox();
      var gsc = worldToScreen(gc.x, gc.y);
      var a1 = Math.atan2(sy - gsc.y, sx - gsc.x);
      var delta = (a1 - d.baseAng) * 180 / Math.PI;
      d.baseAng = a1;
      var rad = delta * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
      for (var gi = 0; gi < d.ids.length; gi++) {
        var gEl = getElementById(d.ids[gi]);
        if (gEl) rotateElAbout(gEl, gc.x, gc.y, cos, sin, delta);
      }
      throttleSendGroupUpdate(d.ids, false);
      render();
      return;
    }
    var el = getElementById(d.id);
    if (!el) return;
    var c = elCenter(el);
    var sc = worldToScreen(c.x, c.y);
    var a2 = Math.atan2(sy - sc.y, sx - sc.x);
    var delta2 = (a2 - d.baseAng) * 180 / Math.PI;
    d.baseAng = a2;
    var rad2 = delta2 * Math.PI / 180, cos2 = Math.cos(rad2), sin2 = Math.sin(rad2);
    rotateElAbout(el, c.x, c.y, cos2, sin2, delta2);
    throttleSendUpdate(el.id, false);
    render();
  }

  /* 单个元素绕世界坐标 (cx,cy) 旋转 delta 度（cos/sin 已预计算） */
  function rotateElAbout(el, cx, cy, cos, sin, delta) {
    if (el.type === 'line' || el.type === 'arrow') {
      var dx1 = el.x1 - cx, dy1 = el.y1 - cy;
      el.x1 = cx + dx1 * cos - dy1 * sin;
      el.y1 = cy + dx1 * sin + dy1 * cos;
      var dx2 = el.x2 - cx, dy2 = el.y2 - cy;
      el.x2 = cx + dx2 * cos - dy2 * sin;
      el.y2 = cy + dx2 * sin + dy2 * cos;
    } else if (el.type === 'pen') {
      for (var i = 0; i < el.points.length; i++) {
        var dx = el.points[i][0] - cx, dy = el.points[i][1] - cy;
        el.points[i][0] = cx + dx * cos - dy * sin;
        el.points[i][1] = cy + dx * sin + dy * cos;
      }
    } else {
      var dxb = el.x - cx, dyb = el.y - cy;
      el.x = cx + dxb * cos - dyb * sin;
      el.y = cy + dxb * sin + dyb * cos;
      el.rotation = ((el.rotation || 0) + delta) % 360;
    }
  }

  function eraseElement(id) {
    var idx = indexOfId(elements, id);
    if (idx < 0) return;
    elements.splice(idx, 1);
    var si = selectedIds.indexOf(id);
    if (si >= 0) selectedIds.splice(si, 1);
    if (selectedId === id) selectedId = selectedIds.length ? selectedIds[selectedIds.length - 1] : null;
    updateSelInfo();
    send({ type: 'delete', id: id });
    render();
  }

  /* 删除所有选中图案（顶部「删除」按钮 / Delete 键） */
  function deleteSelected() {
    if (!selectedIds.length) { setStatus('先选择要删除的图案'); return; }
    var ids = selectedIds.slice();
    for (var i = 0; i < ids.length; i++) eraseElement(ids[i]);
    setStatus('已删除 ' + ids.length + ' 个图案');
  }

  /* 复制选中图案：存入剪贴板并立即粘贴一份（顶部「复制」按钮） */
  function copySelected() {
    var els = selEls();
    if (!els.length) { setStatus('先选择要复制的图案'); return; }
    copyToBuffer();
    pasteBuffer();
  }
  function copyToBuffer() {
    var els = selEls();
    if (!els.length) { setStatus('先选择要复制的图案'); return; }
    copyBuffer = [];
    for (var i = 0; i < els.length; i++) copyBuffer.push(deepCopy(els[i]));
    setStatus('已复制 ' + els.length + ' 个图案');
  }
  function pasteBuffer() {
    if (!copyBuffer || !copyBuffer.length) { setStatus('剪贴板为空，先复制图案'); return; }
    var newIds = [], off = 24;
    for (var i = 0; i < copyBuffer.length; i++) {
      var c = deepCopy(copyBuffer[i]);
      c.id = uid();
      shiftElBy(c, off, off);
      elements.push(c);
      sendAdd(c);
      origShapes[c.id] = deepCopy(c); // 副本初始几何，供复位恢复原始尺寸
      newIds.push(c.id);
    }
    setSelectionMulti(newIds); // 选中副本
    setStatus('已粘贴 ' + newIds.length + ' 个图案');
    render();
  }
  /* 元素整体平移（pen/line/box 通用） */
  function shiftElBy(el, dx, dy) {
    if (el.type === 'pen') {
      for (var i = 0; i < el.points.length; i++) {
        el.points[i][0] += dx; el.points[i][1] += dy;
      }
    } else if (el.type === 'line' || el.type === 'arrow') {
      el.x1 += dx; el.y1 += dy; el.x2 += dx; el.y2 += dy;
    } else {
      el.x += dx; el.y += dy;
    }
  }

  function applyBucket(el) {
    var patch = {};
    // 油漆桶使用面板当前颜色（用户最后一次选的颜色）；矩形/圆形同时保留当前描边色
    var col = (color && color !== 'none') ? color : null;
    if (el.type === 'rect' || el.type === 'circle') {
      patch.fill = col || 'none';
      patch.stroke = (strokeColor && strokeColor !== 'none') ? strokeColor : 'none';
    }
    else if (el.type === 'pen' || el.type === 'line' || el.type === 'arrow' || el.type === 'text') { patch.stroke = col || '#000000'; }
    else if (el.type === 'image') { patch.opacity = opacity; } // 图片无填充/描边色，油漆桶应用当前透明度
    else return;
    patch.opacity = opacity;
    var k;
    for (k in patch) { if (patch.hasOwnProperty(k)) el[k] = patch[k]; }
    send({ type: 'update', id: el.id, patch: patch, commit: true });
    render();
  }

  function confirmClear() {
    if (readonly) return;
    if (!elements.length) { setStatus('画布本来就是空的'); return; }
    if (confirm('确定要清空整个画布吗？此操作可撤销。')) {
      elements = [];
      selectedId = null;
      selectedIds = [];
      send({ type: 'clear' });
      render();
    }
  }

  /* ================= 发送辅助 ================= */
  function sendAdd(el) { send({ type: 'add', element: el }); }
  /* 创建过程的实时预览广播：服务端不记录撤销历史（完成时统一 commit），访问者实时看到绘制过程 */
  function sendAddLive(el) { send({ type: 'add', element: el, live: true }); }

  function geometryPatch(el) {
    if (el.type === 'pen') return { points: el.points.slice(0) };
    if (el.type === 'line' || el.type === 'arrow') {
      return { x1: el.x1, y1: el.y1, x2: el.x2, y2: el.y2 };
    }
    if (el.type === 'text') {
      // 文本几何必须带 fontSize 与 text：缩放/移动/编辑后远端字号与文字同步
      return { x: el.x, y: el.y, w: el.w, h: el.h, fontSize: el.fontSize, text: el.text, rotation: el.rotation || 0 };
    }
    return { x: el.x, y: el.y, w: el.w, h: el.h, rotation: el.rotation || 0 };
  }
  function throttleSendUpdate(id, commit) {
    var t = Date.now();
    if (!commit && t - lastUpdateSend < 50) return;
    lastUpdateSend = t;
    sendUpdate(id, commit);
  }
  /* 组操作节流广播：同一批元素共享一个节流窗口 */
  function throttleSendGroupUpdate(ids, commit) {
    var t = Date.now();
    if (!commit && t - lastUpdateSend < 50) return;
    lastUpdateSend = t;
    for (var i = 0; i < ids.length; i++) sendUpdate(ids[i], commit);
  }
  function sendUpdate(id, commit) {
    var el = getElementById(id);
    if (!el) return;
    send({ type: 'update', id: id, patch: geometryPatch(el), commit: !!commit });
  }
  function sendUpdateCommit(id, undoEl) {
    var el = getElementById(id);
    if (!el) return;
    var msg = { type: 'update', id: id, patch: geometryPatch(el), commit: true };
    if (undoEl) msg.undo = undoEl;
    send(msg);
  }
  function sendLaser(x, y, active) {
    var t = Date.now();
    if (active && t - lastLaserSend < 30) return;
    lastLaserSend = t;
    send({ type: 'laser', x: x, y: y, active: active });
  }

  /* ================= 文本工具（点击画布后就地输入，不弹窗；输入框可拖拽移动；兼容 iOS9） ================= */
  var inlineActive = false; // 内联文本编辑中
  var inlinePos = null;     // {sx, sy} 输入框屏幕坐标（可被拖拽更新，提交时换算世界坐标）
  var inlineEditId = null;  // 双击编辑已有文本时记录其 id（null = 新建）
  function startInlineText(wx, wy, editEl) {
    var ta = $('inlineText');
    var s = worldToScreen(wx, wy);
    inlinePos = { sx: s.x, sy: s.y };
    inlineEditId = editEl ? editEl.id : null;
    // 输入框左上角对准点击点（最终渲染文本以输入框内文字起点为准），实现"输入在哪显示在哪"
    ta.style.left = Math.max(8, Math.min(s.x, window.innerWidth - 180 - 12)) + 'px';
    ta.style.top = Math.max(0, s.y) + 'px';
    ta.style.fontSize = (editEl ? editEl.fontSize : fontSize) + 'px';
    ta.value = editEl ? editEl.text : '';
    ta.classList.remove('hidden');
    inlineActive = true;
    autoSizeInlineText(); // 初始最小尺寸；输入时随内容变宽变高
    setTimeout(function () {
      try { ta.focus(); } catch (e) {}
    }, 60);
  }
  /* 输入框随内容自适应：宽度取最长行（含自动换行），高度取实际内容高；并防止超出视口 */
  function autoSizeInlineText() {
    var ta = $('inlineText');
    if (!inlineActive) return;
    // 用输入框实际字号测量（双击编辑已有文本时字号取自该文本，而非全局默认）
    var fs = parseFloat(ta.style.fontSize) || fontSize;
    var raw = String(ta.value);
    // 空值（新建未输入）时按 placeholder 测量，保证提示文字完整显示
    var lines = raw ? raw.split('\n') : [String(ta.getAttribute('placeholder') || '')];
    var mw = 10;
    ctx.font = fs + 'px sans-serif';
    for (var i = 0; i < lines.length; i++) {
      var tw = ctx.measureText(lines[i]).width;
      if (tw > mw) mw = tw;
    }
    // 宽度 = 最长行 + 内边距/边框(16px) + 8px 余量，避免 textarea 内容区恰好等于文本宽而临界换行
    var w = Math.max(180, Math.min(mw + 32, window.innerWidth - 40));
    ta.style.width = w + 'px';
    // 高度按行数估算（含软换行）：textarea 无 rows 时默认 2 行，scrollHeight 不可靠
    var contentW = Math.max(1, w - 16);
    var totalLines = 0;
    for (var i = 0; i < lines.length; i++) {
      var lw2 = ctx.measureText(lines[i]).width;
      totalLines += Math.max(1, Math.ceil(lw2 / contentW));
    }
    var h = totalLines * fs * 1.3 + 6;
    ta.style.height = h + 'px';
    // 防止随内容增长超出视口：右/下缘回拉，并同步提交位置
    var l = parseFloat(ta.style.left) || 0, tp = parseFloat(ta.style.top) || 0;
    var nl = Math.max(0, Math.min(l, window.innerWidth - 8 - w));
    var nt = Math.max(0, Math.min(tp, window.innerHeight - 8 - h));
    if (nl !== l || nt !== tp) {
      ta.style.left = nl + 'px';
      ta.style.top = nt + 'px';
      inlinePos = { sx: nl, sy: nt };
    }
  }
  /* 提交内联文本：非空则创建/更新文本元素并广播（位置 = 输入框内文字起点，与输入时所见一致）；
     双击编辑（inlineEditId）时更新已有元素：改文字/字号/位置，清空提交则删除该元素 */
  function commitInlineText() {
    if (!inlineActive) return;
    var ta = $('inlineText');
    var val = ta.value.replace(/\s+$/, '');
    inlineActive = false;
    ta.classList.add('hidden');
    var editId = inlineEditId;
    inlineEditId = null;
    var fs = fontSize;
    if (editId) {
      var e0 = getElementById(editId);
      if (e0) fs = e0.fontSize;
    }
    // 输入框内文字起点：left + 左内边距(6px)、top + 上内边距(2px) + 首行行内垂直偏移(0.15*字号)
    var l = parseFloat(ta.style.left) || 0, tp = parseFloat(ta.style.top) || 0;
    var wpt = screenToWorld(l + 6, tp + 2 + Math.round(fs * 0.15));
    var wx = wpt.x, wy = wpt.y;
    inlinePos = null;
    if (editId) {
      var el = getElementById(editId);
      if (!el) return;
      if (!val) { eraseElement(el.id); render(); return; } // 编辑成空：删除该文本
      var undo = deepCopy(el);
      var lines = val.split('\n');
      var maxW = 10;
      ctx.font = fs + 'px sans-serif';
      for (var i = 0; i < lines.length; i++) {
        var w = ctx.measureText(lines[i]).width;
        if (w > maxW) maxW = w;
      }
      el.text = val;
      el.fontSize = fs;
      el.x = wx; el.y = wy;
      el.w = maxW + 2; el.h = lines.length * fs * 1.3;
      el.rotation = 0; // 编辑后按输入框位置重新排布
      origShapes[el.id] = deepCopy(el); // 更新初始几何，复位恢复本次编辑后的状态
      sendUpdateCommit(el.id, undo);
      setSelection(el.id);
      render();
      return;
    }
    if (!val) return;
    var lines = val.split('\n');
    var maxW = 10;
    ctx.font = fs + 'px sans-serif';
    for (var i = 0; i < lines.length; i++) {
      var w = ctx.measureText(lines[i]).width;
      if (w > maxW) maxW = w;
    }
    var el = {
      id: uid(), type: 'text',
      x: wx, y: wy,
      w: maxW + 2, h: lines.length * fs * 1.3,
      text: val, stroke: strokeColor, fontSize: fs, opacity: opacity, rotation: 0
    };
    elements.push(el);
    sendAdd(el);
    origShapes[el.id] = deepCopy(el); // 文本创建即记录初始尺寸，供复位恢复原始字号/宽高
    setSelection(null);
    render();
  }
  function cancelInlineText() {
    if (!inlineActive) return;
    inlineActive = false;
    inlineEditId = null;
    $('inlineText').classList.add('hidden');
    inlinePos = null;
  }
  var inlineTextTa = $('inlineText');
  inlineTextTa.addEventListener('blur', function () { commitInlineText(); }, false);
  inlineTextTa.addEventListener('input', autoSizeInlineText, false); // 输入时输入框随内容变宽变高
  inlineTextTa.addEventListener('keydown', function (e) {
    if (e.keyCode === 27) { // Esc 取消
      e.preventDefault();
      e.stopPropagation();
      cancelInlineText();
      inlineTextTa.blur();
    }
  }, false);
  /* 输入框拖拽移动：点击（位移小）正常编辑；位移超阈值进入拖动，提交位置随之更新 */
  var inlineDrag = null;
  function inlineDragStart(cx, cy) {
    var ta = $('inlineText');
    inlineDrag = {
      sx: cx, sy: cy,
      l: parseFloat(ta.style.left) || 0,
      t: parseFloat(ta.style.top) || 0,
      moved: false
    };
  }
  function inlineDragMove(cx, cy) {
    if (!inlineDrag) return;
    var dx = cx - inlineDrag.sx, dy = cy - inlineDrag.sy;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) inlineDrag.moved = true;
    if (!inlineDrag.moved) return;
    var ta = $('inlineText');
    var nl = Math.max(0, Math.min(inlineDrag.l + dx, window.innerWidth - 50));
    var nt = Math.max(0, inlineDrag.t + dy);
    ta.style.left = nl + 'px';
    ta.style.top = nt + 'px';
    inlinePos = { sx: nl, sy: nt }; // 同步提交位置
  }
  function inlineDragEnd() { inlineDrag = null; }
  inlineTextTa.addEventListener('mousedown', function (e) {
    if (!inlineActive) return;
    inlineDragStart(e.clientX, e.clientY);
  }, false);
  document.addEventListener('mousemove', function (e) {
    if (inlineDrag && inlineDrag.moved) e.preventDefault();
    inlineDragMove(e.clientX, e.clientY);
  }, false);
  document.addEventListener('mouseup', inlineDragEnd, false);
  inlineTextTa.addEventListener('touchstart', function (e) {
    if (!inlineActive || !e.touches.length) return;
    inlineDragStart(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  inlineTextTa.addEventListener('touchmove', function (e) {
    if (!inlineDrag || !e.touches.length) return;
    if (inlineDrag.moved) e.preventDefault();
    inlineDragMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: false });
  inlineTextTa.addEventListener('touchend', inlineDragEnd, false);

  /* ================= 图片工具（仅从相册选择，压缩后插入） ================= */
  function showImgModal() {
    if (readonly) return;
    $('imgFile').value = '';
    $('imgModal').classList.remove('hidden');
  }
  function hideImgModal() { $('imgModal').classList.add('hidden'); }
  $('btnCloseImg').addEventListener('click', hideImgModal);
  $('imgModal').addEventListener('click', function (e) {
    if (e.target === this) hideImgModal();
  }, false);
  $('imgFile').addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (!f) return;
    var r = new FileReader();
    r.onload = function () { hideImgModal(); insertImage(String(r.result)); };
    r.onerror = function () { alert('读取文件失败'); };
    r.readAsDataURL(f);
  });

  function insertImage(src) {
    var img = new Image();
    img.onload = function () {
      var maxDim = 1024;
      var scale = 1;
      if (img.width > maxDim || img.height > maxDim) {
        scale = maxDim / Math.max(img.width, img.height);
      }
      var cw = Math.max(1, Math.round(img.width * scale));
      var ch = Math.max(1, Math.round(img.height * scale));
      var c = document.createElement('canvas');
      c.width = cw; c.height = ch;
      var cx = c.getContext('2d');
      cx.drawImage(img, 0, 0, cw, ch);
      var dataUrl = c.toDataURL('image/jpeg', 0.85);
      if (dataUrl.length > 1800000) dataUrl = c.toDataURL('image/jpeg', 0.5);
      var center = screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
      var el = {
        id: uid(), type: 'image',
        x: center.x, y: center.y, w: cw, h: ch,
        src: dataUrl, rotation: 0, opacity: opacity
      };
      elements.push(el);
      sendAdd(el);
      origShapes[el.id] = deepCopy(el); // 图片插入即记录初始尺寸，供复位恢复原始宽高
      setSelection(null);
      setTool('select'); // 插入图片后工具返回选择
      render();
    };
    img.onerror = function () { alert('图片加载失败'); };
    img.src = src;
  }

  /* ================= 房间设置（房主：改名 + 修改访问密码） ================= */
  function openRoomModal() {
    if (!isOwner || !connected) return;
    $('roomNameInput').value = roomInfo.name;
    $('roomPwdInput').value = roomInfo.pwd || '';
    $('roomModal').classList.remove('hidden');
    try { $('roomNameInput').focus(); } catch (e) {}
  }
  $('roomName').addEventListener('click', function () { openRoomModal(); });
  /* iPad / iOS 触屏：非交互元素（span）的 click 可能不触发，用 touchstart 兜底 */
  addEvt($('roomName'), 'touchstart', function (e) {
    e.preventDefault(); // 阻止后续 click 双触发与双击缩放
    openRoomModal();
  });
  $('btnRoomOk').addEventListener('click', function () {
    var n = $('roomNameInput').value.replace(/\s+/g, ' ').trim().slice(0, 40);
    var p = $('roomPwdInput').value.replace(/\s+/g, ' ').trim().slice(0, 40);
    $('roomModal').classList.add('hidden');
    if (n && n !== roomInfo.name) {
      send({ type: 'rename', name: n });
      setStatus('已发送改名请求…');
    }
    if (p !== (roomInfo.pwd || '')) {
      send({ type: 'pwd_change', pwd: p });
    }
  });
  $('btnRoomCancel').addEventListener('click', function () { $('roomModal').classList.add('hidden'); });
  $('roomModal').addEventListener('click', function (e) {
    if (e.target === this) this.classList.add('hidden');
  }, false);

  /* ================= 分享（分享时选择只读，URL 不同） ================= */
  var shareBaseUrl = '';
  // 分享链接基址：房主带当前密码；访客不带密码（对方自行输入，避免旧密码失效链接）
  function buildShareBaseUrl() {
    return location.origin + location.pathname + '?room=' + encodeURIComponent(roomInfo.id) +
      (isOwner && roomInfo.pwd ? '&pwd=' + encodeURIComponent(roomInfo.pwd) : '');
  }
  $('btnShare').addEventListener('click', function () {
    if (!roomInfo) return;
    // 只读用户只能分享只读链接：强制勾选「只读」
    if (readonly) {
      $('shareModeEdit').checked = false;
      $('shareModeRO').checked = true;
    }
    shareBaseUrl = buildShareBaseUrl();
    updateShareInput();
    $('shareModal').classList.remove('hidden');
  });
  function updateShareInput() {
    var ro = $('shareModeRO').checked || readonly;
    var urlStr = shareBaseUrl + (ro ? '&ro=1' : '');
    $('shareUrlInput').value = urlStr;
  }
  $('shareModeEdit').addEventListener('change', updateShareInput);
  $('shareModeRO').addEventListener('change', updateShareInput);
  $('btnCloseShare').addEventListener('click', function () { $('shareModal').classList.add('hidden'); });
  $('shareModal').addEventListener('click', function (e) {
    if (e.target === this) $('shareModal').classList.add('hidden');
  }, false);
  $('btnCopyUrl').addEventListener('click', function () {
    var inp = $('shareUrlInput');
    inp.focus();
    inp.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    if (!ok) {
      window.prompt('请手动复制链接', inp.value);
    }
    $('shareModal').classList.add('hidden');
  });

  /* ================= 退出白板（房主/访问者；房主另含复制链接与删除入口） ================= */
  function copyToClipboardText(t) {
    var ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
  $('btnExit').addEventListener('click', function () {
    if (!roomInfo) return;
    if (isOwner) {
      // 房主：显示房主链接（与分享白板链接一致：只读文本框 + 复制按钮）
      $('exitOwnerBox').classList.remove('hidden');
      var ownerUrlStr = location.origin + location.pathname + '?room=' + encodeURIComponent(roomInfo.id) +
        '&key=' + encodeURIComponent(PARAMS.key);
      $('ownerUrlInput').value = ownerUrlStr;
    } else {
      $('exitOwnerBox').classList.add('hidden');
    }
    $('exitModal').classList.remove('hidden');
  });
  $('btnExitCancel').addEventListener('click', function () { $('exitModal').classList.add('hidden'); });
  $('btnExitOk').addEventListener('click', function () {
    $('exitModal').classList.add('hidden');
    location.href = 'index.html';
  });
  $('exitModal').addEventListener('click', function (e) {
    if (e.target === this) $('exitModal').classList.add('hidden');
  }, false);
  // 复制房主链接：仅创建者拥有 key，凭此可再次以房主身份进入
  $('btnCopyOwnerUrl').addEventListener('click', function () {
    var v = $('ownerUrlInput').value;
    if (!v) return;
    if (copyToClipboardText(v)) setStatus('房主链接已复制到剪贴板');
    else window.prompt('请手动复制房主链接', v);
  });
  // 删除此白板（房主）：清空服务器数据并断开所有成员
  $('btnDeleteRoom').addEventListener('click', function () {
    if (!isOwner) return;
    if (!confirm('删除白板将清空服务器上的全部画布数据并断开所有成员，且无法恢复。确定删除？')) return;
    send({ type: 'delete_room' });
  });

  /* ================= 导出图片 / 导出导入配置 ================= */
  function base64ToArrayBuffer(b64) {
    var bin = atob(b64);
    var len = bin.length;
    var buf = new ArrayBuffer(len);
    var view = new Uint8Array(buf);
    for (var i = 0; i < len; i++) view[i] = bin.charCodeAt(i);
    return buf;
  }
  function downloadBlob(blob, filename) {
    try {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 1000);
      return true;
    } catch (e) { return false; }
  }
  function downloadDataUrl(url, filename, mime) {
    try {
      var blob = new Blob([base64ToArrayBuffer(url.split(',')[1])], { type: mime || 'application/octet-stream' });
      if (downloadBlob(blob, filename)) return;
    } catch (e) {}
    // 降级（iOS9 等不支持 a.download）：直接打开 data URL
    window.open(url, '_blank');
  }
  function downloadText(text, filename, mime) {
    try {
      var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
      if (downloadBlob(blob, filename)) return;
    } catch (e) {}
    window.open('data:text/plain;charset=utf-8,' + encodeURIComponent(text), '_blank');
  }

  /* 导出为图片：按全部元素的世界包围盒离屏渲染 PNG（单边不超过 4096） */
  $('btnExportImg').addEventListener('click', function () {
    if (!roomInfo) return;
    if (!elements.length) { setStatus('白板为空，无可导出的内容'); return; }
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < elements.length; i++) {
      var b = elWorldBox(elements[i]);
      if (b.x < minX) minX = b.x;
      if (b.y < minY) minY = b.y;
      if (b.x + b.w > maxX) maxX = b.x + b.w;
      if (b.y + b.h > maxY) maxY = b.y + b.h;
    }
    var PAD = 24;
    var w = maxX - minX + PAD * 2, h = maxY - minY + PAD * 2;
    var scale = 1;
    var MAXD = 4096;
    if (w > MAXD || h > MAXD) scale = Math.min(MAXD / w, MAXD / h);
    var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
    var oc = document.createElement('canvas');
    oc.width = cw;
    oc.height = ch;
    var octx = oc.getContext('2d');
    octx.fillStyle = '#FFFFFF';
    octx.fillRect(0, 0, cw, ch);
    // 临时把闭包 ctx 指向离屏画布，复用 drawElement 绘制全部元素
    var savedCtx = ctx;
    ctx = octx;
    ctx.save();
    ctx.scale(scale, scale);
    ctx.translate(PAD - minX, PAD - minY);
    for (var j = 0; j < elements.length; j++) drawElement(elements[j]);
    ctx.restore();
    ctx = savedCtx;
    var url;
    try { url = oc.toDataURL('image/png'); } catch (e) { setStatus('导出失败：图片尺寸过大'); return; }
    downloadDataUrl(url, '白板-' + roomInfo.id + '.png', 'image/png');
    setStatus('已导出白板图片');
  });

  /* 导出配置（所有成员可用）：把白板元素数据导出为 JSON 文件 */
  $('btnExportCfg').addEventListener('click', function () {
    if (!roomInfo) return;
    var cfg = {
      type: 'shared-whiteboard-config',
      version: 1,
      room: roomInfo.id,
      exportedAt: new Date().toISOString(),
      elements: elements
    };
    downloadText(JSON.stringify(cfg), '白板配置-' + roomInfo.id + '.json', 'application/json;charset=utf-8');
    setStatus('已导出白板配置');
  });

  /* 导入配置（仅房主）：读取 JSON 后确认覆盖，全量替换白板内容 */
  $('btnImportCfg').addEventListener('click', function () {
    if (!isOwner) { setStatus('仅房主可以导入配置'); return; }
    $('importFile').click();
  });
  $('importFile').addEventListener('change', function () {
    var f = this.files && this.files[0];
    this.value = '';
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      var cfg = null;
      try { cfg = JSON.parse(String(reader.result)); } catch (e) { alert('配置文件解析失败：不是有效的 JSON 文件'); return; }
      var list = cfg && Array.isArray(cfg.elements) ? cfg.elements : null;
      if (!list) { alert('配置文件中没有可导入的白板内容'); return; }
      if (!confirm('导入将覆盖当前白板的全部内容，且无法撤销。确定继续？')) return;
      send({ type: 'import', elements: list });
      // 导入配置成功后关闭分享弹窗
      $('shareModal').classList.add('hidden');
      setStatus('正在导入配置…');
    };
    reader.readAsText(f);
  });

  /* ================= 键盘快捷键 ================= */
  window.addEventListener('keydown', function (e) {
    if (e.keyCode === 27 && inlineActive) { e.preventDefault(); cancelInlineText(); try { $('inlineText').blur(); } catch (err) {} return; }
    var ae = document.activeElement;
    if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) return;
    if (!$('shareModal').classList.contains('hidden')) return;
    var mod = e.ctrlKey || e.metaKey;
    if (mod && e.keyCode === 90 && !e.shiftKey) { e.preventDefault(); send({ type: 'undo' }); }
    else if (mod && e.keyCode === 89) { e.preventDefault(); send({ type: 'redo' }); }
    else if (mod && e.shiftKey && e.keyCode === 90) { e.preventDefault(); send({ type: 'redo' }); }
    else if (mod && e.keyCode === 67 && tool === 'select') { e.preventDefault(); copyToBuffer(); }
    else if (mod && e.keyCode === 86 && tool === 'select') { e.preventDefault(); pasteBuffer(); }
    else if ((e.keyCode === 46 || e.keyCode === 8) && selectedIds.length && tool === 'select') {
      e.preventDefault();
      deleteSelected();
    }
  }, false);

  /* ================= 初始化 ================= */
  if (!PARAMS.room) {
    location.href = 'index.html';
    return;
  }
  // 所有人都显示「退出」按钮（房主/访问者/只读）：立即显示，无需等待欢迎消息；
  // welcome 到达后 applyRoomUI 会按服务端权限权威校正
  $('btnExit').classList.remove('hidden');
  // 只读用户（URL 带 ro=1）：进入页面立即应用只读界面，不先加载全部功能再隐藏；
  // welcome 到达后 applyRoomUI 按服务端权限权威校正
  if (PARAMS.ro === '1') {
    readonly = true;
    applyReadonlyUI();
  } else {
    setTool('pen');
  }
  resizeCanvas();
  buildPalette();
  connect();
})();
