require('./helpers/testEnv.js');
/**
 * FE-10: API PvE (route + service + sweeper) và lưu nước đi cùng kết thúc trận trong 1 transaction.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

process.env.DB_CLIENT = 'sqlite';

const db = require('../src/config/db');
const { runMigrations } = require('../src/migrations/migrate');
const PgUserRepository = require('../src/infrastructure/database/repositories/PgUserRepository');
const RegisterUserUseCase = require('../src/application/use-cases/auth/registerUser');
const LoginUserUseCase = require('../src/application/use-cases/auth/loginUser');
const { PgPveMatchRepository } = require('../src/infrastructure/database/repositories/PgPveMatchRepository');
const { createServer } = require('../src/server');
const { createPveService } = require('../src/application/use-cases/game/pve/pveService');
const { createPveSweeper } = require('../src/application/use-cases/game/pve/pveSweeper');
const { createInitialBoard, createEmptyBoard } = require('../src/domain/rules/board');
const { PLAYER_TURN_LIMIT_MS } = require('../src/domain/entities/PveMatch');
const { mv, createFakeClock, seededRandom, put } = require('./helpers/pveFixtures');

const MAX_ACTIVE = 2;

/** Chạy migration mà không in log (giảm nhiễu stdout của test runner). */
async function migrateQuietly() {
  const originalLog = console.log;
  console.log = () => {};
  try {
    await runMigrations();
  } finally {
    console.log = originalLog;
  }
}

