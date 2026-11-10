// One room = one row. State is JSON; the secret is hidden from the guesser until the round ends.
// Open to any page: the game also runs from its GitHub copy on .ek, which is another address.
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS } });
export function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

async function ensure(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, state TEXT NOT NULL, updated INTEGER NOT NULL)').run();
}
async function load(db, code) {
  const r = await db.prepare('SELECT state FROM rooms WHERE code=?').bind(code).first();
  return r ? JSON.parse(r.state) : null;
}
async function save(db, code, st) {
  st.ver = (st.ver || 0) + 1;
  await db.prepare('INSERT OR REPLACE INTO rooms (code,state,updated) VALUES (?,?,?)').bind(code, JSON.stringify(st), Date.now()).run();
}
function shuffled() { const a = [...Array(16).keys()]; for (let i = 15; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function freshRound(st) {
  Object.assign(st, { order: shuffled(), secret: null, phase: st.picker && st.guesser ? 'pick' : 'waiting', q: [], out: [], result: null });
}
function assignRandom(st) {
  const [a, b] = Math.random() < 0.5 ? st.players : [...st.players].reverse();
  st.picker = a; st.guesser = b;
}
function view(st, me) {
  const role = st.picker === me ? 'picker' : st.guesser === me ? 'guesser' : null;
  const v = { ...st, role };
  delete v.picker; delete v.guesser; delete v.players;
  v.picked = st.secret != null;
  if (role !== 'picker' && st.phase !== 'over') v.secret = null;
  return v;
}

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const code = (u.searchParams.get('code') || '').toUpperCase(), me = u.searchParams.get('me') || '';
  await ensure(env.DB);
  const st = await load(env.DB, code);
  if (!st) return json({ error: 'Room not found' }, 404);
  return json(view(st, me));
}

export async function onRequestPost({ request, env }) {
  const b = await request.json().catch(() => ({}));
  const me = String(b.me || '').slice(0, 40);
  if (!me) return json({ error: 'missing player id' }, 400);
  const db = env.DB; await ensure(db);

  if (b.action === 'create') {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    const st = { players: [me], picker: null, guesser: null };
    freshRound(st);
    await save(db, code, st);
    // tidy up old rooms
    await db.prepare('DELETE FROM rooms WHERE updated < ?').bind(Date.now() - 2 * 864e5).run();
    return json({ code, state: view(st, me) });
  }

  const code = String(b.code || '').toUpperCase();
  const st = await load(db, code);
  if (!st) return json({ error: 'Room not found' }, 404);
  const isP = st.picker === me, isG = st.guesser === me;
  const bad = m => json({ error: m }, 400);

  switch (b.action) {
    case 'join':
      if (st.players.includes(me)) break;
      if (st.players.length >= 2) return bad('Room is full');
      st.players.push(me);
      assignRandom(st);
      freshRound(st);
      break;
    case 'pick':
      if (!isP || st.phase !== 'pick') return bad('Not your move');
      if (!(b.card >= 0 && b.card < 16)) return bad('bad card');
      st.secret = b.card; st.phase = 'ask';
      break;
    case 'ask': {
      const t = String(b.text || '').trim().slice(0, 200);
      if (!isG || st.phase !== 'ask' || !t) return bad('Not your move');
      st.q.push({ t, a: null }); st.phase = 'answer';
      break;
    }
    case 'answer':
      if (!isP || st.phase !== 'answer') return bad('Not your move');
      st.q[st.q.length - 1].a = b.answer ? 'yes' : 'no'; st.phase = 'elim';
      break;
    case 'elim': {
      if (!isG || st.phase !== 'elim') return bad('Not your move');
      st.out = [...new Set((b.out || []).filter(n => n >= 0 && n < 16))];
      if (st.out.includes(st.secret)) { st.phase = 'over'; st.result = { win: false, reason: 'eliminated' }; }
      else st.phase = 'ask';
      break;
    }
    case 'guess':
      if (!isG || st.phase !== 'ask') return bad('Not your move');
      st.phase = 'over';
      st.result = b.card === st.secret ? { win: true, reason: 'guessed', card: b.card } : { win: false, reason: 'wrong', card: b.card };
      break;
    case 'again': // new random roles for the next round
      if (!isP && !isG) return bad('Not in room');
      if (st.phase !== 'over') break;
      assignRandom(st);
      freshRound(st);
      break;
    default: return bad('unknown action');
  }
  await save(db, code, st);
  return json({ code, state: view(st, me) });
}
