// ==UserScript==
// @name         WPP Chat iframe Q/A Bridge (Long-Polling, React-Safe + Attachments + Upload-Aware + NetSniff)
// @namespace    http://tampermonkey.net/
// @version      1.6.0
// @description  长轮询第三方问题(+附件) -> 先上传并等待完成 -> 再安全送入聊天 -> 网络优先抓取答案(兜底DOM稳定窗口) -> 去重清洗后回传
// @match        https://open-web-deeplink-cs.wpp.ai/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      *
// ==/UserScript==

(function () {
    'use strict';
  
    /********************** 配置区 ************************/
    const POLL_URL        = 'http://127.0.0.1:7080/v1/questions/long-poll';
    const ANSWER_POST_URL = 'http://127.0.0.1:7080/v1/answers';
  
    const AUTH_HEADER     = 'Bearer YOUR_TOKEN_HERE';
    const EXTRA_HEADERS   = { /* 'X-Tenant': 'foo' */ };
  
    const LONG_POLL_TIMEOUT_SEC = 30;
    const IDLE_BACKOFF_MS       = 1200;
  
    // 答案判定（最小等待 + 稳定窗口 + 硬超时）
    const STABLE_MS        = 1200;
    const HARD_MIN_WAIT_MS = 20000;
    const MAX_WAIT_MS      = 60000;
  
    // 附件上传相关等待
    const UPLOAD_IDLE_GRACE_MS  = 800;
    const UPLOAD_MAX_WAIT_MS    = 120000;
    const SEND_ENABLE_MAX_WAIT  = 60000;
  
    // —— 新增：聊天接口 URL 正则（同源 iframe 内实际 API）——
    const CHAT_API_RE = /\/v1\/tools\/[^/]+\/results\/[^/]+\/cloudstore\/type\/chats\b/;
  
    const SELECTORS = {
      chatRoot:   '#micro-app, body',
      input:      '#input, textarea#input',
      sendBtn:    '#chat-send-button',
  
      // 上传相关
      fileInput:  'input[type="file"]',
      uploadBtn:  '[data-testid*="upload"],[data-testid*="attachment"],[aria-label*="upload"],[aria-label*="附件"]',
      dropZone:   '[data-testid*="drop"],[class*="dropzone"],[class*="upload"]',
  
      // 正在上传/忙碌状态探测
      uploadingHints: [
        '.ant-upload-list-item-uploading',
        '.ant-progress',
        '[aria-busy="true"]',
        '[data-state="uploading"]',
        '[data-testid*="uploading"]',
        '.uploading',
        '.is-uploading'
      ].join(','),
  
      // 已附加的附件条目
      attachedItemHints: [
        '[data-testid*="attachment-item"]',
        '.ant-upload-list-item',
        '[class*="attachment"]'
      ].join(','),
  
      // 文本消息抓取
      messageBox: '[data-message], [data-testid*="message"], .message, .chat-message',
      assistant:  '[data-role="assistant"], [data-author="assistant"], [data-testid*="assistant"], .assistant, .ai, [aria-label*="assistant"]',
      textNodes:  '[data-testid*="markdown"], [data-testid*="content"], .content, .markdown, .text, [role="article"], [role="document"]'
    };
  
    /********************** 工具 ************************/
    const log   = (...a) => console.log('[LP-QA]', ...a);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const now   = () => Date.now();
  
    // —— 新增：网络侧等待器（按发送时间匹配最近一次 assistant 响应）——
    let netWaiters = []; // { since:number, resolve:fn, timer:any }
  
    // —— 新增：幂等回传缓存 —— //
    const lastSentAnswer = new Map(); // questionId -> hash
  
    function hashText(s='') {
      let h = 0, i = 0, len = s.length;
      while (i < len) { h = ((h<<5)-h) + s.charCodeAt(i++) | 0; }
      return String(h);
    }
  
    // —— 新增：答案去重清洗 —— //
    function normalizeAnswer(text='') {
      // 1) 去掉连续重复的空白
      let t = text.replace(/\r/g,'').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (!t) return t;
  
      // 2) 拆段去重（完全相同的段落去重，保留顺序）
      const paras = t.split(/\n{2,}/);
      const seenP = new Set();
      const outP  = [];
      for (const p of paras) {
        const k = p.trim();
        if (!k) continue;
        if (seenP.has(k)) continue;
        seenP.add(k);
        outP.push(k);
      }
      t = outP.join('\n\n');
  
      // 3) 每段内按行去除连续重复行
      const lines = t.split('\n');
      const outL = [];
      let prev = '';
      for (const ln of lines) {
        if (ln.trim() === prev.trim()) continue;
        outL.push(ln);
        prev = ln;
      }
      t = outL.join('\n').trim();
  
      return t;
    }
  
    async function waitFor(condFn, { timeout = 10000, interval = 150 } = {}) {
      const t0 = now();
      try { if (await condFn()) return true; } catch {}
      while (now() - t0 < timeout) {
        await sleep(interval);
        try { if (await condFn()) return true; } catch {}
      }
      return false;
    }
  
    function buildHeaders(extra = {}) {
      const h = { Accept: 'application/json', ...extra };
      if (AUTH_HEADER) h['Authorization'] = AUTH_HEADER;
      Object.assign(h, EXTRA_HEADERS || {});
      return h;
    }
  
    function gmFetch({ url, method = 'GET', json, headers = {}, timeout = 65000, responseType = 'json' }) {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          url,
          method,
          headers: {
            ...(json ? { 'Content-Type': 'application/json' } : {}),
            ...headers
          },
          data: json ? JSON.stringify(json) : undefined,
          responseType: responseType === 'json' ? 'text' : responseType,
          timeout,
          onload: (res) => {
            try {
              if (responseType === 'json') {
                const txt = res.responseText || '';
                resolve({ status: res.status, body: txt ? JSON.parse(txt) : null });
              } else {
                resolve({ status: res.status, body: res.response });
              }
            } catch (e) { reject(e); }
          },
          onerror: reject,
          ontimeout: reject
        });
      });
    }
  
    /********************** 注入网络抓包（fetch / XHR 劫持） ************************/
    function injectNetSniffer() {
      const code = `
        (function() {
          const CHAT_API_RE = ${CHAT_API_RE}.constructor(${CHAT_API_RE});
          function safePost(payload){
            try{ window.postMessage({ type: 'LP_QA_NET', payload }, '*'); }catch(e){}
          }
  
          // 劫持 fetch
          const _fetch = window.fetch;
          window.fetch = async function(input, init){
            const res = await _fetch.apply(this, arguments);
            try{
              const url = (typeof input === 'string') ? input : (input && input.url) || '';
              if (CHAT_API_RE.test(url)) {
                const clone = res.clone();
                clone.text().then(txt=>{
                  try{
                    const data = JSON.parse(txt);
                    const msgs = data?.value?.messages || data?.messages || [];
                    const assistant = [...msgs].reverse().find(m =>
                      (m.role === 'assistant' || m.author === 'assistant') &&
                      typeof m.content === 'string' && m.content.trim().length
                    );
                    if (assistant) {
                      safePost({
                        via: 'fetch',
                        url,
                        text: assistant.content,
                        traceId: assistant.traceId || data?.traceId || null,
                        at: Date.now()
                      });
                    }
                  }catch(e){}
                }).catch(()=>{});
              }
            }catch(e){}
            return res;
          };
  
          // 劫持 XHR
          const _open = XMLHttpRequest.prototype.open;
          const _send = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.open = function(method, url){
            this.__lpqa_url = url || '';
            return _open.apply(this, arguments);
          };
          XMLHttpRequest.prototype.send = function(body){
            try{
              this.addEventListener('load', function(){
                try{
                  const url = this.__lpqa_url || '';
                  if (CHAT_API_RE.test(url)) {
                    const txt = this.responseText || '';
                    try{
                      const data = JSON.parse(txt);
                      const msgs = data?.value?.messages || data?.messages || [];
                      const assistant = [...msgs].reverse().find(m =>
                        (m.role === 'assistant' || m.author === 'assistant') &&
                        typeof m.content === 'string' && m.content.trim().length
                      );
                      if (assistant) {
                        safePost({
                          via: 'xhr',
                          url,
                          text: assistant.content,
                          traceId: assistant.traceId || data?.traceId || null,
                          at: Date.now()
                        });
                      }
                    }catch(e){}
                  }
                }catch(e){}
              });
            }catch(e){}
            return _send.apply(this, arguments);
          };
        })();
      `;
      const s = document.createElement('script');
      s.textContent = code;
      document.documentElement.appendChild(s);
      s.remove();
    }
  
    // 接收注入脚本回传的网络应答
    window.addEventListener('message', (ev)=>{
      if (ev.source !== window) return;
      const msg = ev.data;
      if (!msg || msg.type !== 'LP_QA_NET') return;
  
      const { text, at } = msg.payload || {};
      if (!text || !at) return;
  
      // 找到发送时间 since <= at 且 gap 最小的等待者
      let idx = -1;
      let bestGap = Infinity;
      for (let i=0;i<netWaiters.length;i++){
        const w = netWaiters[i];
        const gap = at - w.since;
        if (gap >= 0 && gap < bestGap) { bestGap = gap; idx = i; }
      }
      if (idx >= 0) {
        const w = netWaiters.splice(idx, 1)[0];
        clearTimeout(w.timer);
        try { w.resolve(text); } catch(e){}
      }
    }, false);
  
    /********************** 输入/发送（React 安全） ************************/
    async function waitForInput() {
      for (let i = 0; i < 60; i++) {
        const el = document.querySelector(SELECTORS.input)
               || document.querySelector('textarea, [role="textbox"][contenteditable="true"]');
        if (el) return el;
        await sleep(200);
      }
      throw new Error('找不到聊天输入框 (#input)');
    }
  
    function setInputValueReactSafe(el, text) {
      const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
  
      const valueSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const valueGetter = Object.getOwnPropertyDescriptor(proto, 'value')?.get;
  
      el.focus?.({ preventScroll: true });
      try { el.setSelectionRange?.(el.value?.length ?? 0, el.value?.length ?? 0); } catch {}
  
      try { el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); } catch {}
      try { el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: text })); } catch {}
  
      if (valueSetter) valueSetter.call(el, text);
      else el.value = text;
  
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      try { el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); } catch {}
  
      setTimeout(() => {
        const nowVal = valueGetter ? valueGetter.call(el) : el.value;
        if (nowVal !== text) {
          if (valueSetter) valueSetter.call(el, text);
          else el.value = text;
          el.dispatchEvent(new Event('input',  { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, 50);
    }
  
    function findSendButton() {
      const btn = document.querySelector(SELECTORS.sendBtn);
      if (btn) return btn;
      return Array.from(document.querySelectorAll('button')).find(b =>
        /send|发送/i.test(b.textContent || '') ||
        /send/i.test(b.getAttribute('aria-label') || '') ||
        /send/i.test(b.getAttribute('data-testid') || '')
      ) || null;
    }
  
    function isElementDisabled(el) {
      if (!el) return true;
      if (el.disabled) return true;
      const aria = el.getAttribute?.('aria-disabled');
      if (aria && aria !== 'false') return true;
      const cls = (el.className || '').toString();
      if (/disabled|wpp-disabled|ant-btn-loading/i.test(cls)) return true;
      return false;
    }
  
    async function waitSendEnabled() {
      return await waitFor(() => {
        const btn = findSendButton();
        return btn && !isElementDisabled(btn);
      }, { timeout: SEND_ENABLE_MAX_WAIT, interval: 200 });
    }
  
    async function sendToChat(text) {
      const input = await waitForInput();
      setInputValueReactSafe(input, text);
      await sleep(60);
  
      await waitSendEnabled();
  
      const btn = findSendButton();
      if (btn && !isElementDisabled(btn)) {
        btn.click();
      } else {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code:'Enter', which:13, keyCode:13, bubbles:true }));
      }
  
      setTimeout(() => {
        const el = document.querySelector(SELECTORS.input);
        if (!el) return;
        const val = 'value' in el ? el.value : el.textContent;
        if (val && String(val).trim().length) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code:'Enter', which:13, keyCode:13, bubbles:true }));
        }
      }, 150);
    }
  
    /********************** 答案抓取（本次发送专属：DOM 兜底） ************************/
    function getAllMessageNodes() {
      return Array.from(document.querySelectorAll(SELECTORS.messageBox));
    }
  
    function extractTextFrom(node) {
      const nodes = node.querySelectorAll(SELECTORS.textNodes);
      if (nodes.length) {
        return Array.from(nodes).map(n => n.innerText?.trim() || '')
          .join('\n').replace(/\n{3,}/g, '\n\n').trim();
      }
      return (node.innerText || '').trim();
    }
  
    async function captureAnswerForThisSend(sendStartedAt, baselineCount) {
      const root = document.querySelector(SELECTORS.chatRoot) || document.body;
      const start = now();
      let lastText = '';
      let latestNonEmpty = '';
      let lastChangeAt = now();
      let resolved = false;
  
      const isAssistantNode = (n) =>
        n.matches?.(SELECTORS.assistant) ||
        /\bassistant\b|\bai\b/i.test(n.className || '') ||
        /\bassistant\b/i.test(n.getAttribute?.('data-author') || '');
  
      const pickLatestAssistantAfterBaseline = () => {
        const all = getAllMessageNodes();
        const recent = all.slice(baselineCount);
        const tail = recent.reverse().find(n => isAssistantNode(n))
          || [...all].reverse().find(n => isAssistantNode(n) && (n.__lastUpdatedAt || 0) >= sendStartedAt);
        return tail || null;
      };
  
      return new Promise((resolve) => {
        const tryResolve = () => {
          if (resolved) return;
          const t = now();
          const minWaitReached = (t - start) >= HARD_MIN_WAIT_MS;
          const stableEnough   = (t - lastChangeAt) >= STABLE_MS;
          const timeout        = (t - start) >= MAX_WAIT_MS;
          if ((minWaitReached && stableEnough) || timeout) {
            resolved = true;
            resolve(latestNonEmpty || lastText || '');
            obs.disconnect();
          }
        };
  
        const obs = new MutationObserver((mutations) => {
          const t = now();
          mutations.forEach(m => m.target && (m.target.__lastUpdatedAt = t));
          const candidate = pickLatestAssistantAfterBaseline();
          if (!candidate) return;
  
          const text = extractTextFrom(candidate);
          if (text == null) return;
          if (text !== lastText) {
            lastText = text;
            if (text.trim()) latestNonEmpty = text;
            lastChangeAt = t;
          }
          tryResolve();
        });
  
        const tick = setInterval(() => {
          if (resolved) { clearInterval(tick); return; }
          tryResolve();
          if (resolved) clearInterval(tick);
        }, 500);
  
        obs.observe(root, { childList: true, subtree: true, characterData: true });
      });
    }
  
    // —— 改造：网络优先 + DOM 兜底 —— //
    async function sendAndWaitAnswer(text) {
      const baselineCount = getAllMessageNodes().length;
      const sendStartedAt = now();
  
      await sendToChat(text);
  
      // 网络侧等待：与 DOM 并行竞争
      const netPromise = new Promise((resolve)=>{
        const waiter = { since: sendStartedAt, resolve:null, timer:null };
        waiter.resolve = (t)=> resolve(normalizeAnswer(t));
        waiter.timer = setTimeout(()=> resolve(''), Math.max(1000, MAX_WAIT_MS - 500)); // 避免一直等
        netWaiters.push(waiter);
      });
  
      const domPromise = captureAnswerForThisSend(sendStartedAt, baselineCount);
  
      let answer = await Promise.race([netPromise, domPromise]);
      if (!answer) {
        answer = await domPromise.catch(()=> '');
      }
      return normalizeAnswer(answer);
    }
  
    /********************** —— 附件相关 —— ************************/
    async function fetchAsFile(att) {
      if (att?.b64) {
        const res  = await fetch(att.b64);
        const blob = await res.blob();
        return new File([blob], att.filename || 'file', { type: att.mime || blob.type || 'application/octet-stream' });
      }
      const { body, status } = await gmFetch({
        url: att.url,
        method: 'GET',
        responseType: 'arraybuffer',
        timeout: 60000
      });
      if (status >= 400) throw new Error('download failed: ' + status);
      const mime = att.mime || 'application/octet-stream';
      const blob = new Blob([body], { type: mime });
      const name = att.filename || (att.url?.split('/').pop()?.split('?')[0] || 'file');
      return new File([blob], name, { type: mime });
    }
  
    function dataTransferFromFiles(files) {
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));
      return dt;
    }
  
    async function attachFilesToInput(files) {
      const up = document.querySelector(SELECTORS.uploadBtn);
      if (up) { up.click(); await sleep(200); }
  
      let input = null;
      for (let i = 0; i < 30; i++) {
        input = document.querySelector(SELECTORS.fileInput);
        if (input) break;
        await sleep(150);
      }
      if (!input) throw new Error('未找到文件选择框');
  
      const dt = dataTransferFromFiles(files);
      Object.defineProperty(input, 'files', { value: dt.files, writable: false });
      input.dispatchEvent(new Event('input',  { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  
    async function dropFilesToZone(files) {
      const zone = document.querySelector(SELECTORS.dropZone);
      if (!zone) throw new Error('未找到可拖拽区域');
      const dt = dataTransferFromFiles(files);
      zone.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    }
  
    function uploadingNodes() {
      return Array.from(document.querySelectorAll(SELECTORS.uploadingHints));
    }
    function attachedItems() {
      return Array.from(document.querySelectorAll(SELECTORS.attachedItemHints));
    }
  
    async function waitUploadIdle({ mustHaveAttachments = true } = {}) {
      const t0 = now();
      let lastBusyAt = now();
  
      if (mustHaveAttachments) {
        await waitFor(() => attachedItems().length > 0, { timeout: UPLOAD_MAX_WAIT_MS / 2, interval: 200 });
      }
  
      return new Promise((resolve) => {
        const root = document.querySelector(SELECTORS.chatRoot) || document.body;
  
        const check = () => {
          const busy = uploadingNodes().length > 0;
          if (busy) lastBusyAt = now();
  
          const btn = findSendButton();
          if (!btn || isElementDisabled(btn)) lastBusyAt = now();
  
          const idleLongEnough = now() - lastBusyAt >= UPLOAD_IDLE_GRACE_MS;
          const timeout        = now() - t0 >= UPLOAD_MAX_WAIT_MS;
  
          if (idleLongEnough || timeout) {
            obs.disconnect();
            resolve(true);
          }
        };
  
        const obs = new MutationObserver(() => check());
        obs.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
  
        const tick = setInterval(() => {
          check();
          if (now() - t0 >= UPLOAD_MAX_WAIT_MS) {
            clearInterval(tick);
          }
        }, 300);
  
        check();
      });
    }
  
    async function attachAttachments(attachments = []) {
      if (!attachments?.length) return;
      const files = [];
      for (const att of attachments) {
        try {
          files.push(await fetchAsFile(att));
        } catch (e) {
          console.warn('附件下载失败，跳过：', att, e);
        }
      }
      if (!files.length) return;
  
      try {
        await attachFilesToInput(files);
      } catch (e) {
        console.warn('通过 <input type=file> 附件失败，尝试拖拽：', e);
        await dropFilesToZone(files);
      }
  
      await waitUploadIdle({ mustHaveAttachments: true });
    }
  
    /********************** 队列串行 ************************/
    const queue = [];
    const seen  = new Set();
    let   busy  = false;
  
    function enqueue(q) {
      if (!q) return;
      const id = q.id != null ? String(q.id) : '';
      if (id && seen.has(id)) return;
      if (id) seen.add(id);
      queue.push(q);
      pump();
    }
  
    async function pump() {
      if (busy) return;
      busy = true;
  
      while (queue.length) {
        const q = queue.shift();
        try {
          const text = q.text || q.content || q.prompt || '';
          log('处理问题：', q);
  
          if (Array.isArray(q.attachments) && q.attachments.length) {
            await attachAttachments(q.attachments);
            await waitSendEnabled();
            await sleep(150);
          }
  
          const answer = await sendAndWaitAnswer(text);
          const cleaned = normalizeAnswer(answer);
          if (!cleaned) { await sleep(100); continue; }
  
          // 幂等：同一 questionId 相同答案不重复回传
          if (q.id != null) {
            const key = String(q.id);
            const h = hashText(cleaned);
            if (lastSentAnswer.get(key) === h) {
              log('跳过重复答案（幂等）', key);
            } else {
              await postAnswerBack(key, cleaned);
              lastSentAnswer.set(key, h);
            }
          } else {
            await postAnswerBack(q.id, cleaned);
          }
        } catch (e) {
          console.warn('处理失败：', e);
          // 可选：向后端报告失败
          // await postAnswerBack(q.id, '[发送或抓取失败] ' + (e.message || e));
        }
        await sleep(120);
      }
  
      busy = false;
    }
  
    async function postAnswerBack(questionId, answerText) {
      if (!answerText) return;
      try {
        const payload = { questionId, answer: answerText, ts: Date.now() };
        await gmFetch({
          url:     ANSWER_POST_URL,
          method:  'POST',
          json:    payload,
          headers: buildHeaders(),
          timeout: 30000
        });
        log('答案已回传：', questionId);
      } catch (e) {
        console.warn('回传失败', e);
      }
    }
  
    /********************** 长轮询 ************************/
    let cursor     = null;
    let backoff    = 1000;
    const backMax  = 15000;
  
    async function longPollLoop() {
      for (;;) {
        let url = POLL_URL;
        if (cursor) {
          url += (url.includes('?') ? '&' : '?') + 'cursor=' + encodeURIComponent(cursor);
        }
        try {
          const { status, body } = await gmFetch({
            url,
            method: 'GET',
            headers: buildHeaders(),
            timeout: (LONG_POLL_TIMEOUT_SEC + 5) * 1000,
            responseType: 'json'
          });
  
          if (status === 200 && body) {
            const items = Array.isArray(body?.items) ? body.items
                       : (Array.isArray(body) ? body
                       :  (body?.id || body?.text || body?.content || body?.prompt ? [body] : []));
            if (items.length) items.forEach(enqueue);
            if (body?.nextCursor) cursor = body.nextCursor;
            backoff = 1000;
            continue;
          }
  
          if (status === 204 || status === 304 || status === 202 || !body) {
            await sleep(IDLE_BACKOFF_MS);
            backoff = Math.min(backoff * 1.2, backMax);
            continue;
          }
  
          console.warn('轮询异常状态：', status, body);
          await sleep(backoff);
          backoff = Math.min(backoff * 2, backMax);
        } catch (e) {
          console.warn('轮询异常：', e);
          await sleep(backoff);
          backoff = Math.min(backoff * 2, backMax);
        }
      }
    }
  
    /********************** 启动 ************************/
    (async function boot() {
      log('脚本启动（长轮询 + React-Safe 输入/发送 + 附件支持 + 上传完成再发送 + 网络优先抓包）');
      injectNetSniffer();             // ← 新增：注入网络抓包
      await sleep(800);
      longPollLoop();
    })();
  
  })();
  