describe('FE-10: API chơi với máy', () => {
  let server;
  let baseUrl;
  let repo;
  let clock;
  let service;
  let tokens;
  let userIds;

  async function api(method, path, { token, body } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try {
      json = await response.json();
    } catch {
      /* không có body */
    }
    return { status: response.status, json };
  }

  before(async () => {
    db.initSqlite(new DatabaseSync(':memory:'));
    await migrateQuietly();
    const userRepo = new PgUserRepository({ db });
    const register = new RegisterUserUseCase({ userRepository: userRepo });
    const login = new LoginUserUseCase({ userRepository: userRepo });
    tokens = {};
    userIds = {};
    for (const name of ['alice', 'bob', 'carol', 'dave']) {
      const user = await register.execute({
        username: `fe10_${name}`, displayName: name, email: `fe10_${name}@cotuong.vn`, password: 'StrongPassword123',
      });
      userIds[name] = user.id;
      tokens[name] = (await login.execute({ username: `fe10_${name}`, password: 'StrongPassword123' })).token;
    }

    repo = new PgPveMatchRepository({ db });
    clock = createFakeClock(new Date().toISOString());
    service = createPveService({
      pveMatchRepository: repo, clock, random: seededRandom(11), maxActiveMatches: MAX_ACTIVE,
    });
    server = createServer({ pveService: service, pveHandlerOptions: { userRepository: userRepo } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    }));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.closePool();
  });

  it('mọi endpoint yêu cầu đăng nhập', async () => {
    assert.equal((await api('POST', '/api/pve/matches', { body: { playerColor: 'red' } })).status, 401);
    assert.equal((await api('GET', '/api/pve/matches/1')).status, 401);
    assert.equal((await api('POST', '/api/pve/matches/1/moves', { body: {} })).status, 401);
    assert.equal((await api('POST', '/api/pve/matches/1/legal-moves', { body: {} })).status, 401);
    assert.equal((await api('POST', '/api/pve/matches/1/resign')).status, 401);
  });

  it('tạo trận cầm Đỏ: người đi trước, chưa có nước của máy, không tính Elo', async () => {
    const { status, json } = await api('POST', '/api/pve/matches', { token: tokens.alice, body: { playerColor: 'red' } });
    assert.equal(status, 201);
    assert.equal(json.success, true);
    assert.equal(json.match.playerColor, 'red');
    assert.equal(json.match.status, 'PLAYING');
    assert.equal(json.match.sideToMove, 'red');
    assert.equal(json.match.ply, 0);
    assert.equal(json.match.board.length, 10);
    assert.equal(json.match.hasEloRating, false);
    assert.equal(json.botMove, null);
    await api('POST', `/api/pve/matches/${json.match.id}/resign`, { token: tokens.alice });
  });

  it('trả điểm đến hợp lệ cho quân người chơi và không rò rỉ danh sách của phe đối thủ', async () => {
    const created = (await api('POST', '/api/pve/matches', {
      token: tokens.alice,
      body: { playerColor: 'red' },
    })).json.match;

    const legal = await api('POST', `/api/pve/matches/${created.id}/legal-moves`, {
      token: tokens.alice,
      body: { from: 'a3' },
    });
    assert.equal(legal.status, 200);
    assert.deepEqual(legal.json.destinations, ['a4']);

    const opponentPiece = await api('POST', `/api/pve/matches/${created.id}/legal-moves`, {
      token: tokens.alice,
      body: { from: 'a6' },
    });
    assert.deepEqual(opponentPiece.json.destinations, []);

    const denied = await api('POST', `/api/pve/matches/${created.id}/legal-moves`, {
      token: tokens.bob,
      body: { from: 'a3' },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.code, 'NOT_MATCH_OWNER');
    await api('POST', `/api/pve/matches/${created.id}/resign`, { token: tokens.alice });
  });

  it('tạo trận cầm Đen: máy đi trước ngay trong lúc tạo', async () => {
    const { status, json } = await api('POST', '/api/pve/matches', { token: tokens.alice, body: { playerColor: 'black' } });
    assert.equal(status, 201);
    assert.equal(json.match.ply, 1);
    assert.equal(json.match.sideToMove, 'black');
    assert.ok(json.botMove && json.botMove.actor === 'BOT' && json.botMove.side === 'red');
    await api('POST', `/api/pve/matches/${json.match.id}/resign`, { token: tokens.alice });
  });

  it('màu quân không hợp lệ -> 400, JSON hỏng -> 400', async () => {
    const bad = await api('POST', '/api/pve/matches', { token: tokens.alice, body: { playerColor: 'blue' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'INVALID_INPUT');
    const response = await fetch(`${baseUrl}/api/pve/matches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.alice}`, 'Content-Type': 'application/json' },
      body: '{khong phai json',
    });
    assert.equal(response.status, 400);
  });

  it('đi quân: lưu nước người chơi và máy đi lại NGAY trong cùng response', async () => {
    const created = (await api('POST', '/api/pve/matches', { token: tokens.bob, body: { playerColor: 'red' } })).json.match;
    const { status, json } = await api('POST', `/api/pve/matches/${created.id}/moves`, {
      token: tokens.bob, body: mv(2, 1, 2, 4),
    });
    assert.equal(status, 200);
    assert.equal(json.playerMove.actor, 'PLAYER');
    assert.equal(json.playerMove.ply, 1);
    assert.equal(json.botMove.actor, 'BOT');
    assert.equal(json.botMove.ply, 2);
    assert.equal(json.match.ply, 2);
    assert.equal(json.match.sideToMove, 'red');
    assert.equal(json.match.status, 'PLAYING');

    const reread = await api('GET', `/api/pve/matches/${created.id}`, { token: tokens.bob });
    assert.equal(reread.status, 200);
    assert.equal(reread.json.match.ply, 2);
    assert.equal(typeof reread.json.match.remainingMs, 'number');
    await api('POST', `/api/pve/matches/${created.id}/resign`, { token: tokens.bob });
  });

  it('nước sai luật / sai định dạng bị từ chối và không đổi gì', async () => {
    const created = (await api('POST', '/api/pve/matches', { token: tokens.bob, body: { playerColor: 'red' } })).json.match;
    const illegal = await api('POST', `/api/pve/matches/${created.id}/moves`, { token: tokens.bob, body: mv(0, 0, 5, 5) });
    assert.equal(illegal.status, 400);
    assert.equal(illegal.json.code, 'ILLEGAL_MOVE');
    const malformed = await api('POST', `/api/pve/matches/${created.id}/moves`, { token: tokens.bob, body: { from: 'a1', to: 'a2' } });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json.code, 'INVALID_MOVE');
    const state = await api('GET', `/api/pve/matches/${created.id}`, { token: tokens.bob });
    assert.equal(state.json.match.ply, 0);
    await api('POST', `/api/pve/matches/${created.id}/resign`, { token: tokens.bob });
  });

  it('người khác không xem / đi / xin thua được trận không phải của mình', async () => {
    const created = (await api('POST', '/api/pve/matches', { token: tokens.carol, body: { playerColor: 'red' } })).json.match;
    for (const [method, suffix, body] of [['GET', '', undefined], ['POST', '/moves', mv(2, 1, 2, 4)], ['POST', '/resign', undefined]]) {
      const denied = await api(method, `/api/pve/matches/${created.id}${suffix}`, { token: tokens.dave, body });
      assert.equal(denied.status, 403, `${method}${suffix}`);
      assert.equal(denied.json.code, 'NOT_MATCH_OWNER');
    }
    assert.equal((await api('GET', '/api/pve/matches/999999', { token: tokens.dave })).status, 404);
    assert.equal((await api('GET', '/api/pve/matches/abc', { token: tokens.dave })).status, 400);
    const stillThere = await api('GET', `/api/pve/matches/${created.id}`, { token: tokens.carol });
    assert.equal(stillThere.json.match.status, 'PLAYING');
    await api('POST', `/api/pve/matches/${created.id}/resign`, { token: tokens.carol });
  });

  it('xin thua: LOSS/RESIGN, sau đó đi quân hoặc xin thua lại -> 409 MATCH_FINISHED', async () => {
    const created = (await api('POST', '/api/pve/matches', { token: tokens.dave, body: { playerColor: 'red' } })).json.match;
    const resign = await api('POST', `/api/pve/matches/${created.id}/resign`, { token: tokens.dave });
    assert.equal(resign.status, 200);
    assert.equal(resign.json.match.status, 'FINISHED');
    assert.equal(resign.json.match.result, 'LOSS');
    assert.equal(resign.json.match.endReason, 'RESIGN');
    const move = await api('POST', `/api/pve/matches/${created.id}/moves`, { token: tokens.dave, body: mv(2, 1, 2, 4) });
    assert.equal(move.status, 409);
    assert.equal(move.json.code, 'MATCH_FINISHED');
    assert.equal((await api('POST', `/api/pve/matches/${created.id}/resign`, { token: tokens.dave })).status, 409);
  });

  it('KHÔNG có endpoint để client ra lệnh cho máy đi hay xử hết giờ', async () => {
    const created = (await api('POST', '/api/pve/matches', { token: tokens.dave, body: { playerColor: 'red' } })).json.match;
    for (const suffix of ['/bot', '/bot-move', '/timeout', '/check-timeout', '/play-bot-turn']) {
      const response = await api('POST', `/api/pve/matches/${created.id}${suffix}`, { token: tokens.dave });
      assert.equal(response.status, 404, suffix);
    }
    assert.equal((await api('POST', '/api/pve/matches/' + created.id, { token: tokens.dave })).status, 405);
    await api('POST', `/api/pve/matches/${created.id}/resign`, { token: tokens.dave });
  });

  it(`giới hạn ${MAX_ACTIVE} trận PLAYING / người: trận thứ ${MAX_ACTIVE + 1} -> 429 TOO_MANY_PVE_MATCHES, xin thua xong tạo lại được`, async () => {
    const ids = [];
    for (let i = 0; i < MAX_ACTIVE; i += 1) {
      const ok = await api('POST', '/api/pve/matches', { token: tokens.carol, body: { playerColor: 'red' } });
      assert.equal(ok.status, 201);
      ids.push(ok.json.match.id);
    }
    const over = await api('POST', '/api/pve/matches', { token: tokens.carol, body: { playerColor: 'red' } });
    assert.equal(over.status, 429);
    assert.equal(over.json.code, 'TOO_MANY_PVE_MATCHES');

    // người khác không bị ảnh hưởng
    const other = await api('POST', '/api/pve/matches', { token: tokens.alice, body: { playerColor: 'red' } });
    assert.equal(other.status, 201);
    await api('POST', `/api/pve/matches/${other.json.match.id}/resign`, { token: tokens.alice });

    await api('POST', `/api/pve/matches/${ids[0]}/resign`, { token: tokens.carol });
    const again = await api('POST', '/api/pve/matches', { token: tokens.carol, body: { playerColor: 'red' } });
    assert.equal(again.status, 201);
    for (const id of [ids[1], again.json.match.id]) {
      await api('POST', `/api/pve/matches/${id}/resign`, { token: tokens.carol });
    }
  });

  it('tạo trận đồng thời không vượt giới hạn', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => api('POST', '/api/pve/matches', { token: tokens.bob, body: { playerColor: 'red' } }))
    );
    const created = results.filter((r) => r.status === 201);
    assert.equal(created.length, MAX_ACTIVE);
    assert.equal(results.filter((r) => r.status === 429).length, 6 - MAX_ACTIVE);
    for (const r of created) {
      await api('POST', `/api/pve/matches/${r.json.match.id}/resign`, { token: tokens.bob });
    }
  });

  it('GET sau khi quá 60 giây không đi -> trận tự kết thúc TIMEOUT (không cần endpoint riêng)', async () => {
    const created = (await api('POST', '/api/pve/matches', { token: tokens.alice, body: { playerColor: 'red' } })).json.match;
    clock.advance(PLAYER_TURN_LIMIT_MS + 1000);
    const { status, json } = await api('GET', `/api/pve/matches/${created.id}`, { token: tokens.alice });
    assert.equal(status, 200);
    assert.equal(json.match.status, 'FINISHED');
    assert.equal(json.match.result, 'LOSS');
    assert.equal(json.match.endReason, 'TIMEOUT');
  });
});

