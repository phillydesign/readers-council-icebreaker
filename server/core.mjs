import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export class AppError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const clean = (s, max, label) => {
  if (typeof s !== 'string' || !s.trim() || s.trim().length > max) throw new AppError(`${label} must be 1–${max} characters.`);
  return s.trim();
};
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => [...randomBytes(8)].map(n => alphabet[n % alphabet.length]).join('');
const codePattern = /^[A-Z2-9]{8}$/;
const tokenPattern = /^[a-f0-9]{64}$/;

export const stateSQL = `SELECT r.code, r.title, r.questions, r.round, r.status, r.version, r.history,
 r.expires_at AS "expiresAt",
 (SELECT COUNT(*)::int FROM council_participants p WHERE p.room = r.code) AS joined,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',v.participant,'position',v.position) ORDER BY v.participant)
 FROM council_votes v WHERE v.room = r.code AND v.round = r.round), '[]'::jsonb) AS votes
 FROM council_rooms r WHERE r.code = $1 AND r.expires_at > now()`;
export function summarize(votes) {
  const out = { left: 0, right: 0, total: votes.length };
  for (const v of votes) out[v.position < 50 ? 'left' : 'right']++;
  return out;
}
async function state(db, code) {
  const { rows } = await db.query(stateSQL, [code]);
  const s = rows[0];
  if (!s) throw new AppError('This room was not found or has expired. Check the room code with your host.', 404);
  // Adapt previous three-category snapshots without rewriting saved event history.
  const history = s.history.map(item => ({ ...item, results: {
    left: item.results.left, right: item.results.right + (item.results.center || 0), total: item.results.total,
  } }));
  return { ...s, history, totalQuestions: s.questions.length, question: s.questions[s.round], responded: s.votes.length, results: summarize(s.votes) };
}
function hostToken(secret) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 12 * 3600000, nonce: randomBytes(16).toString('hex') })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
function checkHost(req, secret) {
  const token = bearer(req), [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) throw new AppError('Sign in as the host to continue.', 401);
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!same(signature, expected)) throw new AppError('Please sign in as the host again.', 401);
  try {
    if (!(JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now())) throw new Error();
  } catch { throw new AppError('Your host session expired. Please sign in again.', 401); }
}
function bearer(req) { return req.headers.get('authorization')?.replace(/^Bearer /, '') || ''; }
function requireRoom(row) {
  if (!row || new Date(row.expires_at).getTime() <= Date.now()) throw new AppError('This room was not found or has expired.', 404);
}
async function bodyOf(req) {
  if (!req.headers.get('content-type')?.includes('application/json')) throw new AppError('Use a JSON request.', 415);
  const reader = req.body?.getReader(); let size = 0; const chunks = [];
  if (reader) while (true) {
    const {done,value} = await reader.read(); if (done) break;
    size += value.length; if (size > 16384) { await reader.cancel(); throw new AppError('This request is too large.', 413); }
    chunks.push(value);
  }
  try { const body = JSON.parse(Buffer.concat(chunks).toString()); if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error(); return body; }
  catch { throw new AppError('This request could not be read.'); }
}
export function createAPI({ db, hostPassword, local = false }) {
  return async function api(req, { ip = 'unknown' } = {}) {
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
    const respond = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
    try {
      const url = new URL(req.url), path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '');
      const ready = typeof hostPassword === 'string' && hostPassword.length >= 16;
      if (req.method === 'GET' && path === '/status') return respond({ ready, local });
      if (!ready) throw new AppError('The host needs to finish the hosting setup before this room can open.', 503);
      if (req.method !== 'GET' && req.method !== 'POST') throw new AppError('Method not allowed.', 405);
      const origin = req.headers.get('origin');
      if (req.method === 'POST' && origin && origin !== url.origin) throw new AppError('This request must come from the event website.', 403);
      const body = req.method === 'POST' ? await bodyOf(req) : {};
      if (req.method === 'POST' && path === '/host/login') {
        const fingerprint = createHmac('sha256', hostPassword).update(ip).digest('hex');
        const {rows} = await db.query(`INSERT INTO council_login_attempts (fingerprint) VALUES ($1)
          ON CONFLICT (fingerprint) DO UPDATE SET
          attempts = CASE WHEN council_login_attempts.started_at < now() - interval '10 minutes' THEN 1 ELSE council_login_attempts.attempts + 1 END,
          started_at = CASE WHEN council_login_attempts.started_at < now() - interval '10 minutes' THEN now() ELSE council_login_attempts.started_at END RETURNING attempts`, [fingerprint]);
        if (rows[0].attempts > 12) throw new AppError('Too many sign-in attempts. Please try again in ten minutes.', 429);
        if (typeof body.password !== 'string' || !same(body.password, hostPassword)) throw new AppError('That host password did not match.', 401);
        await db.query('DELETE FROM council_login_attempts WHERE fingerprint = $1', [fingerprint]);
        return respond({ token: hostToken(hostPassword) });
      }
      if (req.method === 'POST' && path === '/rooms') {
        checkHost(req, hostPassword);
        const title = clean(body.title, 100, 'Session title');
        if (!Array.isArray(body.questions) || body.questions.length < 1 || body.questions.length > 4) throw new AppError('Add one to four questions.');
        const questions = body.questions.map(q => ({ prompt: clean(q?.prompt, 240, 'Question'), left: clean(q?.left, 70, 'Left label'), right: clean(q?.right, 70, 'Right label') }));
        // Expired event responses are removed when a host creates the next room.
        await db.query('DELETE FROM council_rooms WHERE expires_at < now()');
        await db.query("DELETE FROM council_login_attempts WHERE started_at < now() - interval '1 day'");
        for (let attempt = 0; attempt < 5; attempt++) {
          const code = newCode();
          const {rows} = await db.query('INSERT INTO council_rooms (code,title,questions) VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING RETURNING code', [code,title,JSON.stringify(questions)]);
          if (rows.length) return respond(await state(db,code),201);
        }
        throw new AppError('Could not create a room. Please try again.',503);
      }
      const match = path.match(/^\/rooms\/([^/]+)(?:\/(join|vote|control))?$/);
      if (!match || !codePattern.test(match[1])) throw new AppError('Room not found. Check the eight-character room code.',404);
      const [,code,action] = match;
      if (req.method === 'GET' && !action) return respond(await state(db,code));
      if (req.method !== 'POST') throw new AppError('Page not found.',404);
      if (action === 'join') {
        const existingToken = typeof body.participantToken === 'string' && tokenPattern.test(body.participantToken) ? body.participantToken : null;
        const result = await db.transaction(async client => {
          const {rows} = await client.query('SELECT * FROM council_rooms WHERE code=$1 FOR UPDATE',[code]); const room = rows[0]; requireRoom(room);
          if (existingToken) {
            const p = (await client.query('SELECT public_id FROM council_participants WHERE room=$1 AND token_hash=$2',[code,hash(existingToken)])).rows[0];
            if (p) return {participantToken:existingToken, participantId:p.public_id};
          }
          if (room.status === 'finished') throw new AppError('This session has ended.',409);
          const count = (await client.query('SELECT COUNT(*)::int AS n FROM council_participants WHERE room=$1',[code])).rows[0].n;
          if (count >= 80) throw new AppError('This room is full. Please contact the host.',409);
          const participantToken = randomBytes(32).toString('hex'), participantId = randomUUID();
          await client.query('INSERT INTO council_participants (room,token_hash,public_id) VALUES ($1,$2,$3)',[code,hash(participantToken),participantId]);
          return {participantToken,participantId};
        });
        return respond({...result,state:await state(db,code)});
      }
      if (action === 'vote') {
        const token = bearer(req);
        if (!tokenPattern.test(token)) throw new AppError('Please rejoin the room to vote.',401);
        if (!Number.isInteger(body.round) || !Number.isInteger(body.position) || body.position < 0 || body.position > 100 || !Number.isSafeInteger(body.sequence) || body.sequence < 0) throw new AppError('Choose a position on the slider.');
        const position = body.position === 50 ? 51 : body.position;
        const result = await db.transaction(async client => {
          // Shared locks allow simultaneous voters. Freeze takes an exclusive lock.
          const room = (await client.query('SELECT * FROM council_rooms WHERE code=$1 FOR SHARE',[code])).rows[0]; requireRoom(room);
          if (room.status !== 'open' || room.round !== body.round) throw new AppError('Voting has closed for this question.',409);
          const p = (await client.query('SELECT public_id FROM council_participants WHERE room=$1 AND token_hash=$2',[code,hash(token)])).rows[0];
          if (!p) throw new AppError('Please rejoin the room to vote.',401);
          const {rows} = await client.query(`INSERT INTO council_votes (room,round,participant,position,sequence) VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (room,round,participant) DO UPDATE SET position=EXCLUDED.position,sequence=EXCLUDED.sequence
            WHERE council_votes.sequence < EXCLUDED.sequence RETURNING round,position,sequence`,[code,body.round,p.public_id,position,body.sequence]);
          return rows[0] || (await client.query('SELECT round,position,sequence FROM council_votes WHERE room=$1 AND round=$2 AND participant=$3',[code,body.round,p.public_id])).rows[0];
        });
        return respond({...result,sequence:Number(result.sequence)});
      }
      if (action === 'control') {
        checkHost(req,hostPassword);
        await db.transaction(async client => {
          const room = (await client.query('SELECT * FROM council_rooms WHERE code=$1 FOR UPDATE',[code])).rows[0]; requireRoom(room);
          if (body.expectedVersion !== room.version) throw new AppError('This room changed. Refresh its status and try again.',409);
          let status, round = room.round, history = room.history;
          if (body.action === 'open' && room.status === 'waiting') status = 'open';
          else if (body.action === 'freeze' && room.status === 'open') {
            status = 'frozen';
            const votes = (await client.query('SELECT position FROM council_votes WHERE room=$1 AND round=$2',[code,round])).rows;
            history = [...history,{question:room.questions[round],results:summarize(votes)}];
          } else if (body.action === 'next' && room.status === 'frozen' && round < room.questions.length - 1) { status = 'waiting'; round++; }
          else if (body.action === 'finish' && room.status === 'frozen') status = 'finished';
          else throw new AppError('That action is not available for this question.',409);
          await client.query('UPDATE council_rooms SET status=$2,round=$3,history=$4::jsonb,version=version+1 WHERE code=$1',[code,status,round,JSON.stringify(history)]);
        });
        return respond(await state(db,code));
      }
      throw new AppError('Page not found.',404);
    } catch (error) {
      if (!(error instanceof AppError)) console.error('Council API failed:',error.code || error.name);
      return respond({error: error instanceof AppError ? error.message : 'The room could not connect. Please try again in a moment.'},error instanceof AppError ? error.status : 503);
    }
  };
}
