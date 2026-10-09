// dsh-whisper-whale — 浏览器半（client plugin bundle）。
//
// 由 dsh-client-modules 在 /plugins/dsh-whisper-whale/client.js 提供，经壳里的
// 懒加载 CJS 模块表（window.__ModuleLoader__.load）执行 —— 与各 ui-* 包产物同形。
// 这里刻意不 require 任何东西（连 react 都不要）：整只小鲸鱼是原生 DOM，
// 所以它对宿主版本、主题、槽位体系都没有依赖。
//
// 它负责：右下角常驻的小鲸鱼（可拖、位置记忆）、气泡文案、多对话选择卡片、
// 右键菜单，以及和宿主半的四个 /whisper-whale/* 路由说话。
(function (root) {
  if (!root || !root.__ModuleLoader__ || typeof root.__ModuleLoader__.load !== 'function') return;

  root.__ModuleLoader__.load({
    id: 'dsh-whisper-whale',
    factory: function () {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

      /* ─────────────────────────── 常量 ─────────────────────────── */

      var NS = 'dshww';
      var PREFIX = '/whisper-whale';
      var LS_POS = 'dshWhisperWhale.pos';
      var LS_HIDDEN = 'dshWhisperWhale.hidden';
      var MAX_DRAG_SLOP = 5; // px：超过这个位移就算拖动，不算点击
      var POLL_MS = 1500;
      var POLL_BUDGET_MS = 3 * 60 * 1000;

      var IDLE_HINT = '现在没有正在工作的对话；AI 停下来时直接在输入框说就行';
      var PICK_HINT = '有多个对话正在工作，点一个告诉它';
      var OFFLINE_HINT = '挂件没接上 DSH 宿主：确认 dsh-whisper-whale 已启用并重启过 DSH';
      var GONE_HINT = '那个对话已经不在工作了，换个目标吧';
      var CLICK_SEQ = ['已通知 AI ✓', '它马上就抽空来问你', '想补充什么，先理一理～', '不用打断，继续干你的活'];

      /* ─────────────────────────── 小鲸鱼矢量图 ─────────────────────────── */

      // 手绘的小鲸鱼：钝头、钝尾根、两片圆头尾鳍、后掠胸鳍，头顶一个三点气泡
      // （「它在问你」）。和参考项目 / ZCode 那只鲸鱼没有任何共用几何。
      var WHALE_SVG = [
        '<svg viewBox="0 0 64 64" width="100%" height="100%" aria-hidden="true">',
        '<defs>',
        '<linearGradient id="dshww-body" x1="0.1" y1="0.05" x2="0.9" y2="1">',
        '<stop offset="0" stop-color="#6C86FF"/><stop offset="0.55" stop-color="#3A57DE"/><stop offset="1" stop-color="#1E2E96"/>',
        '</linearGradient>',
        '<linearGradient id="dshww-tail" x1="0.1" y1="0" x2="0.95" y2="1">',
        '<stop offset="0" stop-color="#6380FF"/><stop offset="1" stop-color="#22339E"/>',
        '</linearGradient>',
        '</defs>',
        '<path d="M39.5 34.4C42.8 30.6 45.9 28.2 49.6 27.2A3.8 3.8 0 0 1 49.6 34.8C48.6 35.8 47.5 36.9 46.8 38C47.5 39.1 48.6 40.2 49.6 41.2A3.8 3.8 0 0 1 49.6 48.8C45.9 47.8 42.8 45.4 39.5 41.6Z" fill="url(#dshww-tail)"/>',
        '<path d="M16 45C19 52 24 56.5 31 56.5C29 51.5 26 47 23 44.6Z" fill="#2840B4"/>',
        '<path d="M10 30C16 25.4 28 24.8 35 27.6C40 29.6 42.6 32.6 42.6 38C42.6 43.4 40 46.4 35 48.4C28 51.2 16 50.6 10 46C6.4 43.4 6.4 32.6 10 30Z" fill="url(#dshww-body)"/>',
        '<circle cx="21" cy="36.5" r="2.9" fill="#0C1430"/>',
        '<circle cx="22.2" cy="35.4" r="1.05" fill="#FFFFFF"/>',
        '<path d="M8.8 43.6C13.4 46.4 18.6 46.8 22.6 45.2" stroke="#16227A" stroke-width="1.7" stroke-linecap="round" fill="none" opacity="0.8"/>',
        '<g class="' + NS + '-think">',
        '<path d="M13 18.5L21 18.5L13.5 26.5Z" fill="#E9EFFF"/>',
        '<rect x="8" y="3" width="26" height="16.5" rx="8.25" fill="#E9EFFF"/>',
        '<circle cx="14.5" cy="11.2" r="2" fill="#3A57DE"/>',
        '<circle cx="21" cy="11.2" r="2" fill="#3A57DE"/>',
        '<circle cx="27.5" cy="11.2" r="2" fill="#3A57DE"/>',
        '</g>',
        '</svg>'
      ].join('');

      /* ─────────────────────────── 样式 ─────────────────────────── */

      function css(light) {
        var surface = light ? 'rgba(255,255,255,0.94)' : 'rgba(24,27,36,0.92)';
        var border = light ? 'rgba(15,23,42,0.10)' : 'rgba(255,255,255,0.12)';
        var text = light ? '#101828' : '#eef2ff';
        var muted = light ? 'rgba(16,24,40,0.62)' : 'rgba(238,242,255,0.62)';
        var hover = light ? 'rgba(59,91,219,0.08)' : 'rgba(143,180,255,0.14)';
        return [
          '.' + NS + '-root{position:fixed;z-index:2147483000;right:20px;bottom:20px;',
          'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
          'font-size:13px;line-height:1.5;color:' + text + ';-webkit-font-smoothing:antialiased;user-select:none;}',
          '.' + NS + '-stage{position:relative;width:56px;height:56px;}',
          '.' + NS + '-btn{position:absolute;inset:0;width:56px;height:56px;border:0;padding:6px;border-radius:50%;',
          'background:radial-gradient(circle at 32% 26%,#ffffff 0%,#eef4ff 58%,#dbe6ff 100%);',
          'box-shadow:0 6px 18px rgba(17,24,39,.22),0 1px 0 rgba(255,255,255,.7) inset;',
          'cursor:grab;transition:transform .16s ease,box-shadow .16s ease;touch-action:none;}',
          '.' + NS + '-btn:hover{transform:translateY(-2px) scale(1.04);box-shadow:0 10px 24px rgba(17,24,39,.26),0 1px 0 rgba(255,255,255,.7) inset;}',
          '.' + NS + '-btn:active{cursor:grabbing;transform:scale(.96);}',
          '.' + NS + '-btn.' + NS + '-busy .' + NS + '-whale{animation:' + NS + '-bob .9s ease-in-out infinite;}',
          '@keyframes ' + NS + '-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2.5px)}}',
          '.' + NS + '-think{animation:' + NS + '-think 3.6s ease-in-out infinite;transform-origin:22px 24px;}',
          '@keyframes ' + NS + '-think{0%,100%{opacity:.55;transform:translateY(1.6px) scale(.92)}45%{opacity:1;transform:translateY(0) scale(1)}}',
          '@keyframes ' + NS + '-ping{0%{transform:scale(.7);opacity:.55}100%{transform:scale(2.1);opacity:0}}',
          '.' + NS + '-ping{position:absolute;inset:0;border-radius:50%;border:2px solid #6f8dff;pointer-events:none;animation:' + NS + '-ping 1s ease-out 1;}',
          '.' + NS + '-badge{position:absolute;top:-2px;right:-2px;min-width:18px;height:18px;border-radius:9px;',
          'background:linear-gradient(180deg,#5b7cfa,#3b5bdb);color:#fff;font-size:11px;font-weight:700;',
          'display:none;align-items:center;justify-content:center;padding:0 5px;box-shadow:0 2px 6px rgba(17,24,39,.3);}',
          // width:max-content 是必须的：气泡是 .dshww-root（只有 56px 宽）里的绝对定位元素，
          // 只写 right:64px 会让可用宽度算成负数，收缩成「一个字一列」的竖条。
          '.' + NS + '-bubble{position:absolute;right:64px;bottom:6px;width:max-content;max-width:250px;padding:9px 12px;border-radius:14px;',
          'background:' + surface + ';border:1px solid ' + border + ';color:' + text + ';',
          'box-shadow:0 10px 28px rgba(17,24,39,.22);backdrop-filter:blur(10px);',
          'opacity:0;transform:translateX(6px);pointer-events:none;transition:opacity .18s ease,transform .18s ease;white-space:pre-wrap;}',
          '.' + NS + '-bubble.' + NS + '-on{opacity:1;transform:translateX(0);}',
          '.' + NS + '-bubble:after{content:"";position:absolute;right:-6px;bottom:16px;width:11px;height:11px;',
          'background:inherit;border-right:1px solid ' + border + ';border-bottom:1px solid ' + border + ';transform:rotate(-45deg);}',
          '.' + NS + '-card{position:absolute;right:64px;bottom:-4px;width:268px;max-height:320px;overflow:auto;',
          'padding:8px;border-radius:16px;background:' + surface + ';border:1px solid ' + border + ';',
          'box-shadow:0 16px 40px rgba(17,24,39,.28);backdrop-filter:blur(12px);display:none;}',
          '.' + NS + '-card.' + NS + '-on{display:block;}',
          '.' + NS + '-cardHead{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:' + muted + ';padding:4px 8px 6px;}',
          '.' + NS + '-row{display:block;width:100%;text-align:left;border:0;background:transparent;color:inherit;',
          'padding:8px 10px;border-radius:10px;cursor:pointer;font:inherit;}',
          '.' + NS + '-row:hover{background:' + hover + ';}',
          '.' + NS + '-rowTitle{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
          '.' + NS + '-rowSub{font-size:11px;color:' + muted + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;}',
          '.' + NS + '-menu{position:fixed;z-index:2147483001;min-width:172px;padding:6px;border-radius:12px;',
          'background:' + surface + ';border:1px solid ' + border + ';color:' + text + ';',
          'box-shadow:0 16px 40px rgba(17,24,39,.28);backdrop-filter:blur(12px);display:none;}',
          '.' + NS + '-menu.' + NS + '-on{display:block;}',
          '.' + NS + '-menu button{display:block;width:100%;text-align:left;border:0;background:transparent;color:inherit;',
          'padding:7px 10px;border-radius:8px;cursor:pointer;font:inherit;}',
          '.' + NS + '-menu button:hover{background:' + hover + ';}',
          '.' + NS + '-tab{position:fixed;z-index:2147483000;right:8px;bottom:8px;width:20px;height:20px;border-radius:50%;',
          'border:1px solid ' + border + ';background:' + surface + ';cursor:pointer;opacity:.42;padding:0;',
          'display:none;align-items:center;justify-content:center;font-size:11px;line-height:1;}',
          '.' + NS + '-tab.' + NS + '-on{display:flex;}',
          '.' + NS + '-tab:hover{opacity:1;}',
          '.' + NS + '-tab svg{width:14px;height:14px;display:block;}'
        ].join('');
      }

      /* ─────────────────────────── 小工具 ─────────────────────────── */

      function make(tag, className, text) {
        var el = document.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
      }

      function readPos() {
        try {
          var raw = root.localStorage.getItem(LS_POS);
          if (!raw) return null;
          var parsed = JSON.parse(raw);
          if (typeof parsed?.right === 'number' && typeof parsed?.bottom === 'number') return parsed;
        } catch (e) { /* 忽略 */ }
        return null;
      }

      function writePos(pos) {
        try { root.localStorage.setItem(LS_POS, JSON.stringify(pos)); } catch (e) { /* 忽略 */ }
      }

      /** 把 rgb()/rgba() 解析成 { lum, alpha }；解析不了返回 null。 */
      function parseColor(value) {
        var m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(value || '');
        if (!m) return null;
        return {
          alpha: m[4] === undefined ? 1 : Number(m[4]),
          lum: (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255
        };
      }

      /**
       * 判断当前界面是不是亮色主题。
       *
       * 先找第一个真正不透明的背景（body → html）。DSH 也可能把底色放在更里层的
       * 容器上，这时两个背景都是透明的 —— 那就退回用文字颜色反推：亮色主题配深色
       * 文字，这个信号比背景更稳。只认 body 的背景会在亮色主题下让气泡一直是深色
       * （这个坑是渲染出来看才发现的）。
       */
      function isLightTheme() {
        try {
          var nodes = [document.body, document.documentElement];
          for (var i = 0; i < nodes.length; i++) {
            if (!nodes[i]) continue;
            var bg = parseColor(getComputedStyle(nodes[i]).backgroundColor);
            if (bg && bg.alpha >= 0.2) return bg.lum > 0.55;
          }
          var fg = parseColor(getComputedStyle(document.body || document.documentElement).color);
          if (fg) return fg.lum < 0.5;
          return false;
        } catch (e) { return false; }
      }

      /** 只留标题最后一段路径 / 短 id，列表里够认人就行。 */
      function shortLabel(target) {
        var title = (target.title || '').trim();
        if (title) return title;
        var cwd = (target.cwd || '').replace(/[\\/]+$/, '');
        if (cwd) {
          var parts = cwd.split(/[\\/]/);
          return parts[parts.length - 1] || cwd;
        }
        return (target.id || '').slice(-8);
      }

      /* ─────────────────────────── 插件正文 ─────────────────────────── */

      var state = {
        ctx: null,
        disposed: false,
        theme: false,
        lastTarget: null,
        pollTimer: null,
        pollUntil: 0,
        spot: 0,
        busy: false
      };

      var dom = {};

      function setBubble(text, ms) {
        if (!dom.bubble) return;
        dom.bubble.textContent = text;
        dom.bubble.classList.add(NS + '-on');
        if (state.bubbleTimer) clearTimeout(state.bubbleTimer);
        if (ms !== 0) {
          state.bubbleTimer = setTimeout(function () { hideBubble(); }, ms || 2600);
        }
      }

      function hideBubble() {
        if (state.bubbleTimer) { clearTimeout(state.bubbleTimer); state.bubbleTimer = null; }
        if (dom.bubble) dom.bubble.classList.remove(NS + '-on');
      }

      function ping() {
        if (!dom.stage) return;
        var ring = make('span', NS + '-ping');
        dom.stage.appendChild(ring);
        setTimeout(function () { if (ring.parentNode) ring.parentNode.removeChild(ring); }, 1000);
      }

      function setBusy(flag) {
        state.busy = flag;
        if (dom.btn) dom.btn.classList.toggle(NS + '-busy', !!flag);
      }

      function renderBadge(count) {
        if (!dom.badge) return;
        if (count > 1) {
          dom.badge.textContent = String(count);
          dom.badge.style.display = 'flex';
        } else {
          dom.badge.style.display = 'none';
        }
      }

      function hidePicker() {
        if (dom.card) dom.card.classList.remove(NS + '-on');
      }

      function showPicker(targets, onPick) {
        if (!dom.card) return;
        dom.card.textContent = '';
        dom.card.appendChild(make('div', NS + '-cardHead', '正在工作的对话'));
        for (var i = 0; i < targets.length; i++) {
          (function (target) {
            var row = make('button', NS + '-row');
            row.type = 'button';
            row.appendChild(make('div', NS + '-rowTitle', shortLabel(target)));
            if (target.cwd) row.appendChild(make('div', NS + '-rowSub', target.cwd));
            row.addEventListener('click', function (ev) {
              ev.stopPropagation();
              hidePicker();
              onPick(target);
            });
            dom.card.appendChild(row);
          })(targets[i]);
        }
        dom.card.classList.add(NS + '-on');
      }

      function hideMenu() {
        if (dom.menu) dom.menu.classList.remove(NS + '-on');
      }

      function showMenu(x, y) {
        if (!dom.menu) return;
        dom.menu.style.left = Math.min(x, root.innerWidth - 190) + 'px';
        dom.menu.style.top = Math.min(y, root.innerHeight - 150) + 'px';
        dom.menu.classList.add(NS + '-on');
      }

      /* ─────────────────────────── 与宿主说话 ─────────────────────────── */

      function api(path, options) {
        var url = PREFIX + path;
        var init = options || {};
        init.headers = Object.assign({ 'Content-Type': 'application/json' }, init.headers || {});
        if (init.body !== undefined && typeof init.body !== 'string') init.body = JSON.stringify(init.body);
        return fetch(url, init).then(function (res) {
          return res.json().catch(function () { return { ok: false, reason: 'bad-json' }; })
            .then(function (payload) { return { status: res.status, payload: payload }; });
        });
      }

      function startPolling(sessionId) {
        stopPolling();
        state.pollUntil = Date.now() + POLL_BUDGET_MS;
        state.pollTimer = setInterval(function () {
          if (state.disposed || Date.now() > state.pollUntil) return stopPolling();
          api('/state?sessionId=' + encodeURIComponent(sessionId)).then(function (res) {
            var status = res.payload && res.payload.status;
            if (!status) return;
            if (status.phase === 'delivered') {
              setBubble('AI 收到啦，等它开口问你 ✓', 3200);
              setBusy(true);
              stopPolling();
            } else if (status.phase === 'idle') {
              stopPolling();
            }
          }).catch(function () { /* 宿主忙/断了都无所谓 */ });
        }, POLL_MS);
      }

      function stopPolling() {
        if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
      }

      function clickFor(target) {
        setBusy(true);
        ping();
        api('/click', { method: 'POST', body: { sessionId: target ? target.id : undefined } }).then(function (res) {
          var payload = res.payload || {};
          setBusy(false);
          if (payload.ok) {
            state.lastTarget = payload.target || target;
            var step = 0;
            setBubble(CLICK_SEQ[0]);
            var seq = setInterval(function () {
              step += 1;
              if (state.disposed || step >= CLICK_SEQ.length) return clearInterval(seq);
              setBubble(CLICK_SEQ[step]);
            }, 2400);
            startPolling(state.lastTarget.id);
            return;
          }
          if (payload.reason === 'ambiguous') {
            showPicker(payload.targets || [], clickFor);
            setBubble(PICK_HINT, 3200);
            return;
          }
          if (payload.reason === 'idle') { setBubble(IDLE_HINT, 3600); return; }
          if (payload.reason === 'muted') { setBubble('这个对话的挂件已经关了', 3000); return; }
          if (payload.reason === 'gone') { setBubble(GONE_HINT, 3000); return; }
          setBubble(OFFLINE_HINT, 4200);
        }).catch(function () { setBusy(false); setBubble(OFFLINE_HINT, 4200); });
      }

      /** 点一下：0 个在跑 → 提示；1 个 → 直接派发；多个 → 先选。 */
      function onWhaleClick() {
        hideMenu();
        api('/targets').then(function (res) {
          if (res.status === 404 || !res.payload || res.payload.ok !== true) {
            setBubble(OFFLINE_HINT, 4200);
            return;
          }
          var targets = res.payload.targets || [];
          renderBadge(targets.length);
          if (targets.length === 0) { setBubble(IDLE_HINT, 3600); return; }
          if (targets.length === 1) { clickFor(targets[0]); return; }
          showPicker(targets, clickFor);
          setBubble(PICK_HINT, 3200);
        }).catch(function () { setBubble(OFFLINE_HINT, 4200); });
      }

      function toggleMute() {
        var sessionId = state.lastTarget && state.lastTarget.id;
        if (!sessionId) { setBubble('先点一下小鲸鱼，让它知道你说的是哪个对话', 3200); return; }
        api('/mute', { method: 'POST', body: { sessionId: sessionId, muted: true } }).then(function () {
          setBubble('已让这个对话不再理会挂件', 3000);
        }).catch(function () { setBubble(OFFLINE_HINT, 3600); });
        hideMenu();
      }

      /* ─────────────────────────── DOM 搭建 ─────────────────────────── */

      function buildDom() {
        var style = document.createElement('style');
        style.setAttribute('data-' + NS, 'style');
        style.textContent = css(state.theme);
        dom.style = style;

        var rootEl = make('div', NS + '-root');
        rootEl.setAttribute('data-' + NS, 'root');

        var stage = make('div', NS + '-stage');
        var btn = make('button', NS + '-btn');
        btn.type = 'button';
        btn.title = '补充提示挂件：点一下，AI 立刻问你要补充什么';
        btn.setAttribute('aria-label', btn.title);
        btn.innerHTML = WHALE_SVG;
        var badge = make('span', NS + '-badge');
        stage.appendChild(btn);
        stage.appendChild(badge);

        var bubble = make('div', NS + '-bubble');
        var card = make('div', NS + '-card');

        rootEl.appendChild(bubble);
        rootEl.appendChild(card);
        rootEl.appendChild(stage);

        var menu = make('div', NS + '-menu');
        var actions = [
          ['点我，AI 马上来问你', function () { hideMenu(); onWhaleClick(); }],
          ['重置位置', function () { hideMenu(); writePos(null); applyPos(null); }],
          ['本对话不再理会挂件', toggleMute],
          ['隐藏小鲸鱼', function () { hideMenu(); setHidden(true); }],
          ['关于补充提示挂件', function () {
            hideMenu();
            setBubble('DSH 版补充提示挂件 · 点我 → AI 停下手上的活先问你要补充什么', 4200);
          }]
        ];
        for (var i = 0; i < actions.length; i++) {
          (function (item) {
            var b = make('button', null, item[0]);
            b.type = 'button';
            b.addEventListener('click', function (ev) { ev.stopPropagation(); item[1](); });
            menu.appendChild(b);
          })(actions[i]);
        }

        var tab = make('button', NS + '-tab');
        tab.innerHTML = WHALE_SVG;
        tab.type = 'button';
        tab.title = '显示小鲸鱼';
        tab.addEventListener('click', function () { setHidden(false); });

        dom.root = rootEl;
        dom.stage = stage;
        dom.btn = btn;
        dom.badge = badge;
        dom.bubble = bubble;
        dom.card = card;
        dom.menu = menu;
        dom.tab = tab;

        document.body.appendChild(style);
        document.body.appendChild(rootEl);
        document.body.appendChild(menu);
        document.body.appendChild(tab);
      }

      function setHidden(hidden) {
        try { root.localStorage.setItem(LS_HIDDEN, hidden ? '1' : '0'); } catch (e) { /* 忽略 */ }
        if (dom.root) dom.root.style.display = hidden ? 'none' : '';
        if (dom.menu) dom.menu.classList.remove(NS + '-on');
        if (dom.tab) dom.tab.classList.toggle(NS + '-on', !!hidden);
      }

      /* ─────────────────────────── 位置与拖动 ─────────────────────────── */

      function clampPos(pos) {
        var maxRight = Math.max(4, root.innerWidth - 76);
        var maxBottom = Math.max(4, root.innerHeight - 76);
        return {
          right: Math.min(Math.max(4, Number(pos.right) || 0), maxRight),
          bottom: Math.min(Math.max(4, Number(pos.bottom) || 0), maxBottom)
        };
      }

      function applyPos(pos) {
        if (!dom.root) return;
        if (!pos) { dom.root.style.right = '20px'; dom.root.style.bottom = '20px'; return; }
        var safe = clampPos(pos);
        dom.root.style.right = safe.right + 'px';
        dom.root.style.bottom = safe.bottom + 'px';
      }

      function installDrag() {
        var dragging = false;
        var moved = false;
        var startX = 0;
        var startY = 0;
        var startRight = 20;
        var startBottom = 20;
        var pointerId = null;

        function onDown(ev) {
          if (ev.button !== undefined && ev.button !== 0) return;
          dragging = true;
          moved = false;
          pointerId = ev.pointerId;
          startX = ev.clientX;
          startY = ev.clientY;
          var rect = dom.root.getBoundingClientRect();
          startRight = root.innerWidth - rect.right;
          startBottom = root.innerHeight - rect.bottom;
          hideMenu();
          hideBubble();
          try { dom.btn.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
        }

        function onMove(ev) {
          if (!dragging) return;
          var dx = ev.clientX - startX;
          var dy = ev.clientY - startY;
          if (!moved && Math.abs(dx) + Math.abs(dy) < MAX_DRAG_SLOP) return;
          moved = true;
          applyPos({ right: startRight - dx, bottom: startBottom - dy });
        }

        function onUp(ev) {
          if (!dragging) return;
          dragging = false;
          try { dom.btn.releasePointerCapture(pointerId); } catch (e) { /* ignore */ }
          pointerId = null;
          if (!moved) { onWhaleClick(); return; }
          var rect = dom.root.getBoundingClientRect();
          writePos({ right: root.innerWidth - rect.right, bottom: root.innerHeight - rect.bottom });
        }

        dom.btn.addEventListener('pointerdown', onDown);
        dom.btn.addEventListener('pointermove', onMove);
        dom.btn.addEventListener('pointerup', onUp);
        dom.btn.addEventListener('pointercancel', function () { dragging = false; });
        dom.btn.addEventListener('contextmenu', function (ev) {
          ev.preventDefault();
          showMenu(ev.clientX, ev.clientY);
        });
        dom.stage.addEventListener('dblclick', function () { setHidden(true); });
      }

      /* ─────────────────────────── 生命周期 ─────────────────────────── */

      function syncTheme() {
        var light = isLightTheme();
        if (light === state.theme) return;
        state.theme = light;
        if (dom.style) dom.style.textContent = css(light);
      }

      function apply(ctx) {
        state.ctx = ctx;
        try {
          if (document.body === null) {
            document.addEventListener('DOMContentLoaded', function () { apply(ctx); }, { once: true });
            return;
          }
          state.theme = isLightTheme();
          buildDom();
          applyPos(readPos());
          installDrag();
          setHidden(root.localStorage && root.localStorage.getItem(LS_HIDDEN) === '1');
          try { syncTheme(); } catch (e) { /* ignore */ }

          var onResize = function () {
            applyPos(readPos() || {
              right: parseFloat(dom.root.style.right) || 20,
              bottom: parseFloat(dom.root.style.bottom) || 20
            });
            hideMenu();
          };
          var onDocClick = function () { hideMenu(); hidePicker(); };
          root.addEventListener('resize', onResize);
          document.addEventListener('click', onDocClick);
          var themeObserver = null;
          try {
            themeObserver = new MutationObserver(syncTheme);
            themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
          } catch (e) { /* ignore */ }

          // 探一次活：宿主半没起来就直接把话说清楚，别让用户点半天没反应。
          api('/targets').then(function (res) {
            if (res.status === 404) setBubble(OFFLINE_HINT, 4200);
            else renderBadge(((res.payload || {}).targets || []).length);
          }).catch(function () { /* 静默 */ });

          if (typeof ctx.effect === 'function') {
            ctx.effect(function () {
              return function () {
                state.disposed = true;
                stopPolling();
                root.removeEventListener('resize', onResize);
                document.removeEventListener('click', onDocClick);
                if (themeObserver) themeObserver.disconnect();
                for (var key in dom) {
                  var el = dom[key];
                  if (el && el.parentNode) el.parentNode.removeChild(el);
                }
                dom = {};
              };
            }, 'dsh-whisper-whale: widget');
          }

          root.__whisperWhale = {
            show: function () { setHidden(false); },
            hide: function () { setHidden(true); },
            reset: function () { writePos(null); applyPos(null); },
            hint: setBubble,
            state: state
          };
        } catch (error) {
          try { console.error('[dsh-whisper-whale] 挂件初始化失败', error); } catch (e) { /* ignore */ }
        }
      }

      exports.inject = [];
      exports.apply = apply;
      return module.exports;
    }
  });
})(typeof window !== 'undefined' ? window : null);
