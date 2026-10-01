import './env';
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { z } from 'zod';
import { aiAvailable, FAST_MODEL, generateScenario, instructorReply, MODEL, patientReply, writeDebrief } from './ai';
import { DebriefRequestSchema, InstructorRequestSchema, PatientRequestSchema, ScenarioRequestSchema } from './schemas';

const app = express();
// Optional CORS for a separately hosted front end: ALLOWED_ORIGIN=https://user.github.io
const allowedOrigin = process.env.ALLOWED_ORIGIN?.trim();
if (allowedOrigin) {
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });
}
app.use(express.json({ limit: '2mb' }));

// Simple per-IP rate limit for AI endpoints (prototype safeguard)
const hits = new Map<string, number[]>();
function rateLimit(req: Request, res: Response, next: NextFunction) {
  const key = req.ip ?? 'local';
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= 40) {
    res.status(429).json({ ok: false, error: 'Too many AI requests — slow down' });
    return;
  }
  list.push(now);
  hits.set(key, list);
  next();
}

function handler<S extends z.ZodType>(schema: S, fn: (body: z.infer<S>) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    if (!aiAvailable()) {
      res.status(503).json({ ok: false, error: 'AI service not configured (set OPENAI_API_KEY on the server)' });
      return;
    }
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid request', issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) });
      return;
    }
    try {
      const out = await fn(parsed.data);
      res.json({ ok: true, ...(out as object) });
    } catch (e) {
      const msg = (e as Error).message ?? 'AI error';
      console.error(`[ai] ${req.path}:`, msg);
      res.status(502).json({ ok: false, error: msg.slice(0, 300) });
    }
  };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ai: aiAvailable(), model: aiAvailable() ? `${MODEL} / ${FAST_MODEL}` : null });
});

app.post('/api/ai/patient', rateLimit, handler(PatientRequestSchema, async (b) => ({ reply: await patientReply(b.context, b.history, b.question) })));
app.post('/api/ai/instructor', rateLimit, handler(InstructorRequestSchema, async (b) => ({ reply: await instructorReply(b) })));
app.post('/api/ai/scenario', rateLimit, handler(ScenarioRequestSchema, async (b) => generateScenario(b.prompt)));
app.post('/api/ai/debrief', rateLimit, handler(DebriefRequestSchema, async (b) => ({ debrief: await writeDebrief(b) })));

// Production: serve the built client
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
if (existsSync(dist)) {
  app.use(express.static(dist, { maxAge: '1h', index: false }));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`Vitalis API on http://localhost:${port} — AI ${aiAvailable() ? `enabled (${MODEL}, ${FAST_MODEL})` : 'disabled (no OPENAI_API_KEY)'}`);
});
