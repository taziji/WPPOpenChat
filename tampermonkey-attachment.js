// ==UserScript==
// @name         WPP Chat iframe Q/A Bridge (Long-Polling, React-Safe + Attachments + Upload-Aware)
// @namespace    http://tampermonkey.net/
// @version      1.5.0
// @description  长轮询第三方问题(+附件) -> 先上传并等待完成 -> 再安全送入聊天 -> 等稳定后回传答案
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
    const UPLOAD_IDLE_GRACE_MS  = 800;   // 最后一次变化后需静默多久判定“空闲”
    const UPLOAD_MAX_WAIT_MS    = 120000; // 附件整批上传最长等 120s
    const SEND_ENABLE_MAX_WAIT  = 60000; // 发送按钮可用最长等待
  
    const SELECTORS = {
      chatRoot:   '#micro-app, body',
      input:      '#input, textarea#input',
      sendBtn:    '#chat-send-button',
  
      // 上传相关（尽量通用 + AntD 的常见类）
      fileInput:  'input[type="file"]',
      uploadBtn:  '[data-testid*="upload"],[data-testid*="attachment"],[aria-label*="upload"],[aria-label*="附件"]',
      dropZone:   '[data-testid*="drop"],[class*="dropzone"],[class*="upload"]',
  
      // 正在上传/忙碌状态探测（多重启发）
      uploadingHints: [
        '.ant-upload-list-item-uploading',
        '.ant-progress',
        '[aria-busy="true"]',
        '[data-state="uploading"]',
        '[data-testid*="uploading"]',
        '.uploading',
        '.is-uploading'
      ].join(','),
  
      // 已附加的“附件 chip/条目”探测（用于确认至少有附件入列）
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
  
    async function waitFor(condFn, { timeout = 10000, interval = 150 } = {}) {
      const t0 = now();
      // 先立即尝试一次
      try { if (await condFn()) return true; } catch {}
      while (now() - t0 < timeout) {
        await sleep(interval);
        try {
          if (await condFn()) return true;
        } catch {}
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
  
    // 发送按钮可用等待（双保险：附件期间可能禁用）
    async function waitSendEnabled() {
      return await waitFor(() => {
        const btn = findSendButton();
        return btn && !isElementDisabled(btn);
      }, { timeout: SEND_ENABLE_MAX_WAIT, interval: 200 });
    }
  
    async function sendToChat(text) {
      const input = await waitForInput();
      setInputValueReactSafe(input, text);
      await sleep(60); // 让受控组件渲染
  
      // 等发送按钮可用（避免上传期间禁用导致点不到）
      await waitSendEnabled();
  
      const btn = findSendButton();
      if (btn && !isElementDisabled(btn)) {
        btn.click();
      } else {
        // 兜底：回车发送
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code:'Enter', which:13, keyCode:13, bubbles:true }));
      }
  
      // 发送后 150ms 若文本仍在，补一次回车
      setTimeout(() => {
        const el = document.querySelector(SELECTORS.input);
        if (!el) return;
        const val = 'value' in el ? el.value : el.textContent;
        if (val && String(val).trim().length) {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code:'Enter', which:13, keyCode:13, bubbles:true }));
        }
      }, 150);
    }
  
    /********************** 答案抓取（本次发送专属） ************************/
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
  
    async function sendAndWaitAnswer(text) {
      const baselineCount = getAllMessageNodes().length;
      const sendStartedAt = now();
      await sendToChat(text);
      const answer = await captureAnswerForThisSend(sendStartedAt, baselineCount);
      return answer;
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
  
    // —— 新增：上传空闲判定 —— //
    function uploadingNodes() {
      return Array.from(document.querySelectorAll(SELECTORS.uploadingHints));
    }
    function attachedItems() {
      return Array.from(document.querySelectorAll(SELECTORS.attachedItemHints));
    }
  
    async function waitUploadIdle({ mustHaveAttachments = true } = {}) {
      const t0 = now();
      let lastBusyAt = now();
  
      // 若要求“必须检测到有附件出现”，先等到至少出现一个“附件条目”或超时
      if (mustHaveAttachments) {
        await waitFor(() => attachedItems().length > 0, { timeout: UPLOAD_MAX_WAIT_MS / 2, interval: 200 });
      }
  
      // 监听上传相关区域变化，直到在连续 UPLOAD_IDLE_GRACE_MS 时间内没有“忙碌迹象”
      return new Promise((resolve) => {
        const root = document.querySelector(SELECTORS.chatRoot) || document.body;
  
        const check = () => {
          const busy = uploadingNodes().length > 0;
          if (busy) lastBusyAt = now();
  
          // 若发送按钮仍禁用，也视为忙碌（常见：上传中禁用发送）
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
  
        // 定时心跳，避免某些 UI 不触发 mutation
        const tick = setInterval(() => {
          check();
          if (now() - t0 >= UPLOAD_MAX_WAIT_MS) {
            clearInterval(tick);
          }
        }, 300);
  
        // 初次检查
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
  
      // 关键：等上传完成/按钮恢复
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
  
          // 有附件：先上传并等待“空闲/完成”
          if (Array.isArray(q.attachments) && q.attachments.length) {
            await attachAttachments(q.attachments);
            // 等发送按钮可用（再保险）
            await waitSendEnabled();
            // 给 UI 一点渲染时间
            await sleep(150);
          }
  
          // 再发送文本并等待答案
          const answer = await sendAndWaitAnswer(text);
  
          // 回传
          await postAnswerBack(q.id, answer);
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
      log('脚本启动（长轮询 + React-Safe 输入/发送 + 附件支持 + 上传完成再发送）');
      await sleep(800);
      longPollLoop();
    })();
  
  })();
  