describe('FE-10: sweeper PvE', () => {
  let repo;
  let clock;
  let service;
  let userId;

  before(async () => {
    db.initSqlite(new DatabaseSync(':memory:'));
    await migrateQuietly();
    await db.query('INSERT INTO users (username, display_name, email) VALUES ($1, $2, $3)', ['fe10_sweep', 'Sweep', 'fe10_sweep@cotuong.vn']);
    userId = (await db.query('SELECT id FROM users WHERE username = $1', ['fe10_sweep'])).rows[0].id;
    repo = new PgPveMatchRepository({ db });
    clock = createFakeClock(new Date().toISOString());
    service = createPveService({ pveMatchRepository: repo, clock, random: seededRandom(3), maxActiveMatches: 50 });
  });

  after(async () => {
    await db.closePool();
  });

  it('trận kẹt ở lượt máy (người đã đi, máy chưa đáp) -> sweeper cho máy đi', async () => {
    const { match } = await service.startMatch({ userId, playerColor: 'red' });
    // đi nước của người chơi bằng use-case thẳng, KHÔNG qua service nên máy chưa đáp (giả lập sập giữa chừng)
    await service.useCases.submitPlayerMove(match.id, userId, mv(2, 1, 2, 4));
    assert.equal((await repo.findById(match.id)).sideToMove, 'black');

    const sweeper = createPveSweeper({ service, logger: { error() {} } });
    const outcome = await sweeper.sweepOnce();
    assert.ok(outcome.scanned >= 1);
    const after = await repo.findById(match.id);
    assert.equal(after.ply, 2);
    assert.equal(after.sideToMove, 'red');
    await service.useCases.resignPveMatch(match.id, userId);
  });

  it('trận bỏ dở quá 60 giây ở lượt người chơi -> sweeper xử thua TIMEOUT', async () => {
    const { match } = await service.startMatch({ userId, playerColor: 'red' });
    clock.advance(PLAYER_TURN_LIMIT_MS + 5000);
    await createPveSweeper({ service, logger: { error() {} } }).sweepOnce();
    const after = await repo.findById(match.id);
    assert.equal(after.status, 'FINISHED');
    assert.equal(after.endReason, 'TIMEOUT');
  });

  it('một trận lỗi không làm dừng cả lượt quét; timer dùng unref(); stop() dừng hẳn', async () => {
    const calls = [];
    const errors = [];
    const fake = {
      listPlaying: async () => [{ id: 1 }, { id: 2 }, { id: 3 }],
      advanceMatch: async (id) => {
        calls.push(id);
        if (id === 2) throw new Error('hỏng');
      },
    };
    const sweeper = createPveSweeper({ service: fake, intervalMs: 20, logger: { error: (...a) => errors.push(a) } });
    const outcome = await sweeper.sweepOnce();
    assert.deepEqual(calls, [1, 2, 3]);
    assert.deepEqual(outcome, { scanned: 3, failed: 1 });
    assert.equal(errors.length, 1);

    sweeper.start();
    assert.equal(sweeper.isRunning(), true);
    sweeper.start(); // gọi lại không tạo thêm timer
    sweeper.stop();
    assert.equal(sweeper.isRunning(), false);
  });

  it('timer của sweeper không giữ process sống (unref)', () => {
    const sweeper = createPveSweeper({ service: { listPlaying: async () => [], advanceMatch: async () => {} }, intervalMs: 60000 });
    const originalSetInterval = global.setInterval;
    let created;
    global.setInterval = (...args) => {
      created = originalSetInterval(...args);
      return created;
    };
    try {
      sweeper.start();
    } finally {
      global.setInterval = originalSetInterval;
      sweeper.stop();
    }
    assert.equal(created.hasRef(), false);
  });
});

