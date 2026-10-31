// CLEAN-04: test hành vi thật của hook useMatch (tải trận qua HTTP, WebSocket giả, gửi nước đi,
// kết nối lại, định tuyến chat / cuộc gọi). Không kiểm tra chuỗi mã nguồn.
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMatch } from '../../src/application/hooks/useMatch.js';
import { TokenStorage } from '../../src/infrastructure/storage/tokenStorage.js';

// WebSocket giả: test tự điều khiển open / message / close
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.listeners = {};
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, handler) {
    (this.listeners[type] ||= []).push(handler);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  emit(type, event = {}) {
    (this.listeners[type] || []).forEach((handler) => handler(event));
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    act(() => this.emit('open'));
  }

  receive(message) {
    act(() => this.emit('message', { data: JSON.stringify(message) }));
  }

  drop(code = 1006) {
    this.readyState = FakeWebSocket.CLOSED;
    act(() => this.emit('close', { code }));
  }
}

const MATCH = { id: 'COT-615', status: 'active', currentTurn: 'red', board: [] };

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
  };
}

const sockets = () => FakeWebSocket.instances;
const lastSocket = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

// Dựng hook, chờ HTTP xong và WebSocket được tạo + mở
async function renderConnectedMatch(options) {
  const view = renderHook(() => useMatch('COT-615', options));
  await waitFor(() => expect(sockets().length).toBeGreaterThan(0));
  lastSocket().open();
  return view;
}

