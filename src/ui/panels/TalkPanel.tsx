import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Loader2, Send, Sparkles } from 'lucide-react';
import { useCase } from '@/client/stores';
import { simClient } from '@/client/simClient';
import { api, health } from '@/client/api';
import { buildPatientContext, fallbackPatientReply } from '@/client/aiContext';
import { formatClock } from '@/sim/core/math';
import { Badge, Button, inputCls } from '../common';

const QUICK = ['What happened?', 'Where is the pain?', 'Are you allergic to anything?', 'What medications do you take?', 'Any medical problems?', 'Have you taken any drugs or alcohol?'];

export function TalkPanel() {
  const meta = useCase((s) => s.meta);
  const chat = useCase((s) => s.chat);
  const addChat = useCase((s) => s.addChat);
  const dispatch = useCase((s) => s.dispatch);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [aiOn, setAiOn] = useState<boolean | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    health().then((h) => setAiOn(h.ai));
  }, []);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [chat.length]);

  const ask = async (q: string) => {
    const snap = simClient().latest;
    if (!meta || !snap || !q.trim()) return;
    setText('');
    addChat({ role: 'user', text: q, t: snap.t });
    dispatch({ type: 'exam.perform', exam: 'history', detail: q.slice(0, 120) });
    const ctx = buildPatientContext(meta, snap, useCase.getState().events);
    setBusy(true);
    let reply: { speech: string; nonverbal: string } | null = null;
    let source: 'ai' | 'fallback' = 'fallback';
    if (aiOn) {
      const history = useCase
        .getState()
        .chat.slice(-10)
        .map((m) => ({ role: m.role === 'user' ? 'clinician' : 'patient', text: m.text }));
      const r = await api.patientChat({ context: ctx, history, question: q });
      if (r.ok && r.data) {
        reply = { speech: r.data.reply.speech, nonverbal: r.data.reply.nonverbal };
        source = 'ai';
      }
    }
    if (!reply) reply = fallbackPatientReply(ctx, q);
    setBusy(false);
    const now = simClient().latest?.t ?? snap.t;
    addChat({ role: 'patient', text: reply.speech, cue: reply.nonverbal, t: now, source });
  };

  if (!meta) return null;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-[11.5px] text-ink-3">
        {aiOn ? (
          <Badge tone="accent">
            <Sparkles size={10} /> AI patient
          </Badge>
        ) : (
          <Badge>Scripted fallback</Badge>
        )}
        <span>Replies are shaped by the simulated level of consciousness, breathlessness and pain.</span>
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3 scroll-thin" data-testid="chat-log">
        {chat.length === 0 && <p className="text-[12.5px] text-ink-3">Introduce yourself and take a history. An obtunded, intubated or severely breathless patient may not be able to answer.</p>}
        <ul className="flex flex-col gap-2.5">
          {chat.map((m) => (
            <li key={m.id} className={clsx('flex flex-col', m.role === 'user' ? 'items-end' : 'items-start')}>
              {m.text && (
                <div className={clsx('max-w-[85%] rounded-2xl px-3 py-2 text-[13px] leading-snug', m.role === 'user' ? 'rounded-br-md bg-accent text-accent-ink' : 'rounded-bl-md bg-surface-3 text-ink')}>{m.text}</div>
              )}
              {m.cue && <div className="mt-0.5 max-w-[85%] text-[11.5px] italic text-ink-3">{m.cue}</div>}
              <span className="mt-0.5 text-[10px] text-ink-3">
                {formatClock(m.t)}
                {m.role === 'patient' && m.source === 'fallback' ? ' · scripted' : ''}
              </span>
            </li>
          ))}
          {busy && (
            <li className="flex items-center gap-2 text-[12px] text-ink-3">
              <Loader2 size={13} className="animate-spin" /> patient responding…
            </li>
          )}
        </ul>
      </div>
      <div className="border-t border-line p-3">
        <div className="mb-2 flex flex-wrap gap-1">
          {QUICK.map((q) => (
            <button key={q} onClick={() => void ask(q)} disabled={busy} className="rounded-full border border-line px-2 py-0.5 text-[11.5px] text-ink-2 hover:border-accent/50 hover:text-accent">
              {q}
            </button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(text);
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask the patient…" className={inputCls} data-testid="chat-input" />
          <Button type="submit" variant="primary" disabled={busy || !text.trim()} data-testid="chat-send">
            <Send size={14} />
          </Button>
        </form>
      </div>
    </div>
  );
}
