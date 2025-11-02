import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';

const PORT = Number(process.env.PORT || 7080);
const HOST = process.env.HOST || '0.0.0.0';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});
app.use(express.json({ limit: '10mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

let nextQuestionId = 1;
let nextAttachmentId = 1;
const questions = [];
const answers = [];
const attachments = new Map();
const waiters = new Set();
const LONG_POLL_TIMEOUT_MS = 25000;

function buildAttachmentUrl(id) {
  return `/v1/attachments/${id}`;
}

function storeAttachment({ filename = 'file', mime = 'application/octet-stream', buffer }) {
  const id = nextAttachmentId++;
  const entry = {
    id,
    filename,
    mime,
    buffer,
    size: buffer.length,
    createdAt: Date.now()
  };
  attachments.set(id, entry);
  return {
    id,
    filename,
    mime,
    size: entry.size,
    url: buildAttachmentUrl(id)
  };
}

function parseDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl || '');
  if (!match) return null;
  const [, mime, b64] = match;
  return { mime: mime || 'application/octet-stream', buffer: Buffer.from(b64, 'base64') };
}

function normalizeAttachment(att = {}) {
  if (!att) return null;

  if (att.id && attachments.has(Number(att.id))) {
    const entry = attachments.get(Number(att.id));
    return {
      id: entry.id,
      filename: att.filename || entry.filename,
      mime: att.mime || entry.mime,
      size: entry.size,
      url: buildAttachmentUrl(entry.id)
    };
  }

  const dataSource = att.b64 || att.dataUrl || att.content;
  if (typeof dataSource === 'string') {
    let parsed = null;
    if (dataSource.startsWith('data:')) {
      parsed = parseDataUrl(dataSource);
    } else {
      const buffer = Buffer.from(dataSource, 'base64');
      parsed = { mime: att.mime || 'application/octet-stream', buffer };
    }
    if (parsed) {
      const desc = storeAttachment({
        filename: att.filename || 'file',
        mime: att.mime || parsed.mime,
        buffer: parsed.buffer
      });
      return desc;
    }
  }

  if (att.url) {
    return {
      filename: att.filename || att.url.split('/').pop()?.split('?')[0] || 'file',
      mime: att.mime || 'application/octet-stream',
      url: att.url
    };
  }

  return null;
}

function deliverPending() {
  if (!waiters.size) return;
  for (const waiter of Array.from(waiters)) {
    const { res, cursor, timer } = waiter;
    const items = questions.filter(q => q.id > cursor);
    if (items.length === 0) continue;

    clearTimeout(timer);
    waiters.delete(waiter);

    const nextCursor = items[items.length - 1].id;
    res.json({ items, nextCursor });
  }
}

app.post('/v1/questions', (req, res) => {
  const { text, attachments: rawAttachments } = req.body || {};
  if (!text || typeof text !== 'string') {
    res.status(400).json({ ok: false, error: 'Missing text' });
    return;
  }

  let processedAttachments = [];
  if (Array.isArray(rawAttachments) && rawAttachments.length) {
    processedAttachments = rawAttachments.map(normalizeAttachment).filter(Boolean);
  }

  const question = {
    id: nextQuestionId++,
    text,
    attachments: processedAttachments,
    ts: Date.now()
  };
  questions.push(question);
  deliverPending();

  res.json({ ok: true, question });
});

app.post('/v1/attachments', (req, res) => {
  const { filename, mime, content } = req.body || {};
  if (!content || typeof content !== 'string') {
    res.status(400).json({ ok: false, error: 'Missing content (base64 or data URL string)' });
    return;
  }

  let parsed = null;
  if (content.startsWith('data:')) {
    parsed = parseDataUrl(content);
  } else {
    parsed = { mime: mime || 'application/octet-stream', buffer: Buffer.from(content, 'base64') };
  }
  if (!parsed) {
    res.status(400).json({ ok: false, error: 'Invalid content encoding' });
    return;
  }

  const desc = storeAttachment({
    filename: filename || 'file',
    mime: mime || parsed.mime,
    buffer: parsed.buffer
  });

  res.json({ ok: true, attachment: desc });
});

app.post('/v1/attachments/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ ok: false, error: 'Missing file field' });
    return;
  }
  const desc = storeAttachment({
    filename: req.file.originalname || 'file',
    mime: req.file.mimetype || 'application/octet-stream',
    buffer: req.file.buffer
  });
  res.json({ ok: true, attachment: desc });
});

app.get('/v1/attachments/:id', (req, res) => {
  const id = Number(req.params.id);
  const entry = attachments.get(id);
  if (!entry) {
    res.status(404).json({ ok: false, error: 'Attachment not found' });
    return;
  }
  res.setHeader('Content-Type', entry.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(entry.filename || 'file')}"`);
  res.send(entry.buffer);
});

app.get('/v1/questions/long-poll', (req, res) => {
  const cursor = Number(req.query.cursor || 0) || 0;
  const items = questions.filter(q => q.id > cursor);

  if (items.length) {
    const nextCursor = items[items.length - 1].id;
    res.json({ items, nextCursor });
    return;
  }

  const timer = setTimeout(() => {
    waiters.delete(waiter);
    res.status(204).end();
  }, LONG_POLL_TIMEOUT_MS);

  const waiter = { res, cursor, timer };
  waiters.add(waiter);
});

app.post('/v1/answers', (req, res) => {
  const { questionId, answer } = req.body || {};
  if (!questionId || !answer) {
    res.status(400).json({ ok: false, error: 'Missing questionId or answer' });
    return;
  }

  const entry = {
    questionId,
    answer,
    ts: Date.now()
  };
  answers.push(entry);
  console.log('[Answer]', entry);
  res.json({ ok: true });
});

app.get('/admin/questions', (_req, res) => {
  res.json({ items: questions });
});

app.get('/admin/answers', (_req, res) => {
  res.json({ items: answers });
});

app.get('/admin/attachments', (_req, res) => {
  const list = Array.from(attachments.values()).map(({ buffer, ...rest }) => rest);
  res.json({ items: list });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`Long-poll API listening on http://${HOST}:${PORT}`);
});
