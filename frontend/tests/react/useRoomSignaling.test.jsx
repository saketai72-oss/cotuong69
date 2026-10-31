// REV2-15: test hành vi hook useRoomSignaling với WebSocket giả (không đọc mã nguồn).
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRoomSignaling } from '../../src/application/hooks/useRoomSignaling.js';
import { TokenStorage } from '../../src/infrastructure/storage/tokenStorage.js';

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
    this.closeCalls = 0;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }

  send(data) { this.sent.push(JSON.parse(data)); }

  close() {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
  }

  emit(type, event = {}) { (this.listeners[type] || []).forEach((handler) => handler(event)); }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    act(() => this.emit('open'));
  }

  receive(message) { act(() => this.emit('message', { data: JSON.stringify(message) })); }

  drop(code = 1006) {
    this.readyState = FakeWebSocket.CLOSED;
    act(() => this.emit('close', { code }));
  }
}

const sockets = () => FakeWebSocket.instances;
const last = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

describe('useRoomSignaling', () => {
  let onMessage;
  let onChat;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    onMessage = vi.fn();
    onChat = vi.fn();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('không có roomCode thì không mở socket', () => {
    const { result } = renderHook(() => useRoomSignaling(null, onMessage, onChat));
    expect(sockets()).toHaveLength(0);
    expect(result.current.isReady()).toBe(false);
    expect(result.current.send({ type: 'call:request' })).toBe(false);
  });

  it('mở /ws/room/:code với token qua subprotocol (không nằm trong URL); send chỉ khi OPEN', () => {
    TokenStorage.setAccessToken('aaa.bbb.ccc');
    const { result } = renderHook(() => useRoomSignaling('123456', onMessage, onChat));

    expect(sockets()).toHaveLength(1);
    expect(last().url).toMatch(/^wss?:\/\/.+\/ws\/room\/123456$/);
    expect(last().url).not.toContain('aaa.bbb.ccc');
    expect(last().protocols).toEqual(['cotuong.v1', 'access_token.aaa.bbb.ccc']);

    expect(result.current.isReady()).toBe(false);
    expect(result.current.send({ type: 'call:request' })).toBe(false);

    last().open();
    expect(result.current.isReady()).toBe(true);
    expect(result.current.send({ type: 'call:request' })).toBe(true);
    expect(last().sent).toEqual([{ type: 'call:request' }]);
  });

  it('định tuyến: Call* -> onMessage, ChatMessage/lỗi chat -> onChat, tin phòng khác bị bỏ qua', () => {
    renderHook(() => useRoomSignaling('123456', onMessage, onChat));
    last().open();

    last().receive({ type: 'CallIncoming', callId: 'c1' });
    last().receive({ type: 'ChatMessage', id: 'm1', text: 'chào' });
    last().receive({ type: 'error', code: 'CHAT_RATE_LIMITED', message: 'nhanh quá' });
    last().receive({ type: 'error', code: 'SPECTATOR_CANNOT_CHAT', message: 'khán giả' });
    last().receive({ type: 'UserJoined', user: { id: 2 } });
    last().receive({ type: 'ReadyStateChanged' });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'CallIncoming' }));
    expect(onChat).toHaveBeenCalledTimes(3);
    expect(onChat).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: 'ChatMessage' }));
    expect(onChat).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: 'ChatError', code: 'CHAT_RATE_LIMITED' }));
    expect(onChat).toHaveBeenNthCalledWith(3, expect.objectContaining({ type: 'ChatError', code: 'SPECTATOR_CANNOT_CHAT' }));
  });

  it('tin không phải JSON bị bỏ qua, không làm vỡ hook', () => {
    renderHook(() => useRoomSignaling('123456', onMessage, onChat));
    last().open();
    act(() => last().emit('message', { data: 'không phải json' }));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('socket rớt (1006): báo CallEnded(SIGNALING_LOST) và tự kết nối lại; mở lại được thì xoá lỗi', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useRoomSignaling('123456', onMessage, onChat));
    last().open();

    last().drop(1006);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'CallEnded', reason: 'SIGNALING_LOST' }));
    expect(result.current.isReady()).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(sockets()).toHaveLength(2);
    last().open();
    expect(result.current.isReady()).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('mã 4008 (heartbeat timeout) vẫn kết nối lại; mã 4001/4003/1008 thì dừng và báo lỗi', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useRoomSignaling('123456', onMessage, onChat));
    last().open();
    last().drop(4008);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(sockets()).toHaveLength(2);

    last().open();
    last().drop(4003); // bị chủ phòng loại
    expect(result.current.error).toMatch(/từ chối/);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(sockets()).toHaveLength(2);
  });

  it('chưa từng mở được sau 5 lần liên tiếp thì dừng, báo lỗi (sai quyền / mã phòng)', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useRoomSignaling('123456', onMessage, onChat));
    for (let i = 0; i < 5; i += 1) {
      last().drop(1006);
      // eslint-disable-next-line no-await-in-loop
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    }
    expect(sockets()).toHaveLength(5);
    expect(result.current.error).toMatch(/Không kết nối được máy chủ phòng/);
  });

  it('tháo hook: đóng socket và không còn kết nối lại', async () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useRoomSignaling('123456', onMessage, onChat));
    const first = last();
    first.open();
    first.drop(1006); // đã lên lịch kết nối lại
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(sockets()).toHaveLength(1);

    const second = renderHook(() => useRoomSignaling('654321', onMessage, onChat));
    const open = last();
    open.open();
    second.unmount();
    expect(open.closeCalls).toBe(1);
  });
});
