// ==UserScript==
// @name         WPP Chat iframe Q/A Bridge (Long-Polling)
// @namespace    http://tampermonkey.net/
// @version      1.2.0
// @description  在 https://open-web-deeplink-cs.wpp.ai/* 的 iframe 内：长轮询第三方获取问题 -> 送入聊天 -> 捕获答案 -> 回传第三方
// @match        https://open-web-deeplink-cs.wpp.ai/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect        127.0.0.1
// ==/UserScript==

(function () {
    'use strict';
  
    /********************** 配置区（按需修改） ************************/
    // ★ 长轮询端点（服务应在有消息时立即返回；无消息可挂起 20~60s 后返回 204/空数组）
    const POLL_URL        = 'http://127.0.0.1:7080/v1/questions/long-poll';
    //   请求参数约定：?cursor=xxx（下方脚本会自动在 URL 上拼接）
    //   期望响应示例：
    //   { items: [{id: 'q1', text: 'Hello?'}], nextCursor: 'abc123' }
    //   或返回 204/空 body 表示无新消息
  
    // ★ 回传答案的接口（POST）
  
    const ANSWER_POST_URL = 'http://127.0.0.1:7080/v1/answers';
  
    // ★ 鉴权（如不需要可留空）；若你用 Cookie，则可不填
    const AUTH_HEADER     = 'Bearer YOUR_TOKEN_HERE';
    const EXTRA_HEADERS   = { /* 'X-Tenant': 'foo' */ };
  
    // ★ 轮询与稳定性
    const LONG_POLL_TIMEOUT_SEC = 30;  // 后端挂起时长建议 20~60s（由后端控制）；客户端只做请求超时兜底
    const IDLE_BACKOFF_MS       = 1200;// 无消息时，下一次请求前等待（避免空转）
    const STABLE_MS             = 800; // 答案流式渲染“静默”多久视为稳定
  
    // ★ 聊天 UI 选择器（不工作时再微调）
    const SELECTORS = {
      chatRoot:   '#micro-app, body',
      input:      'textarea, [role="textbox"][contenteditable="true"]',
      sendBtn:    'button[data-testid*="send"], button[aria-label*="Send"], button:has(svg[data-testid*="send"])',
      messageBox: '[data-message], [data-testid*="message"], .message, .chat-message',
      assistant:  '[data-role="assistant"], [data-author="assistant"], [data-testid*="assistant"], .assistant, .ai, [aria-label*="assistant"]',
      textNodes:  '[data-testid*="markdown"], [data-testid*="content"], .content, .markdown, .text, [role="article"], [role="document"]'
    };
  
    /********************** 常用工具 ************************/
    const log   = (...a) => console.log('[LP-QA]', ...a);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  
    function buildHeaders(extra = {}) {
      const h = { Accept: 'application/json', ...extra };
      if (AUTH_HEADER) h['Authorization'] = AUTH_HEADER;
      Object.assign(h, EXTRA_HEADERS || {});
      return h;
    }
  
    // Tampermonkey 的跨域请求封装
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
  
    /********************** 聊天 UI 操作 ************************/
    async function waitForInput() {
      for (let i = 0; i < 40; i++) {
        const el = document.querySelector(SELECTORS.input);
        if (el) return el;
        await sleep(250);
      }
      throw new Error('找不到聊天输入框');
    }
  
    function setInputValue(el, text) {
      if (!el) return;
      if ('value' in el) {
        el.value = text;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = text;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
      }
    }
  
    function findSendButton() {
      let btn = document.querySelector(SELECTORS.sendBtn);
      if (btn) return btn;
      // 兜底：找包含 "Send"/"发送" 的按钮
      const guess = Array.from(document.querySelectorAll('button')).find(b =>
        /send|发送/i.test(b.textContent || '') ||
        /send/i.test(b.getAttribute('aria-label') || '') ||
        /send/i.test(b.getAttribute('data-testid') || '')
      );
      return guess || null;
    }
  
    async function sendToChat(text) {
      const input = await waitForInput();
      setInputValue(input, text);
      await sleep(50);
      const btn = findSendButton();
      if (!btn) throw new Error('找不到发送按钮');
      btn.click();
    }
  
    // 监听助手最新一条消息并在稳定后回调
    function watchAssistant(onStable) {
      const root = document.querySelector(SELECTORS.chatRoot) || document.body;
      let stableTimer = null;
      let lastText = '';
  
      const gatherText = (node) => {
        const bits = [];
        const nodes = node.querySelectorAll(SELECTORS.textNodes);
        if (nodes.length) nodes.forEach(n => bits.push(n.innerText?.trim() || ''));
        else bits.push(node.innerText?.trim() || '');
        return bits.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      };
  
      const obs = new MutationObserver(() => {
        const all = Array.from(document.querySelectorAll(SELECTORS.messageBox));
        if (!all.length) return;
  
        // 优先选择“助手”样式标记的最后一条，其次选择最后一条消息兜底
        const assistants = all.filter(n =>
          n.matches(SELECTORS.assistant) ||
          /\bassistant\b|\bai\b/i.test(n.className || '') ||
          /\bassistant\b/i.test(n.getAttribute?.('data-author') || '')
        );
        const last = assistants[assistants.length - 1] || all[all.length - 1];
        if (!last) return;
  
        const text = gatherText(last);
        if (!text) return;
  
        if (stableTimer) clearTimeout(stableTimer);
        stableTimer = setTimeout(() => {
          if (text === lastText) return;
          lastText = text;
          onStable(text);
        }, STABLE_MS);
      });
  
      obs.observe(root, { childList: true, subtree: true, characterData: true });
      log('已启动助手答案监听器');
      return () => obs.disconnect();
    }
  
    /********************** 队列：逐条处理问题 ************************/
    const queue = [];
    const seen  = new Set(); // 去重
    let   busy  = false;
    let   currentQ = null;
  
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
  
    // 将问题压入队列
    function enqueue(q) {
      if (!q) return;
      const id = String(q.id ?? '');
      if (id && seen.has(id)) return; // 去重
      if (id) seen.add(id);
      queue.push(q);
      pump();
    }
  
    // 串行执行
    async function pump() {
      if (busy) return;
      busy = true;
  
      while (queue.length) {
        const q = queue.shift();
        currentQ = q;
        try {
          log('处理问题：', q);
          await sendToChat(q.text || q.content || q.prompt || '');
          // 答案监听器会在稳定时触发 postAnswerBack
          // 这里可以放一个最长等待（可选）
        } catch (e) {
          console.warn('发送到聊天失败：', e);
          // 失败也回个失败状态（可选自行扩展）
          // await postAnswerBack(q.id, '[发送失败] ' + (e.message || e));
        }
        // 适当间隔，避免 UI 卡顿
        await sleep(150);
      }
  
      currentQ = null;
      busy = false;
    }
  
    // 安装答案监听：一旦稳定就回传
    watchAssistant((answerText) => {
      if (!currentQ) return;            // 只回当前问题的答案（简单串行策略）
      postAnswerBack(currentQ.id, answerText);
    });
  
    /********************** 长轮询（含游标与退避） ************************/
    let cursor     = null;
    let backoff    = 1000;  // 指数退避起点
    const backMax  = 15000; // 上限
  
    async function longPollLoop() {
      for (;;) {
        let url = POLL_URL;
        if (cursor) {
          const sep = url.includes('?') ? '&' : '?';
          url = `${url}${sep}cursor=${encodeURIComponent(cursor)}`;
        }
  
        try {
          const { status, body } = await gmFetch({
            url,
            method: 'GET',
            headers: buildHeaders(),
            // 超时兜底（如果后端没挂起或网络异常）
            timeout: (LONG_POLL_TIMEOUT_SEC + 5) * 1000,
            responseType: 'json'
          });
  
          if (status === 200 && body) {
            // 兼容：可能返回 {items:[], nextCursor} 或单条对象
            const items = Array.isArray(body.items) ? body.items
                       : (Array.isArray(body) ? body
                       :  (body.item ? [body.item] : (body.id || body.text ? [body] : [])));
  
            if (items.length) {
              items.forEach(enqueue);
            }
  
            if (body.nextCursor) cursor = body.nextCursor;
  
            // 有结果 => 恢复退避
            backoff = 1000;
            // 立即进入下一轮（长轮询特性）
            continue;
          }
  
          if (status === 204 || status === 304 || status === 202 || !body) {
            // 无新消息：轻微等待再发起下一次
            await sleep(IDLE_BACKOFF_MS);
            backoff = Math.min(backoff * 1.2, backMax); // 平缓增加
            continue;
          }
  
          // 其它状态当成错误处理
          console.warn('轮询返回异常状态：', status, body);
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
      log('脚本启动（长轮询模式）');
      // 给页面一点初始化时间
      await sleep(1000);
      longPollLoop();
    })();
  
  })();
  