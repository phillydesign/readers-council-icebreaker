import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { localDB } from '../scripts/local-db.mjs';
import { createAPI } from '../server/core.mjs';

test('a real database supports the anonymous council voting workflow', async t => {
  const db = await localDB();
  t.after(() => db.close());
  const password = 'council-integration-password-2026';
  const api = createAPI({ db, hostPassword: password, local: true });
  const participants = [];
  const rooms = [];
  let hostToken;
  let current;

  async function request(path, { body, token, method = body === undefined ? 'GET' : 'POST' } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await api(new Request(`http://localhost/api${path}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { ip: 'integration-test' });
    return { response, status: response.status, data: await response.json() };
  }

  function expectStatus(result, status) {
    assert.equal(result.status, status, JSON.stringify(result.data));
    return result.data;
  }

  async function readRoom(code = current.code) {
    return expectStatus(await request(`/rooms/${code}`), 200);
  }

  async function control(action) {
    current = expectStatus(await request(`/rooms/${current.code}/control`, {
      token: hostToken, body: { action, expectedVersion: current.version },
    }), 200);
    return current;
  }

  async function vote(participant, position, sequence, round = current.round) {
    return request(`/rooms/${current.code}/vote`, {
      token: participant.participantToken, body: { round, position, sequence },
    });
  }

  const questions = [
    { prompt: 'Where do you find your best ideas?', left: 'On my own', right: 'With other people' },
    { prompt: 'How do you like to get started?', left: 'Make a plan', right: 'Try something' },
    {
      prompt: "What about <script>alert('hello')</script> and '); DROP TABLE council_rooms; --?",
      left: '<b>Listen & learn</b>',
      right: '"Build" <img src=x onerror=alert(1)>',
    },
    { prompt: 'Which innovation would improve every meeting?', left: 'A snack robot', right: 'A mute button for my dog' },
  ];

  await t.test('host access is required and custom sessions accept one to four questions but reject five', async () => {
    expectStatus(await request('/rooms', { body: { title: 'Unauthorized', questions } }), 401);
    expectStatus(await request('/host/login', { body: { password: 'incorrect-password' } }), 401);
    const login = expectStatus(await request('/host/login', { body: { password } }), 200);
    hostToken = login.token;
    assert.ok(hostToken);

    for (const count of [0, 5]) {
      expectStatus(await request('/rooms', {
        token: hostToken,
        body: { title: 'Invalid question count', questions: Array.from({ length: count }, () => questions[0]) },
      }), 400);
    }
    for (const count of [1, 2, 3, 4]) {
      const customQuestions = questions.slice(0, count);
      const room = expectStatus(await request('/rooms', {
        token: hostToken, body: { title: `Council: ${count} questions`, questions: customQuestions },
      }), 201);
      assert.equal(room.totalQuestions, count);
      assert.deepEqual(room.questions, customQuestions);
      assert.equal(room.status, 'waiting');
      assert.equal(room.responded, 0);
      rooms.push(room);
    }
    current = rooms[3];
    for (const token of [undefined, 'forged-host-session']) {
      expectStatus(await request(`/rooms/${current.code}/control`, {
        token, body: { action: 'open', expectedVersion: current.version },
      }), 401);
    }
    assert.equal((await readRoom()).status, 'waiting');
  });

  await t.test('30 anonymous participants can join without casting votes, and reconnect without duplication', async () => {
    const joined = await Promise.all(Array.from({ length: 30 }, () =>
      request(`/rooms/${current.code}/join`, { body: {} })));
    participants.push(...joined.map(result => expectStatus(result, 200)));
    assert.equal(new Set(participants.map(p => p.participantId)).size, 30);
    assert.equal(new Set(participants.map(p => p.participantToken)).size, 30);
    const state = await readRoom();
    assert.equal(state.joined, 30);
    assert.equal(state.responded, 0);
    assert.deepEqual(state.votes, []);
    assert.deepEqual(state.results, { left: 0, right: 0, total: 0 });

    const rejoined = expectStatus(await request(`/rooms/${current.code}/join`, {
      body: { participantToken: participants[0].participantToken },
    }), 200);
    assert.equal(rejoined.participantId, participants[0].participantId);
    assert.equal(rejoined.participantToken, participants[0].participantToken);
    assert.equal(rejoined.state.joined, 30);
    assert.equal(rejoined.state.responded, 0);
    expectStatus(await vote(participants[0], 25, 0), 409);
  });

  await t.test('live votes tally two sides and normalize midpoint requests without stale overwrite or cross-room token access', async () => {
    await control('open');
    const otherRoomParticipant = expectStatus(await request(`/rooms/${rooms[0].code}/join`, { body: {} }), 200);
    expectStatus(await vote(otherRoomParticipant, 100, 0), 401);
    expectStatus(await request(`/rooms/${current.code}/vote`, {
      body: { round: current.round, position: 100, sequence: 0 },
    }), 401);
    assert.equal((await readRoom()).responded, 0);

    const positions = Array.from({ length: 30 }, (_, index) => index < 12 ? 20 : index < 15 ? 50 : 80);
    const responses = await Promise.all(participants.map((participant, index) => vote(participant, positions[index], 1)));
    responses.forEach(result => expectStatus(result, 200));
    responses.slice(12, 15).forEach(result => assert.equal(result.data.position, 51));
    let state = await readRoom();
    assert.equal(state.responded, 30);
    assert.deepEqual(state.results, { left: 12, right: 18, total: 30 });
    assert.equal(state.results.left + state.results.right, state.results.total);
    assert.equal(state.votes.filter(v => v.position === 51).length, 3);
    assert.ok(state.votes.every(v => v.position !== 50));
    assert.ok(state.votes.every(v => !('participantToken' in v) && !('token_hash' in v)));

    assert.equal(expectStatus(await vote(participants[0], 99, 3), 200).position, 99);
    // Delayed and repeated requests must return the accepted vote, never replace it.
    for (const sequence of [2, 3]) {
      const stale = expectStatus(await vote(participants[0], 1, sequence), 200);
      assert.equal(stale.position, 99);
      assert.equal(stale.sequence, 3);
    }
    state = await readRoom();
    assert.equal(state.votes.find(v => v.id === participants[0].participantId).position, 99);
    assert.deepEqual(state.results, { left: 11, right: 19, total: 30 });
  });

  await t.test('freezing preserves final results and blocks all subsequent voting', async () => {
    const frozen = await control('freeze');
    assert.equal(frozen.status, 'frozen');
    assert.equal(frozen.history.length, 1);
    assert.deepEqual(frozen.history[0].results, frozen.results);
    assert.equal(frozen.results.left + frozen.results.right, frozen.results.total);
    const expectedVotes = structuredClone(frozen.votes);
    const lateVotes = await Promise.all(participants.map(p => vote(p, 50, 100)));
    lateVotes.forEach(result => expectStatus(result, 409));
    const unchanged = await readRoom();
    assert.deepEqual(unchanged.votes, expectedVotes);
    assert.deepEqual(unchanged.history, frozen.history);
    expectStatus(await request(`/rooms/${current.code}/control`, {
      token: hostToken, body: { action: 'next', expectedVersion: current.version - 1 },
    }), 409);
    assert.equal((await readRoom()).round, 0);
  });

  await t.test('each new round starts without votes and rejects requests from a previous round', async () => {
    await control('next');
    assert.equal(current.round, 1);
    assert.equal(current.status, 'waiting');
    assert.equal(current.joined, 30);
    assert.equal(current.responded, 0);
    assert.deepEqual(current.votes, []);
    assert.deepEqual(current.results, { left: 0, right: 0, total: 0 });
    expectStatus(await vote(participants[0], 25, 0), 409);
    await control('open');
    expectStatus(await vote(participants[0], 100, 101, 0), 409);
    assert.equal((await readRoom()).responded, 0);
    assert.equal(expectStatus(await vote(participants[0], 50, 0), 200).position, 51);
    await control('freeze');
    assert.deepEqual(current.results, { left: 0, right: 1, total: 1 });
    assert.equal(current.history.length, 2);
    await control('next');
    assert.equal(current.round, 2);
    assert.equal(current.responded, 0);
    assert.deepEqual(current.question, questions[2]);
  });

  await t.test('SQL and HTML-looking question text remains literal JSON data through the third round', async () => {
    const dangerousTitle = "<script>alert('council')</script>'; DROP TABLE council_rooms; --";
    const literalRoom = expectStatus(await request('/rooms', {
      token: hostToken, body: { title: dangerousTitle, questions: [questions[2]] },
    }), 201);
    const retrieved = await request(`/rooms/${literalRoom.code}`);
    expectStatus(retrieved, 200);
    assert.match(retrieved.response.headers.get('content-type'), /^application\/json/);
    assert.equal(retrieved.response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(retrieved.data.title, dangerousTitle);
    assert.deepEqual(retrieved.data.question, questions[2]);
    assert.equal((await readRoom()).joined, 30);

    await control('open');
    expectStatus(await vote(participants[1], 100, 0), 200);
    await control('freeze');
    assert.equal(current.history.length, 3);
    assert.deepEqual(current.history.map(item => item.results.total), [30, 1, 1]);
  });

  await t.test('the fourth joke question accepts votes, freezes results and finishes the session', async () => {
    await control('next');
    assert.equal(current.round, 3);
    assert.equal(current.totalQuestions, 4);
    assert.equal(current.status, 'waiting');
    assert.equal(current.responded, 0);
    assert.deepEqual(current.question, questions[3]);
    expectStatus(await vote(participants[0], 10, 0), 409);
    await control('open');
    expectStatus(await vote(participants[0], 10, 0), 200);
    expectStatus(await vote(participants[1], 90, 0), 200);
    expectStatus(await vote(participants[0], 90, 100, 2), 409);
    await control('freeze');
    assert.deepEqual(current.results, { left: 1, right: 1, total: 2 });
    assert.equal(current.history.length, 4);
    assert.deepEqual(current.history[3], { question: questions[3], results: current.results });
    expectStatus(await vote(participants[0], 90, 1), 409);
    expectStatus(await request(`/rooms/${current.code}/control`, {
      token: hostToken, body: { action: 'next', expectedVersion: current.version },
    }), 409);
    await control('finish');
    assert.equal(current.status, 'finished');
    assert.equal(current.history.length, 4);
    assert.deepEqual(current.history.map(item => item.results.total), [30, 1, 1, 2]);
    expectStatus(await vote(participants[1], 0, 1), 409);
    expectStatus(await request(`/rooms/${current.code}/join`, { body: {} }), 409);
    expectStatus(await request(`/rooms/${current.code}/control`, {
      token: hostToken, body: { action: 'open', expectedVersion: current.version },
    }), 409);
    assert.equal((await readRoom()).status, 'finished');
  });

  await t.test('existing midpoint votes and history display as right without rewriting stored responses', async () => {
    const legacyRoom = expectStatus(await request('/rooms', {
      token: hostToken, body: { title: 'Saved room from the earlier version', questions: [questions[0]] },
    }), 201);
    const participant = expectStatus(await request(`/rooms/${legacyRoom.code}/join`, { body: {} }), 200);
    const legacyHistory = [{ question: questions[0], results: { left: 0, center: 1, right: 0, total: 1 } }];
    await db.query('INSERT INTO council_votes (room,round,participant,position,sequence) VALUES ($1,0,$2,50,0)',
      [legacyRoom.code, participant.participantId]);
    await db.query("UPDATE council_rooms SET status='frozen',history=$2::jsonb WHERE code=$1",
      [legacyRoom.code, JSON.stringify(legacyHistory)]);

    const saved = await readRoom(legacyRoom.code);
    assert.deepEqual(saved.results, { left: 0, right: 1, total: 1 });
    assert.deepEqual(saved.history[0].results, saved.results);
    assert.equal(saved.votes[0].position, 50);
    assert.equal(saved.results.left + saved.results.right, saved.results.total);

    const finished = expectStatus(await request(`/rooms/${legacyRoom.code}/control`, {
      token: hostToken, body: { action: 'finish', expectedVersion: saved.version },
    }), 200);
    assert.deepEqual(finished.history, saved.history);
    const stored = (await db.query('SELECT history FROM council_rooms WHERE code=$1', [legacyRoom.code])).rows[0];
    assert.deepEqual(stored.history, legacyHistory);
    const storedVote = (await db.query('SELECT position FROM council_votes WHERE room=$1', [legacyRoom.code])).rows[0];
    assert.equal(storedVote.position, 50);
  });
});

test('an existing three-question local database upgrades once and preserves its rooms, participants and votes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'council-migration-'));
  const path = join(directory, 'database');
  let db = new PGlite(path);
  t.after(async () => { await db?.close(); await rm(directory, { recursive: true, force: true }); });
  await db.exec(await readFile(new URL('../netlify/database/migrations/0001_council.sql', import.meta.url), 'utf8'));
  const question = { prompt: 'An existing question', left: 'Left choice', right: 'Right choice' };
  const questions = Array.from({ length: 3 }, () => question);
  const history = questions.map(question => ({ question, results: { left: 1, right: 0, total: 1 } }));
  await db.query(`INSERT INTO council_rooms (code,title,questions,round,status,version,history)
    VALUES ($1,$2,$3::jsonb,2,'frozen',8,$4::jsonb)`,
    ['OLDROOM2', 'Existing council session', JSON.stringify(questions), JSON.stringify(history)]);
  await db.query('INSERT INTO council_participants (room,token_hash,public_id) VALUES ($1,$2,$3)',
    ['OLDROOM2', 'saved-anonymous-token-hash', '12345678-1234-1234-1234-123456789abc']);
  await db.query('INSERT INTO council_votes (room,round,participant,position,sequence) VALUES ($1,2,$2,25,7)',
    ['OLDROOM2', '12345678-1234-1234-1234-123456789abc']);
  const tables = ['council_rooms', 'council_participants', 'council_votes'];
  const before = await Promise.all(tables.map(table => db.query(`SELECT * FROM ${table}`)));
  await db.close();
  db = null;

  db = await localDB(path);
  for (let i = 0; i < tables.length; i++) {
    assert.deepEqual((await db.query(`SELECT * FROM ${tables[i]}`)).rows, before[i].rows);
  }
  const migrations = (await db.query('SELECT * FROM council_local_migrations ORDER BY name')).rows;
  assert.deepEqual(migrations.map(row => row.name), ['0001_council.sql', '0002_four_questions.sql']);

  const fourQuestions = [...questions, { prompt: 'Does your ecosystem need more snacks?', left: 'Always', right: 'Immediately' }];
  await db.query('INSERT INTO council_rooms (code,title,questions,round) VALUES ($1,$2,$3::jsonb,3)',
    ['NEWROOM4', 'Four-question council session', JSON.stringify(fourQuestions)]);
  await assert.rejects(db.query('UPDATE council_rooms SET questions=$2::jsonb WHERE code=$1',
    ['NEWROOM4', JSON.stringify([...fourQuestions, question])]), error => error.code === '23514');
  await assert.rejects(db.query('UPDATE council_rooms SET round=4 WHERE code=$1', ['NEWROOM4']),
    error => error.code === '23514');
  await db.close();
  db = null;

  db = await localDB(path);
  assert.deepEqual((await db.query('SELECT * FROM council_local_migrations ORDER BY name')).rows, migrations);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM council_rooms')).rows[0].count, 2);
  const savedRoom = (await db.query('SELECT * FROM council_rooms WHERE code=$1', ['OLDROOM2'])).rows[0];
  assert.deepEqual(savedRoom, before[0].rows[0]);
});