describe('useMatch', () => {
  let fetchMock;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    fetchMock = vi.fn(async () => jsonResponse(MATCH));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  describe('tải trận và kết nối', () => {
    it('không có matchId thì không gọi mạng', () => {
      renderHook(() => useMatch(null));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(sockets()).toHaveLength(0);
    });

    it('tải trận qua HTTP rồi mở WebSocket tới đúng trận, token đi qua subprotocol', async () => {
      TokenStorage.setAccessToken('abc.def.ghi');
      const { result } = await renderConnectedMatch();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toMatch(/\/api\/matches\/COT-615$/);
      expect(init.headers.Authorization).toBe('Bearer abc.def.ghi');

      expect(lastSocket().url).toMatch(/^wss?:\/\/.+\/api\/matches\/COT-615\/ws$/);
      expect(lastSocket().url).not.toContain('abc.def.ghi'); // token không nằm trong URL
      expect(lastSocket().protocols).toEqual(['cotuong.v1', 'access_token.abc.def.ghi']);

      await waitFor(() => expect(result.current.connected).toBe(true));
      expect(result.current.match).toEqual(MATCH);
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
    });

    it('nhận welcome thì gán màu quân, trạng thái trận và mở khoá thao tác', async () => {
      const { result } = await renderConnectedMatch();
      lastSocket().receive({ type: 'welcome', color: 'red', state: { ...MATCH, currentTurn: 'red' } });

      expect(result.current.color).toBe('red');
      expect(result.current.readOnly).toBe(false);
      expect(result.current.match.currentTurn).toBe('red');
    });

    it('welcome không có màu (khán giả) -> readOnly = true', async () => {
      const { result } = await renderConnectedMatch();
      lastSocket().receive({ type: 'welcome', color: null, state: MATCH });
      expect(result.current.readOnly).toBe(true);
    });

    it('lỗi 4xx (chưa đăng nhập / không có trận) báo lỗi và KHÔNG thử lại vô hạn', async () => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue(jsonResponse({ error: 'Không có quyền xem trận này.' }, 403));
      const { result } = renderHook(() => useMatch('COT-615'));

      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

      expect(result.current.error).toBe('Không có quyền xem trận này.');
      expect(result.current.loading).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sockets()).toHaveLength(0);
    });

    it('lỗi 5xx thì tự thử lại với độ trễ, thành công thì kết nối', async () => {
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ error: 'Lỗi máy chủ' }, 500))
        .mockResolvedValue(jsonResponse(MATCH));
      const { result } = renderHook(() => useMatch('COT-615'));

      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(result.current.error).toBe('Lỗi máy chủ');
      expect(sockets()).toHaveLength(0);

      await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sockets()).toHaveLength(1);
    });

    it('tháo hook thì đóng WebSocket và không còn kết nối lại', async () => {
      vi.useFakeTimers();
      const view = renderHook(() => useMatch('COT-615'));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const socket = lastSocket();
      socket.open();

      view.unmount();
      expect(socket.readyState).toBe(FakeWebSocket.CLOSED);

      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(sockets()).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('gửi nước đi', () => {
    it('yêu cầu danh sách điểm đến hợp lệ từ máy chủ khi chọn quân', async () => {
      const { result } = await renderConnectedMatch();
      lastSocket().receive({ type: 'welcome', color: 'red', state: MATCH });

      let accepted;
      act(() => { accepted = result.current.requestLegalMoves('a3'); });
      expect(accepted).toBe(true);
      expect(lastSocket().sent).toContainEqual({ type: 'legalMoves', from: 'a3' });

      lastSocket().receive({
        type: 'legalMovesResult',
        from: 'a3',
        destinations: ['a4'],
      });
      expect(result.current.legalMoves).toEqual({ from: 'a3', destinations: ['a4'] });
    });

    it('trận phòng thật dùng RoomHub cho snapshot, gợi ý nước đi và gửi nước đi', async () => {
      const { result } = renderHook(() => useMatch(null, { roomCode: '123456' }));
      await waitFor(() => expect(sockets()).toHaveLength(1));
      expect(fetchMock).not.toHaveBeenCalled();

      const socket = lastSocket();
      expect(socket.url).toMatch(/\/ws\/room\/123456$/);
      socket.open();
      socket.receive({
        type: 'Connected',
        role: 'PLAYER',
        side: 'RED',
        snapshot: {
          matchId: 'MATCH_ROOM',
          roomCode: '123456',
          status: 'active',
          currentTurn: 'red',
          board: [],
          plyCount: 0,
          remainingClocks: { red: 300, black: 300 },
        },
      });

      expect(result.current.color).toBe('red');
      expect(result.current.readOnly).toBe(false);
      expect(result.current.match.matchCode).toBe('123456');
      expect(result.current.loading).toBe(false);

      act(() => { result.current.requestLegalMoves('a3'); });
      expect(socket.sent).toContainEqual({ type: 'legalMoves', from: 'a3' });
      socket.receive({ type: 'legalMovesResult', from: 'a3', destinations: ['a4'] });
      expect(result.current.legalMoves).toEqual({ from: 'a3', destinations: ['a4'] });

      act(() => { result.current.sendMove('a3', 'a4'); });
      expect(socket.sent).toContainEqual({ type: 'move', from: 'a3', to: 'a4' });
      socket.receive({
        type: 'moveResult',
        accepted: true,
        snapshot: {
          matchId: 'MATCH_ROOM',
          roomCode: '123456',
          status: 'active',
          currentTurn: 'black',
          board: [],
          plyCount: 1,
          remainingClocks: { red: 299, black: 300 },
        },
      });
      expect(result.current.movePending).toBe(false);
      expect(result.current.match.currentTurn).toBe('black');
      expect(result.current.match.moveNumber).toBe(2);
    });

    it('chưa có kết nối thì không gửi và báo lỗi cho người chơi', async () => {
      const { result } = renderHook(() => useMatch('COT-615'));
      await waitFor(() => expect(sockets()).toHaveLength(1)); // socket còn CONNECTING

      let accepted;
      act(() => { accepted = result.current.sendMove('a3', 'a4'); });
      expect(accepted).toBe(false);
      expect(lastSocket().sent).toEqual([]);
      expect(result.current.moveError).toMatch(/Chưa kết nối/);
    });

    it('gửi {type:"move"} qua socket, đặt movePending, rồi nhận kết quả được chấp nhận', async () => {
      const { result } = await renderConnectedMatch();
      lastSocket().receive({ type: 'welcome', color: 'red', state: MATCH });

      let accepted;
      act(() => { accepted = result.current.sendMove('a3', 'a4'); });
      expect(accepted).toBe(true);
      expect(lastSocket().sent).toEqual([{ type: 'move', from: 'a3', to: 'a4' }]);
      expect(result.current.movePending).toBe(true);

      lastSocket().receive({
        type: 'moveResult',
        accepted: true,
        state: { ...MATCH, currentTurn: 'black', lastMove: { color: 'red', from: 'a3', to: 'a4' } },
        check: false,
      });
      expect(result.current.movePending).toBe(false);
      expect(result.current.moveError).toBeNull();
      expect(result.current.match.currentTurn).toBe('black');
      expect(result.current.moveResult.accepted).toBe(true);
    });

    it('đang chờ phản hồi của nước trước thì từ chối gửi nước thứ hai', async () => {
      const { result } = await renderConnectedMatch();
      act(() => { result.current.sendMove('a3', 'a4'); });

      let second;
      act(() => { second = result.current.sendMove('c3', 'c4'); });
      expect(second).toBe(false);
      expect(lastSocket().sent).toHaveLength(1);
      expect(result.current.moveError).toMatch(/Đang chờ máy chủ/);
    });

    it('server từ chối nước đi -> hiện lỗi, mở khoá để đi lại', async () => {
      const { result } = await renderConnectedMatch();
      act(() => { result.current.sendMove('a3', 'a7'); });
      lastSocket().receive({ type: 'moveResult', accepted: false, error: 'Nước đi không đúng luật của quân cờ.' });

      expect(result.current.movePending).toBe(false);
      expect(result.current.moveError).toBe('Nước đi không đúng luật của quân cờ.');

      act(() => result.current.clearMoveError());
      expect(result.current.moveError).toBeNull();

      let again;
      act(() => { again = result.current.sendMove('a3', 'a4'); });
      expect(again).toBe(true);
    });

    it('gói lỗi chung chỉ thành moveError khi đang có nước chờ phản hồi', async () => {
      const { result } = await renderConnectedMatch();

      lastSocket().receive({ type: 'error', message: 'Lỗi không liên quan' });
      expect(result.current.moveError).toBeNull();

      act(() => { result.current.sendMove('a3', 'a4'); });
      lastSocket().receive({ type: 'error', message: 'Chưa tới lượt của bạn.' });
      expect(result.current.moveError).toBe('Chưa tới lượt của bạn.');
      expect(result.current.movePending).toBe(false);
    });
  });

  describe('mất kết nối và kết nối lại', () => {
    it('socket đóng bất thường -> khoá nước đi, báo lỗi, tự kết nối lại sau backoff', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useMatch('COT-615'));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      lastSocket().open();
      expect(result.current.connected).toBe(true);

      lastSocket().drop(1006);
      expect(result.current.connected).toBe(false);
      expect(result.current.error).toMatch(/đang kết nối lại/);
      expect(result.current.reconnectState.selfDisconnected).toBe(true);

      let accepted;
      act(() => { accepted = result.current.sendMove('a3', 'a4'); });
      expect(accepted).toBe(false);
      expect(result.current.moveError).toMatch(/tạm khóa/);

      await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
      expect(sockets()).toHaveLength(2);
      lastSocket().open();
      expect(result.current.connected).toBe(true);
      expect(result.current.reconnectState.selfDisconnected).toBe(false);
    });

    it('server đóng với mã từ chối (4001) thì dừng, không thử lại', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useMatch('COT-615'));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      lastSocket().open();

      lastSocket().drop(4001);
      expect(result.current.error).toMatch(/từ chối/);

      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(sockets()).toHaveLength(1);
    });

    it('REV2-11: đóng với mã 4008 (heartbeat timeout của roomHub) thì VẪN kết nối lại', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useMatch('COT-615'));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      lastSocket().open();

      lastSocket().drop(4008);
      expect(result.current.error).toMatch(/kết nối lại/);
      expect(result.current.error).not.toMatch(/từ chối/);

      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(sockets().length).toBeGreaterThan(1);
    });

    it('REV2-12: `online` khi socket cũ đang CLOSING không mở socket song song; chỉ kết nối lại sau khi nó đóng', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useMatch('COT-615'));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const first = lastSocket();
      first.open();

      first.readyState = FakeWebSocket.CLOSING; // server đang đóng, close chưa phát
      act(() => { window.dispatchEvent(new Event('online')); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(sockets()).toHaveLength(1);

      first.drop(1001); // close thật sự -> lên lịch kết nối lại
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(sockets()).toHaveLength(2);
      lastSocket().open();
      expect(result.current.socketRef.current).toBe(lastSocket());
    });

    it('REV2-12: close/error/message muộn của socket cũ bị bỏ qua (không xoá socketRef, không thêm socket)', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useMatch('COT-615'));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const first = lastSocket();
      first.open();
      first.drop(1006);
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      const second = lastSocket();
      expect(second).not.toBe(first);
      second.open();

      // sự kiện muộn của socket cũ
      act(() => first.emit('close', { code: 1001 }));
      act(() => first.emit('error', {}));
      act(() => first.emit('message', { data: JSON.stringify({ type: 'welcome', color: 'black', state: MATCH }) }));
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

      expect(sockets()).toHaveLength(2);
      expect(result.current.socketRef.current).toBe(second);
      expect(result.current.connected).toBe(true);
      expect(result.current.color).not.toBe('black');
    });

    it('đối thủ rớt mạng -> bật đếm ngược và khoá nước đi; đối thủ quay lại -> mở khoá', async () => {
      const { result } = await renderConnectedMatch();
      lastSocket().receive({ type: 'welcome', color: 'red', state: MATCH });

      lastSocket().receive({ type: 'opponentDisconnected', countdownSeconds: 45 });
      expect(result.current.reconnectState.opponentDisconnected).toBe(true);
      expect(result.current.reconnectState.reconnectCountdown).toBe(45);
      let blocked;
      act(() => { blocked = result.current.sendMove('a3', 'a4'); });
      expect(blocked).toBe(false);

      lastSocket().receive({ type: 'opponentReconnected' });
      expect(result.current.reconnectState.opponentDisconnected).toBe(false);
      let allowed;
      act(() => { allowed = result.current.sendMove('a3', 'a4'); });
      expect(allowed).toBe(true);
    });

    it('trình duyệt báo offline -> khoá bàn cờ ngay', async () => {
      const { result } = await renderConnectedMatch();
      act(() => { window.dispatchEvent(new Event('offline')); });
      expect(result.current.reconnectState.selfDisconnected).toBe(true);
      expect(result.current.reconnectState.canMove).toBe(false);
    });

    it('trình duyệt báo online nhưng socket chưa sống lại thì kết nối lại ngay (không chờ backoff)', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useMatch('COT-615'));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      lastSocket().open();
      lastSocket().drop(1006);
      expect(sockets()).toHaveLength(1);

      await act(async () => {
        window.dispatchEvent(new Event('online'));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(sockets()).toHaveLength(2);
      // vẫn khoá cho tới khi socket thật sự OPEN
      expect(result.current.reconnectState.selfDisconnected).toBe(true);
      lastSocket().open();
      expect(result.current.reconnectState.selfDisconnected).toBe(false);
    });

    it('nhận kết quả chốt ván từ server thì khoá nước đi và lưu kết quả', async () => {
      const { result } = await renderConnectedMatch();
      lastSocket().receive({ type: 'matchEnded', winner: 'red', winnerColor: 'red', reason: 'CHECKMATE' });
      expect(result.current.reconnectState.serverResult).toMatchObject({ winner: 'red' });
      expect(result.current.reconnectState.canMove).toBe(false);
    });
  });

  describe('REV2-10: demo tự reset ván mới sau khi kết thúc', () => {
    const state = (patch) => ({ ...MATCH, ...patch });
    const push = (patch) => lastSocket().receive({ type: 'state', color: 'red', readOnly: false, state: state(patch) });

    it('state completed khoá bàn; state active tiếp theo mở khoá lại và sendMove gửi được', async () => {
      const { result } = await renderConnectedMatch();
      await waitFor(() => expect(result.current.connected).toBe(true));

      push({ status: 'completed', winner: 'black', endReason: 'TIMEOUT' });
      expect(result.current.reconnectState.serverResult).toMatchObject({ winner: 'black' });
      expect(result.current.reconnectState.canMove).toBe(false);

      // ván mới (REV-19 tự reset)
      push({ status: 'active', winner: null, endReason: null });
      expect(result.current.reconnectState.serverResult).toBeNull();
      expect(result.current.reconnectState.canMove).toBe(true);

      let sent;
      act(() => { sent = result.current.sendMove('a3', 'a4'); });
      expect(sent).toBe(true);
      expect(lastSocket().sent.at(-1)).toMatchObject({ type: 'move', from: 'a3', to: 'a4' });
    });

    it('matchEnded rồi state completed không ghi đè kết quả; reset xong vẫn mở khoá', async () => {
      const { result } = await renderConnectedMatch();
      push({ status: 'active' });
      lastSocket().receive({ type: 'matchEnded', winner: 'red', winnerColor: 'red', reason: 'CHECKMATE', message: 'Đỏ thắng' });
      push({ status: 'completed', winner: 'red', endReason: 'CHECKMATE' });
      expect(result.current.reconnectState.serverResult).toMatchObject({ message: 'Đỏ thắng' });

      push({ status: 'active' });
      expect(result.current.reconnectState.canMove).toBe(true);
    });

    it('state completed lặp lại (cùng ván) không mở khoá và không tạo kết quả mới', async () => {
      const { result } = await renderConnectedMatch();
      push({ status: 'completed', winner: 'red', endReason: 'RESIGN' });
      const first = result.current.reconnectState.serverResult;
      push({ status: 'completed', winner: 'red', endReason: 'RESIGN' });
      expect(result.current.reconnectState.serverResult).toBe(first);
      expect(result.current.reconnectState.canMove).toBe(false);
    });
  });

  describe('định tuyến tin từ server', () => {
    it('ChatMessage / ChatError đi tới subscribeChat, không thành lỗi nước đi', async () => {
      const { result } = await renderConnectedMatch();
      const onChat = vi.fn();
      let unsubscribe;
      act(() => { unsubscribe = result.current.subscribeChat(onChat); });

      lastSocket().receive({ type: 'ChatMessage', id: 'm1', clientId: 'c1', text: 'chào' });
      lastSocket().receive({ type: 'error', code: 'CHAT_RATE_LIMITED', message: 'Nhắn quá nhanh' });

      expect(onChat).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: 'ChatMessage', text: 'chào' }));
      expect(onChat).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: 'ChatError', code: 'CHAT_RATE_LIMITED' }));
      expect(result.current.moveError).toBeNull();

      unsubscribe();
      lastSocket().receive({ type: 'ChatMessage', id: 'm2', clientId: 'c2', text: 'sau khi huỷ' });
      expect(onChat).toHaveBeenCalledTimes(2);
    });

    it('gói Call* đi tới handler signaling; lỗi cuộc gọi thành CallError', async () => {
      const { result } = await renderConnectedMatch();
      const onSignal = vi.fn();
      act(() => result.current.setSignalingHandler(onSignal));

      lastSocket().receive({ type: 'CallIncoming', callId: 'c1' });
      lastSocket().receive({ type: 'error', code: 'OPPONENT_NOT_FOUND', message: 'Đối thủ chưa vào phòng' });

      expect(onSignal).toHaveBeenNthCalledWith(1, { type: 'CallIncoming', callId: 'c1' });
      expect(onSignal).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: 'CallError', code: 'OPPONENT_NOT_FOUND' }));
      expect(result.current.moveError).toBeNull();
    });

    it('sendSignaling trên trận demo gửi qua chính WebSocket của trận', async () => {
      const { result } = await renderConnectedMatch();
      expect(result.current.isSignalingReady()).toBe(true);

      let sent;
      act(() => { sent = result.current.sendSignaling({ type: 'call:request' }); });
      expect(sent).toBe(true);
      expect(lastSocket().sent).toContainEqual({ type: 'call:request' });
    });

    it('mất socket của trận demo thì báo CallEnded(SIGNALING_LOST) để dọn cuộc gọi', async () => {
      const { result } = await renderConnectedMatch();
      const onSignal = vi.fn();
      act(() => result.current.setSignalingHandler(onSignal));

      lastSocket().drop(1006);
      expect(onSignal).toHaveBeenCalledWith(expect.objectContaining({ type: 'CallEnded', reason: 'SIGNALING_LOST' }));
      expect(result.current.isSignalingReady()).toBe(false);
    });

    it('phản hồi không phải JSON hợp lệ không làm vỡ hook, chỉ báo lỗi', async () => {
      const { result } = await renderConnectedMatch();
      act(() => lastSocket().emit('message', { data: '{không phải json' }));
      expect(result.current.error).toMatch(/Phản hồi máy chủ không hợp lệ/);
    });
  });
});