describe('FE-10: nước đi và kết thúc trận cùng một transaction', () => {
  let repo;
  let userId;

  before(async () => {
    db.initSqlite(new DatabaseSync(':memory:'));
    await migrateQuietly();
    await db.query('INSERT INTO users (username, display_name, email) VALUES ($1, $2, $3)', ['fe10_atomic', 'Atomic', 'fe10_atomic@cotuong.vn']);
    userId = (await db.query('SELECT id FROM users WHERE username = $1', ['fe10_atomic'])).rows[0].id;
    repo = new PgPveMatchRepository({ db });
  });

  after(async () => {
    await db.closePool();
  });

  const NOW = '2026-01-01T00:00:00.000Z';
  const record = { side: 'red', actor: 'PLAYER', pieceType: 'R', from: { row: 7, col: 0 }, to: { row: 7, col: 3 }, capturedType: null };

  it('saveMove kèm outcome ghi bàn cờ + nước đi + FINISHED/result/end_reason/finished_at trong 1 lần', async () => {
    const match = await repo.create({
      userId, playerColor: 'red', botColor: 'black', board: createInitialBoard(), sideToMove: 'red', now: NOW,
    });
    const saved = await repo.saveMove({
      matchId: match.id,
      expectedPly: 0,
      board: createInitialBoard(),
      sideToMove: 'black',
      move: record,
      now: '2026-01-01T00:00:09.000Z',
      outcome: { status: 'FINISHED', result: 'WIN', endReason: 'CHECKMATE', finishedAt: '2026-01-01T00:00:09.000Z' },
    });
    assert.equal(saved, true);
    const after = await repo.findById(match.id);
    assert.equal(after.status, 'FINISHED');
    assert.equal(after.result, 'WIN');
    assert.equal(after.endReason, 'CHECKMATE');
    assert.equal(after.ply, 1);
    assert.equal(after.finishedAt.toISOString(), '2026-01-01T00:00:09.000Z');
    assert.equal((await repo.listMoves(match.id)).length, 1);
  });

  it('ghi nước đi lỗi giữa chừng thì KHÔNG để lại trận đã FINISHED hay bàn cờ đổi (rollback)', async () => {
    const match = await repo.create({
      userId, playerColor: 'red', botColor: 'black', board: createInitialBoard(), sideToMove: 'red', now: NOW,
    });
    // cài sẵn dòng pve_moves ply 1 để INSERT trong saveMove vi phạm UNIQUE -> lỗi sau khi UPDATE đã chạy
    await db.query(
      `INSERT INTO pve_moves (match_id, ply, side, actor, piece_type, from_row, from_col, to_row, to_col, created_at)
       VALUES ($1, 1, 'red', 'PLAYER', 'R', 7, 0, 7, 3, $2)`,
      [match.id, NOW]
    );
    await assert.rejects(
      repo.saveMove({
        matchId: match.id,
        expectedPly: 0,
        board: createEmptyBoard(),
        sideToMove: 'black',
        move: record,
        now: NOW,
        outcome: { status: 'FINISHED', result: 'WIN', endReason: 'CHECKMATE', finishedAt: NOW },
      })
    );
    const after = await repo.findById(match.id);
    assert.equal(after.status, 'PLAYING');
    assert.equal(after.result, null);
    assert.equal(after.ply, 0);
    assert.deepEqual(after.board, createInitialBoard());
  });

  it('applyAndPersistMove chiếu bí: kết thúc qua saveMove, KHÔNG còn bước finish riêng', async () => {
    const { createPveUseCases } = require('../src/application/use-cases/game/pve');
    const board = createEmptyBoard();
    put(board, 0, 4, 'K', 'red');
    put(board, 7, 0, 'R', 'red');
    put(board, 9, 3, 'K', 'black');
    const clock = createFakeClock(NOW);
    const match = await repo.create({
      userId, playerColor: 'red', botColor: 'black', board, sideToMove: 'red', now: clock().toISOString(),
    });
    let finishCalls = 0;
    const spyRepo = new Proxy(repo, {
      get(target, prop) {
        if (prop === 'finish') {
          return async (...args) => {
            finishCalls += 1;
            return target.finish(...args);
          };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const useCases = createPveUseCases({ pveMatchRepository: spyRepo, clock });
    clock.advance(3000);
    const { match: finished } = await useCases.submitPlayerMove(match.id, userId, mv(7, 0, 7, 3));
    assert.equal(finished.status, 'FINISHED');
    assert.equal(finished.result, 'WIN');
    assert.equal(finished.endReason, 'CHECKMATE');
    assert.equal(finishCalls, 0, 'kết thúc phải đi cùng saveMove, không gọi finish riêng');
    assert.equal((await repo.listMoves(match.id)).length, 1);
  });
});
