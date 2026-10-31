require('./helpers/testEnv.js');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { applyMatchMove, createCot615Match, getPublicMatchState } = require('../src/domain/entities/cot615Match');
const { getLegalMoveDestinations } = require('../src/domain/entities/xiangqiRules');
const { createServer } = require('../src/server');

function waitForMessage(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (predicate(message)) {
        socket.off('message', onMessage);
        resolve(message);
      }
    };
    socket.on('message', onMessage);
    socket.once('error', reject);
  });
}

test('invalid moves preserve the board, turn, and clock checkpoint', () => {
  const startedAt = 1000;
  const match = createCot615Match(startedAt);
  const now = startedAt + 13000;
  const boardBefore = structuredClone(match.board);
  const clocksBefore = { ...match.remainingClocks };
  const turnStartedBefore = match.turnStartedAt;

  const result = applyMatchMove(match, 'red', 'e3', 'e2', now);

  assert.equal(result.accepted, false);
  assert.match(result.error, /không đúng luật/i);
  assert.deepEqual(match.board, boardBefore);
  assert.deepEqual(match.remainingClocks, clocksBefore);
  assert.equal(match.turnStartedAt, turnStartedBefore);
  assert.equal(match.currentTurn, 'red');
});

test('accepted moves update the board, capture state, turn, and only the mover clock', () => {
  const startedAt = 1000;
  const match = createCot615Match(startedAt);
  const now = startedAt + 13000;

  const result = applyMatchMove(match, 'red', 'e3', 'e4', now);

  assert.deepEqual(result, { accepted: true, captured: false, check: false });
  assert.equal(match.board.find((piece) => piece.id === 'red-soldier-e3').position, 'e4');
  assert.equal(match.currentTurn, 'black');
  assert.equal(match.moveNumber, 1);
  assert.equal(match.remainingClocks.red, 110);
  assert.equal(match.remainingClocks.black, 120);
  assert.equal(getPublicMatchState(match, now + 3000).clocks.black, 117);
});

test('legal move destinations use server rules and reject other-side pieces', () => {
  const match = createCot615Match(1000);
  assert.deepEqual(getLegalMoveDestinations(match.board, 'red', 'a3'), ['a4']);
  assert.deepEqual(getLegalMoveDestinations(match.board, 'red', 'b0').sort(), ['a2', 'c2']);
  assert.deepEqual(getLegalMoveDestinations(match.board, 'red', 'a6'), []);
  assert.deepEqual(getLegalMoveDestinations(match.board, 'red', 'invalid'), []);
});

test('WebSocket assigns player sides, accepts the active side move, and rejects spectators', async (t) => {
  const now = 1700000000000;
  const server = createServer({ match: createCot615Match(now - 5000), now: () => now });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `ws://127.0.0.1:${address.port}/api/matches/COT-615/ws`;
  const sockets = [];

  async function connect() {
    const socket = new WebSocket(url);
    sockets.push(socket);
    const welcomePromise = waitForMessage(socket, (message) => message.type === 'welcome');
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return { socket, welcome: await welcomePromise };
  }

  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  const red = await connect();
  const black = await connect();
  const spectator = await connect();
  assert.equal(red.welcome.color, 'red');
  assert.equal(black.welcome.color, 'black');
  assert.equal(spectator.welcome.readOnly, true);

  const redDestinations = waitForMessage(red.socket, (message) => message.type === 'legalMovesResult');
  red.socket.send(JSON.stringify({ type: 'legalMoves', from: 'a3' }));
  assert.deepEqual((await redDestinations).destinations, ['a4']);

  const statePromise = waitForMessage(black.socket, (message) =>
    message.type === 'state' && message.state.currentTurn === 'black');
  const resultPromise = waitForMessage(red.socket, (message) => message.type === 'moveResult');
  red.socket.send(JSON.stringify({ type: 'move', from: 'e3', to: 'e4' }));
  assert.equal((await resultPromise).accepted, true);
  assert.equal((await statePromise).state.board.find((piece) => piece.id === 'red-soldier-e3').position, 'e4');

  const outOfTurn = waitForMessage(red.socket, (message) => message.type === 'moveResult');
  red.socket.send(JSON.stringify({ type: 'move', from: 'a3', to: 'a4' }));
  assert.equal((await outOfTurn).accepted, false);

  const blackState = waitForMessage(red.socket, (message) =>
    message.type === 'state' && message.state.currentTurn === 'red');
  const blackResult = waitForMessage(black.socket, (message) => message.type === 'moveResult');
  black.socket.send(JSON.stringify({ type: 'move', from: 'a6', to: 'a5' }));
  assert.equal((await blackResult).accepted, true);
  assert.equal((await blackState).state.board.find((piece) => piece.id === 'black-soldier-a6').position, 'a5');

  const outOfTurnDestinations = waitForMessage(black.socket, (message) => message.type === 'legalMovesResult');
  black.socket.send(JSON.stringify({ type: 'legalMoves', from: 'a5' }));
  assert.deepEqual((await outOfTurnDestinations).destinations, []);

  const spectatorDestinations = waitForMessage(spectator.socket, (message) => message.type === 'legalMovesResult');
  spectator.socket.send(JSON.stringify({ type: 'legalMoves', from: 'e6' }));
  assert.deepEqual((await spectatorDestinations).destinations, []);

  const spectatorResult = waitForMessage(spectator.socket, (message) => message.type === 'moveResult');
  spectator.socket.send(JSON.stringify({ type: 'move', from: 'e6', to: 'e5' }));
  assert.equal((await spectatorResult).accepted, false);
});
