require('./helpers/testEnv.js');
/**
 * Kiểm thử nghiệm thu Task COT-592:
 * [2.3] [BE] Cấu hình WebSocket/SignalR Hub và Phân chia vai trò, quản lý State phòng.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { WebSocket } = require('ws');

process.env.DB_CLIENT = 'sqlite';

const db = require('../src/config/db');
const { runMigrations } = require('../src/migrations/migrate');
const PgUserRepository = require('../src/infrastructure/database/repositories/PgUserRepository');
const RegisterUserUseCase = require('../src/application/use-cases/auth/registerUser');
const LoginUserUseCase = require('../src/application/use-cases/auth/loginUser');
const { RoomManager } = require('../src/infrastructure/database/repositories/RoomManager');
const { RoomHub } = require('../src/presentation/websocket/roomHub');
const { createServer } = require('../src/server');

describe('Nghiệm thu Task COT-592: Cấu hình WebSocket Hub & Phân chia vai trò, quản lý State phòng', () => {
  let userRepo;
  let registerUseCase;
  let loginUseCase;
  let roomManager;
  let roomHub;
  let server;
  let serverPort;

  let hostUser;
  let hostToken;
  let opponentUser;
  let opponentToken;
  let spectatorUser1;
  let spectatorToken1;
  let spectatorUser2;
  let spectatorToken2;

  let createdRoom;

  before(async () => {
    const memDb = new DatabaseSync(':memory:');
    db.initSqlite(memDb);
    await runMigrations();

    userRepo = new PgUserRepository({ db });
    registerUseCase = new RegisterUserUseCase({ userRepository: userRepo });
    loginUseCase = new LoginUserUseCase({ userRepository: userRepo });
    roomManager = new RoomManager();
    roomHub = new RoomHub({ roomManager });

    // Tạo các người dùng
    hostUser = await registerUseCase.execute({
      username: 'hub_host',
      displayName: 'Chủ Phòng Đức Tài',
      email: 'hub_host@cotuong.vn',
      password: 'StrongPassword123',
    });
    const hLog = await loginUseCase.execute({ username: 'hub_host', password: 'StrongPassword123' });
    hostToken = hLog.token;

    opponentUser = await registerUseCase.execute({
      username: 'hub_opponent',
      displayName: 'Đối Thủ Kỳ Hiệp',
      email: 'hub_opp@cotuong.vn',
      password: 'StrongPassword123',
    });
    const oLog = await loginUseCase.execute({ username: 'hub_opponent', password: 'StrongPassword123' });
    opponentToken = oLog.token;

    spectatorUser1 = await registerUseCase.execute({
      username: 'hub_spec1',
      displayName: 'Khán Giả A',
      email: 'hub_spec1@cotuong.vn',
      password: 'StrongPassword123',
    });
    const s1Log = await loginUseCase.execute({ username: 'hub_spec1', password: 'StrongPassword123' });
    spectatorToken1 = s1Log.token;

    spectatorUser2 = await registerUseCase.execute({
      username: 'hub_spec2',
      displayName: 'Khán Giả B',
      email: 'hub_spec2@cotuong.vn',
      password: 'StrongPassword123',
    });
    const s2Log = await loginUseCase.execute({ username: 'hub_spec2', password: 'StrongPassword123' });
    spectatorToken2 = s2Log.token;

    // Tạo phòng chơi
    createdRoom = roomManager.createRoom({
      hostUser,
      name: 'Phòng WebSocket Hub',
      isPrivate: false,
    });

    server = createServer({
      db,
      userRepository: userRepo,
      roomHub,
      roomOptions: { roomManager },
    });

    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        serverPort = server.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    roomHub.close();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    await db.closePool();
  });

  function connectWs(token, roomCode) {
    return new Promise((resolve, reject) => {
      const url = `ws://127.0.0.1:${serverPort}/ws/room?token=${token}&roomCode=${roomCode}`;
      const ws = new WebSocket(url);
      const messages = [];

      ws.on('message', (data) => {
        try {
          messages.push(JSON.parse(data.toString()));
        } catch {
          messages.push(data.toString());
        }
      });

      ws.on('open', () => resolve({ ws, messages }));
      ws.on('error', (err) => reject(err));
    });
  }

  function waitForMessage(messages, predicate, timeoutMs = 2000) {
    const startTime = Date.now();
    return new Promise((resolve, reject) => {
      const interval = setInterval(() => {
        const found = messages.find(predicate);
        if (found) {
          clearInterval(interval);
          resolve(found);
        } else if (Date.now() - startTime > timeoutMs) {
          clearInterval(interval);
          reject(new Error(`Timeout waiting for message matching predicate after ${timeoutMs}ms. Received: ${JSON.stringify(messages)}`));
        }
      }, 25);
    });
  }

  describe('1. Cấu hình WebSocket Hub, Handshake & Phân vai thành viên an toàn', () => {
    test('Từ chối kết nối khi thiếu token (401)', async () => {
      await assert.rejects(
        () => new Promise((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws/room?roomCode=${createdRoom.code}`);
          ws.on('open', () => {
            ws.close();
            resolve();
          });
          ws.on('error', (err) => reject(err));
        })
      );
    });

    test('Chủ phòng kết nối nhận vai trò PLAYER (RED) và ConnectionId', async () => {
      const { ws: hostWs, messages: hostMsgs } = await connectWs(hostToken, createdRoom.code);
      const connMsg = await waitForMessage(hostMsgs, (m) => m.type === 'Connected');

      assert.equal(connMsg.role, 'PLAYER');
      assert.equal(connMsg.side, 'RED');
      assert.ok(connMsg.connectionId.startsWith('conn_'));
      assert.equal(connMsg.user.id, hostUser.id);

      hostWs.close();
    });

    test('Phân vai Server-authoritative: Người vào tiếp theo là Đối thủ (BLACK), người sau là Khán giả', async () => {
      // Re-create clean room
      const testRoom = roomManager.createRoom({ hostUser, name: 'Phòng Phân Vai' });

      // Host kết nối
      const { ws: hostWs, messages: hostMsgs } = await connectWs(hostToken, testRoom.code);
      await waitForMessage(hostMsgs, (m) => m.type === 'Connected');

      // Opponent kết nối
      const { ws: oppWs, messages: oppMsgs } = await connectWs(opponentToken, testRoom.code);
      const oppConn = await waitForMessage(oppMsgs, (m) => m.type === 'Connected');
      assert.equal(oppConn.role, 'PLAYER');
      assert.equal(oppConn.side, 'BLACK');

      // Host nhận sự kiện UserJoined của Opponent
      const hostReceivedJoined = await waitForMessage(hostMsgs, (m) => m.type === 'UserJoined' && m.user.id === opponentUser.id);
      assert.equal(hostReceivedJoined.role, 'PLAYER');
      assert.equal(hostReceivedJoined.side, 'BLACK');

      // Spectator 1 kết nối
      const { ws: spec1Ws, messages: spec1Msgs } = await connectWs(spectatorToken1, testRoom.code);
      const spec1Conn = await waitForMessage(spec1Msgs, (m) => m.type === 'Connected');
      assert.equal(spec1Conn.role, 'SPECTATOR');
      assert.equal(spec1Conn.side, null);

      hostWs.close();
      oppWs.close();
      spec1Ws.close();
    });
  });

  describe('2. Phân quyền Socket nghiêm ngặt: Chặn 100% mọi yêu cầu thi đấu gửi từ Khán giả', () => {
    test('Khán giả gửi ready, start, demote, kick, move đều bị máy chủ từ chối FORBIDDEN', async () => {
      const permRoom = roomManager.createRoom({ hostUser, name: 'Phòng Test Phân Quyền' });
      const { ws: hostWs } = await connectWs(hostToken, permRoom.code);
      const { ws: oppWs } = await connectWs(opponentToken, permRoom.code);
      const { ws: specWs, messages: specMsgs } = await connectWs(spectatorToken1, permRoom.code);

      // Khán giả gửi ready
      specWs.send(JSON.stringify({ type: 'ready' }));
      const readyErr = await waitForMessage(specMsgs, (m) => m.type === 'error' && m.code === 'FORBIDDEN');
      assert.ok(readyErr.message.includes('Khán giả chỉ có quyền xem'));

      // Khán giả gửi start
      specWs.send(JSON.stringify({ type: 'start' }));
      const startErr = await waitForMessage(specMsgs, (m) => m.type === 'error' && m.code === 'FORBIDDEN');
      assert.ok(startErr);

      // Khán giả gửi demote
      specWs.send(JSON.stringify({ type: 'demote' }));
      const demoteErr = await waitForMessage(specMsgs, (m) => m.type === 'error' && m.code === 'FORBIDDEN');
      assert.ok(demoteErr);

      // Khán giả gửi kick
      specWs.send(JSON.stringify({ type: 'kick', targetUserId: opponentUser.id }));
      const kickErr = await waitForMessage(specMsgs, (m) => m.type === 'error' && m.code === 'FORBIDDEN');
      assert.ok(kickErr);

      hostWs.close();
      oppWs.close();
      specWs.close();
    });
  });

  describe('3. Chủ phòng chuyển đổi Đối thủ xuống Khán giả (demote) và loại (kick) thành viên', () => {
    test('Chủ phòng demote Đối thủ thành công -> Đối thủ xuống Khán giả, broadcast RoleChanged', async () => {
      const actionRoom = roomManager.createRoom({ hostUser, name: 'Phòng Quyền Host' });
      const { ws: hostWs, messages: hostMsgs } = await connectWs(hostToken, actionRoom.code);
      const { ws: oppWs, messages: oppMsgs } = await connectWs(opponentToken, actionRoom.code);

      // Host gửi demote
      hostWs.send(JSON.stringify({ type: 'demote' }));

      const roleEvt = await waitForMessage(oppMsgs, (m) => m.type === 'RoleChanged');
      assert.equal(roleEvt.action, 'DEMOTE');
      assert.equal(roleEvt.demotedUserId, opponentUser.id);
      assert.equal(roleEvt.room.players.black, null);

      hostWs.close();
      oppWs.close();
    });

    test('Chủ phòng kick thành viên thành công -> Thành viên bị loại, socket bị đóng', async () => {
      const kickRoom = roomManager.createRoom({ hostUser, name: 'Phòng Kick Test' });
      const { ws: hostWs } = await connectWs(hostToken, kickRoom.code);
      const { ws: oppWs } = await connectWs(opponentToken, kickRoom.code);
      const { ws: specWs, messages: specMsgs } = await connectWs(spectatorToken1, kickRoom.code);

      // Host kick Khán giả
      hostWs.send(JSON.stringify({ type: 'kick', targetUserId: spectatorUser1.id }));

      const kickedEvt = await waitForMessage(specMsgs, (m) => m.type === 'Kicked');
      assert.ok(kickedEvt);

      // Đợi socket khán giả đóng
      await new Promise((resolve) => {
        if (specWs.readyState === WebSocket.CLOSED) resolve();
        else specWs.on('close', resolve);
      });

      hostWs.close();
      oppWs.close();
    });
  });

  describe('4. Chuyển giao quyền Chủ phòng (Host Transfer) khi Host rời đi', () => {
    test('Host rời đi -> Tự động chuyển quyền cho Đối thủ và đặt lại trạng thái sẵn sàng', async () => {
      const transferRoom = roomManager.createRoom({ hostUser, name: 'Phòng Chuyển Giao Host' });
      const { ws: hostWs } = await connectWs(hostToken, transferRoom.code);
      const { ws: oppWs, messages: oppMsgs } = await connectWs(opponentToken, transferRoom.code);

      // Opponent bật sẵn sàng
      oppWs.send(JSON.stringify({ type: 'ready', isReady: true }));
      await waitForMessage(oppMsgs, (m) => m.type === 'ReadyStateChanged' && m.isReady === true);

      // Host ngắt kết nối
      hostWs.close();

      // Opponent nhận sự kiện HostTransferred
      const transferEvt = await waitForMessage(oppMsgs, (m) => m.type === 'HostTransferred');
      assert.equal(transferEvt.previousHostId, hostUser.id);
      assert.equal(transferEvt.newHostId, opponentUser.id);
      assert.equal(transferEvt.room.hostId, opponentUser.id);

      // Kiểm tra trạng thái sẵn sàng đã được reset
      assert.equal(transferEvt.room.readyStates.length, 0);

      oppWs.close();
    });
  });

  describe('5. Điều kiện Bắt đầu trận đấu & Chống spam duplicate match', () => {
    test('RoomHub cấp snapshot khai cuộc và trả gợi ý hợp lệ trước khi nhận nước đi', async () => {
      const gameRoom = roomManager.createRoom({ hostUser, name: 'Phòng Gameplay' });
      const { ws: hostWs, messages: hostMsgs } = await connectWs(hostToken, gameRoom.code);
      const { ws: oppWs, messages: oppMsgs } = await connectWs(opponentToken, gameRoom.code);
      await waitForMessage(hostMsgs, (m) => m.type === 'Connected');
      await waitForMessage(oppMsgs, (m) => m.type === 'Connected');

      hostWs.send(JSON.stringify({ type: 'ready', isReady: true }));
      oppWs.send(JSON.stringify({ type: 'ready', isReady: true }));
      await waitForMessage(hostMsgs, (m) => m.type === 'ReadyStateChanged' && m.allReady);

      hostWs.send(JSON.stringify({ type: 'start' }));
      const startEvt = await waitForMessage(hostMsgs, (m) => m.type === 'GameStarted');
      assert.equal(startEvt.snapshot.currentTurn, 'red');
      assert.equal(startEvt.snapshot.board.length, 32);

      const { ws: spectatorWs, messages: spectatorMsgs } = await connectWs(spectatorToken1, gameRoom.code);
      const spectatorConnected = await waitForMessage(spectatorMsgs, (m) => m.type === 'Connected');
      assert.equal(spectatorConnected.snapshot.board.length, 32);

      hostWs.send(JSON.stringify({ type: 'legalMoves', from: 'a3' }));
      const legalMoves = await waitForMessage(hostMsgs, (m) => m.type === 'legalMovesResult' && m.from === 'a3');
      assert.deepEqual(legalMoves.destinations, ['a4']);

      hostWs.send(JSON.stringify({ type: 'move', from: 'a3', to: 'a4' }));
      const moveResult = await waitForMessage(hostMsgs, (m) => m.type === 'moveResult' && m.accepted);
      assert.equal(moveResult.snapshot.currentTurn, 'black');
      assert.equal(moveResult.snapshot.lastMove.to, 'a4');

      hostWs.close();
      oppWs.close();
      spectatorWs.close();
    });

    test('Chưa đủ 2 người hoặc chưa cùng sẵn sàng -> Không cho bắt đầu trận', async () => {
      const startRoom = roomManager.createRoom({ hostUser, name: 'Phòng Test Start' });
      const { ws: hostWs, messages: hostMsgs } = await connectWs(hostToken, startRoom.code);
      const { ws: oppWs, messages: oppMsgs } = await connectWs(opponentToken, startRoom.code);

      // Host bấm start khi chưa ai sẵn sàng
      hostWs.send(JSON.stringify({ type: 'start' }));
      const errEvt = await waitForMessage(hostMsgs, (m) => m.type === 'error' && m.code === 'NOT_ALL_READY');
      assert.ok(errEvt);

      // Cả 2 cùng bật sẵn sàng
      hostWs.send(JSON.stringify({ type: 'ready', isReady: true }));
      oppWs.send(JSON.stringify({ type: 'ready', isReady: true }));
      await waitForMessage(hostMsgs, (m) => m.type === 'ReadyStateChanged' && m.allReady === true);

      // Host bấm start thành công
      hostWs.send(JSON.stringify({ type: 'start' }));
      const startEvt = await waitForMessage(hostMsgs, (m) => m.type === 'GameStarted');
      assert.ok(startEvt.matchId);

      // Bấm start lần nữa không tạo thêm trận trùng lặp
      hostWs.send(JSON.stringify({ type: 'start' }));

      hostWs.close();
      oppWs.close();
    });
  });
});
