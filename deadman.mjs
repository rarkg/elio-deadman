#!/usr/bin/env node
// Dead-man switch. Runs on GitHub Actions every 5 minutes, outside the machine it watches.
// Reads a heartbeat (a Firestore document the machine rewrites every minute). If the heartbeat is older
// than MAX_AGE_MIN (15), or the machine has reported itself down for that long, it alerts once on Discord
// (DISCORD_WEBHOOK) and once more when the heartbeat is back.
// With no webhook configured the run fails instead, so GitHub's own failed-run email still goes out.
// State (which outage was already announced) lives in state.json in this repository.
//
// The guard auditor (2026-11-11): the heartbeat also carries the auditor's last run (auditAt), the longest gap between
// its runs in the last 24 hours (auditGapMax, minutes) with when that gap ended (auditGapEnd), and the seal value
// (seal). Every run logs them, so this log is an off-Mac history of the seal. A stopped auditor alarms once: silent now
// (last run over AUDIT_MAX_MIN ago while the machine itself reports), or a gap over AUDIT_MAX_MIN that ended since the
// previous check (GitHub runs this schedule hours apart, so a short stop would otherwise fall between two reads). A gap
// the machine marked as a drill (auditDrill) is logged as "[drill] auditor gap" and excused at most once a week.
import { readFileSync, writeFileSync } from 'node:fs';

const MAX_AGE_MIN = Number(process.env.MAX_AGE_MIN || 15);
const PULSE_URL = process.env.PULSE_URL;
const HOOK = process.env.DISCORD_WEBHOOK || '';
const DRILL = process.env.DRILL === 'true';
const AUDIT_MAX_MIN = Number(process.env.AUDIT_MAX_MIN || 45);
const DRILL_EXCUSE_EVERY_MS = 6 * 24 * 3600e3;
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
let at = null, mode = null, audit = null;
try {
  const r = await fetch(PULSE_URL, { signal: AbortSignal.timeout(20000) });
  if (r.ok) {
    const d = await r.json(); const f = d.fields || {};
    at = field(f.at); mode = field(f.state);
    if (f.auditAt || f.auditGapMax) audit = { at: field(f.auditAt), gapMax: field(f.auditGapMax), gapEnd: field(f.auditGapEnd), drill: f.auditDrill ? f.auditDrill.booleanValue === true : false, seal: field(f.seal) };
  }
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
// The auditor, read only while the machine itself is reporting (a silent machine is the alert above).
if (audit) {
  state.auditSeen = true;
  const age = audit.at ? (now - audit.at) / 60000 : Infinity;
  const gapNew = audit.gapMax > AUDIT_MAX_MIN && audit.gapEnd && audit.gapEnd > (state.lastRunAt || 0) && audit.gapEnd !== state.lastGapEnd;
  console.log(`auditor: last run ${Number.isFinite(age) ? age.toFixed(1) : 'never'} min ago; longest gap in 24 h ${audit.gapMax} min${audit.gapEnd ? ` (ended ${new Date(audit.gapEnd).toISOString()})` : ' (still open)'}; seal ${audit.seal ?? 'none'}`);
  if (!silent && gapNew) {
    state.lastGapEnd = audit.gapEnd;
    if (audit.drill && now - (state.lastDrillExcusedAt || 0) > DRILL_EXCUSE_EVERY_MS) { state.lastDrillExcusedAt = now; console.log(`[drill] auditor gap ${audit.gapMax} min, ended ${new Date(audit.gapEnd).toISOString()}: a declared drill, logged and not alarmed`); }
    else await say(`${tag}The guard auditor on the machine stopped for ${Math.round(audit.gapMax)} min (back at ${pt(audit.gapEnd)} PT). A stopped auditor is how a talked-into agent would hide a change. Seal ${audit.seal ?? 'none'}.`).then(() => console.log(`auditor gap ${audit.gapMax} min alerted`));
  }
  if (!silent && age > AUDIT_MAX_MIN && !state.auditAlertedAt) { if (await say(`${tag}The guard auditor on the machine has not run for ${Math.round(age)} min while the machine is up. Seal ${audit.seal ?? 'none'}.`)) state.auditAlertedAt = now; console.log(`auditor silent ${Math.round(age)} min alerted`); }
  else if (age <= AUDIT_MAX_MIN && state.auditAlertedAt) { await say(`${tag}The guard auditor is running again (last run ${pt(audit.at)} PT). Seal ${audit.seal ?? 'none'}.`); state.auditAlertedAt = null; }
} else if (state.auditSeen && !silent) {
  console.log('auditor silent: the heartbeat no longer carries the auditor fields');
  if (!state.auditAlertedAt) { if (await say(`${tag}The machine's heartbeat stopped carrying the guard auditor's state. Treat the auditor as stopped until it is back.`)) state.auditAlertedAt = now; }
}
state.lastRunAt = now;
state.lastAgeMin = Math.round(ageMin * 10) / 10;
writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
