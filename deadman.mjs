#!/usr/bin/env node
// Dead-man switch. Runs on GitHub Actions every 5 minutes, outside the machine it watches.
// Reads a heartbeat (a Firestore document the machine rewrites every minute). If the heartbeat is older
// than MAX_AGE_MIN (15), or the machine has reported itself down for that long, it alerts once on Discord
// (DISCORD_WEBHOOK) and once more when the heartbeat is back.
// With no webhook configured the run fails instead, so GitHub's own failed-run email still goes out.
// State (which outage was already announced) lives in state.json in this repository.
import { readFileSync, writeFileSync } from 'node:fs';

const MAX_AGE_MIN = Number(process.env.MAX_AGE_MIN || 15);
const PULSE_URL = process.env.PULSE_URL;
const HOOK = process.env.DISCORD_WEBHOOK || '';
const DRILL = process.env.DRILL === 'true';
const now = Date.now();
const STATE_FILE = DRILL ? 'state-drill.json' : 'state.json'; // drills never touch the real outage state
const state = (() => { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } })();

const field = (f) => (f ? f.integerValue !== undefined ? Number(f.integerValue) : f.doubleValue ?? f.stringValue ?? null : null);
const pt = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));

async function say(text) {
  if (!HOOK) { console.log(`ALERT (no webhook set, failing the run so GitHub emails): ${text}`); process.exitCode = 1; return false; }
  const r = await fetch(HOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }) });
  console.log(`posted to Discord: ${r.status}`);
  if (!r.ok) process.exitCode = 1;
  return r.ok;
}

if (!PULSE_URL) { console.log('PULSE_URL secret missing'); process.exit(1); }
let at = null, mode = null;
try {
  const r = await fetch(PULSE_URL, { signal: AbortSignal.timeout(20000) });
  if (r.ok) { const d = await r.json(); at = field(d.fields && d.fields.at); mode = field(d.fields && d.fields.state); }
  else console.log(`heartbeat read failed: ${r.status}`);
} catch (e) { console.log(`heartbeat read failed: ${e.message}`); }

const ageMin = at ? (now - at) / 60000 : Infinity;
const tag = DRILL ? '[drill] ' : '';
console.log(`heartbeat ${at ? new Date(at).toISOString() : 'missing'} (${ageMin.toFixed(1)} min old), state ${mode}`);
const silent = ageMin > MAX_AGE_MIN;
const downLong = mode && mode !== 'online' && mode !== 'paused' && state.downSeenAt && now - state.downSeenAt > MAX_AGE_MIN * 60000;
if (mode && mode !== 'online' && mode !== 'paused') state.downSeenAt = state.downSeenAt || now; else state.downSeenAt = null;

if ((silent || downLong) && !state.alertedAt) {
  const text = silent
    ? `${tag}The machine has gone quiet: no heartbeat for ${Math.round(ageMin)} min (last ${at ? pt(at) : 'never'} PT). Nothing on it can report while it is off or offline. Check that it is on and online.`
    : `${tag}It has been down for over ${MAX_AGE_MIN} min and has not recovered by itself (the machine is up and reporting). It may need you.`;
  if (await say(text)) state.alertedAt = now;
  else state.alertedAt = HOOK ? null : now;
} else if (!silent && !downLong && state.alertedAt) {
  await say(`${tag}Back: heartbeat ${pt(at)} PT (was out about ${Math.round((now - state.alertedAt) / 60000) + MAX_AGE_MIN} min).`);
  state.alertedAt = null;
}
state.lastRunAt = now;
state.lastAgeMin = Math.round(ageMin * 10) / 10;
writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
