const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCot615Match, getPublicMatchState } = require('../src/domain/entities/cot615Match');
const { createServer } = require('../src/server');

test('COT-615 match starts with the standard 32 pieces and a server countdown', () => {
  const assignedAt = Date.parse('2026-10-15T00:00:00.000Z');
  const match = createCot615Match(assignedAt);
  const state = getPublicMatchState(match, assignedAt);

  assert.equal(state.board.length, 32);
  assert.equal(state.board.filter((piece) => piece.color === 'red').length, 16);
  assert.equal(state.board.filter((piece) => piece.color === 'black').length, 16);
  assert.deepEqual(
    state.board.map((piece) => `${piece.color}:${piece.position}`).sort(),
    [
      'red:a0', 'red:b0', 'red:b2', 'red:c0', 'red:c3', 'red:d0', 'red:e0', 'red:e3',
      'red:f0', 'red:g0', 'red:g3', 'red:h0', 'red:h2', 'red:i0', 'red:a3', 'red:i3',
      'black:a9', 'black:b7', 'black:b9', 'black:c6', 'black:c9', 'black:d9', 'black:e6',
      'black:e9', 'black:f9', 'black:g6', 'black:g9', 'black:h7', 'black:h9', 'black:i6',
      'black:i9', 'black:a6',
    ].sort(),
  );
  assert.equal(state.board.find((piece) => piece.type === 'general' && piece.color === 'red').position, 'e0');
  assert.equal(state.board.find((piece) => piece.type === 'general' && piece.color === 'black').position, 'e9');
  assert.equal(state.currentTurn, 'red');
  assert.equal(state.status, 'starting');
  assert.equal(state.countdownSeconds, 3);
  assert.equal(state.timeControlSeconds, 120);
  assert.equal(state.clocks.red, 120);
  assert.equal(state.clocks.black, 120);
});

test('server activates the match after countdown and decrements the active side clock', () => {
  const assignedAt = Date.parse('2026-10-15T00:00:00.000Z');
  const state = getPublicMatchState(createCot615Match(assignedAt), assignedAt + 6500);

  assert.equal(state.status, 'active');
  assert.equal(state.countdownSeconds, null);
  assert.equal(state.currentTurn, 'red');
  assert.equal(state.clocks.red, 117);
  assert.equal(state.clocks.black, 120);
});

test('read-only match endpoint returns the assigned match state', async (t) => {
  let now = Date.parse('2026-10-15T00:00:00.000Z');
  const server = createServer({ now: () => now });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/matches/COT-615`);
  const match = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(match.board.length, 32);
  assert.equal(match.countdownSeconds, 3);

  now += 4000;
  const activeResponse = await fetch(`http://127.0.0.1:${address.port}/api/matches/COT-615`);
  const activeMatch = await activeResponse.json();
  assert.equal(activeMatch.status, 'active');
  assert.equal(activeMatch.countdownSeconds, null);
});

test('read-only match endpoint rejects unknown matches and mutations', async (t) => {
  const server = createServer({ now: () => Date.parse('2026-10-15T00:00:00.000Z') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));

  const address = server.address();
  const missingResponse = await fetch(`http://127.0.0.1:${address.port}/api/matches/unknown`);
  assert.equal(missingResponse.status, 404);

  const mutationResponse = await fetch(`http://127.0.0.1:${address.port}/api/matches/COT-615`, {
    method: 'POST',
  });
  assert.equal(mutationResponse.status, 404);
});
