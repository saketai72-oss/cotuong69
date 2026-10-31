// PVE-UI: test màn hình chơi với máy (React + XiangqiBoard) với fetch giả mô phỏng backend PvE:
// tải ván, đi quân -> máy đáp, lỗi nước đi, xin thua có xác nhận, hết giờ do server xử, tải lại tiếp tục ván,
// các kiểu kết quả (thắng / thua / hoà / không xác định) và lý do bằng tiếng Việt.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PveScreen from '../../src/presentation/pve/PveScreen.jsx';
import Root from '../../src/Root.jsx';
import { TokenStorage } from '../../src/infrastructure/storage/tokenStorage.js';
import { createFakePveServer } from './helpers/fakePveServer.js';

const FILES = 'abcdefghi';

function svgPointOf(position, orientation = 'red') {
  const file = FILES.indexOf(position[0]);
  const rank = Number(position[1]);
  const left = 54, right = 846, top = 48, bottom = 952;
  return orientation === 'black'
    ? { x: right - (right - left) * (file / 8), y: top + (bottom - top) * (rank / 9) }
    : { x: left + (right - left) * (file / 8), y: bottom - (bottom - top) * (rank / 9) };
}

// jsdom không có hình học SVG: cho toạ độ chuột (clientX/Y) trùng toạ độ viewBox
function stubSvgGeometry(svg) {
  svg.getScreenCTM = () => ({ inverse: () => ({}) });
  svg.createSVGPoint = () => ({
    x: 0,
    y: 0,
    matrixTransform() { return { x: this.x, y: this.y }; },
  });
}

let server;

function mount(matchId = '1') {
  const view = render(<PveScreen matchId={matchId} />);
  return view;
}

async function mountLoaded(matchId = '1') {
  const view = mount(matchId);
  await act(async () => { await Promise.resolve(); });
  await screen.findByTestId('pve-screen');
  const svg = view.container.querySelector('svg.xiangqi-board');
  stubSvgGeometry(svg);
  return { ...view, svg };
}

function clickAt(svg, position, orientation = 'red') {
  const { x, y } = svgPointOf(position, orientation);
  fireEvent.click(svg, { clientX: x, clientY: y });
}

const pieceAt = (container, position) => container.querySelector(`[data-position="${position}"]`);

describe('PveScreen', () => {
  beforeEach(() => {
    localStorage.clear();
    TokenStorage.setAccessToken('tok.en.123');
    server = createFakePveServer();
    vi.stubGlobal('fetch', vi.fn(server.fetch));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  describe('tải ván', () => {
    it('GET ván bằng Bearer token, vẽ đủ 32 quân, Đỏ ở dưới, báo đến lượt bạn và hiện đồng hồ lượt', async () => {
      const { container } = await mountLoaded();

      const [url, init] = fetch.mock.calls[0];
      expect(url).toMatch(/\/api\/pve\/matches\/1$/);
      expect(init.method).toBe('GET');
      expect(init.headers.Authorization).toBe('Bearer tok.en.123');

      expect(container.querySelectorAll('[data-piece-id]')).toHaveLength(32);
      const red = svgPointOf('e0');
      expect(pieceAt(container, 'e0').getAttribute('transform')).toBe(`translate(${red.x} ${red.y})`);
      const letters = [...container.querySelectorAll('.coordinate-top span')].map((n) => n.textContent);
      expect(letters[0]).toBe('a');

      expect(screen.getByTestId('pve-turn')).toHaveTextContent('Đến lượt bạn');
      expect(screen.getByTestId('pve-clock')).toHaveTextContent('01:00');
      expect(screen.getByTestId('pve-ply')).toHaveTextContent('0');
    });

    it('người chơi cầm Đen: bàn cờ lật (Đen ở dưới) và nước đi đầu của máy đã có trên bàn', async () => {
      server = createFakePveServer({ playerColor: 'black' });
      fetch.mockImplementation(server.fetch);
      const { container } = await mountLoaded();

      const letters = [...container.querySelectorAll('.coordinate-top span')].map((n) => n.textContent);
      expect(letters[0]).toBe('i');
      const blackGeneral = svgPointOf('e9', 'black');
      expect(pieceAt(container, 'e9').getAttribute('transform')).toBe(`translate(${blackGeneral.x} ${blackGeneral.y})`);
      // máy (Đỏ) đã đi a3 -> a4
      expect(pieceAt(container, 'a4')).not.toBeNull();
      expect(pieceAt(container, 'a3')).toBeNull();
      expect(screen.getByTestId('pve-ply')).toHaveTextContent('1');
      expect(screen.getByTestId('pve-turn')).toHaveTextContent('Đến lượt bạn');
    });

    it('chưa đăng nhập (401) hiện thông báo cần đăng nhập, không hiện bàn cờ', async () => {
      localStorage.clear();
      mount();
      await act(async () => { await Promise.resolve(); });
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Bạn cần đăng nhập để chơi với máy');
      expect(screen.queryByTestId('pve-screen')).toBeNull();
    });

    it('ván không tồn tại (404) hiện lỗi và đường về sảnh chờ', async () => {
      mount('999');
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Không tải được ván đấu với máy');
      expect(screen.getByRole('link', { name: 'Về sảnh chờ' })).toHaveAttribute('href', '/');
    });

    it('mã ván không hợp lệ không gọi mạng', () => {
      render(<PveScreen matchId={null} />);
      expect(fetch).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent('Mã ván đấu với máy không hợp lệ');
    });
  });

  describe('đi quân', () => {
    it('hiện dấu nước của người chơi 2 giây rồi mới hiện nước máy', async () => {
      const { container, svg } = await mountLoaded();
      const playerPawn = pieceAt(container, 'a3');
      const botPawn = pieceAt(container, 'a6');

      clickAt(svg, 'a3');
      const destination = await screen.findByLabelText('Đi đến a4');
      vi.useFakeTimers();
      await act(async () => {
        fireEvent.click(destination);
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId('pve-ply')).toHaveTextContent('1');
      expect(pieceAt(container, 'a4')).toBe(playerPawn);
      expect(pieceAt(container, 'a5')).toBeNull();
      expect(pieceAt(container, 'a6')).toBe(botPawn);
      expect(container.querySelector('.last-move-marker')).toHaveAttribute(
        'aria-label',
        'Nước đi gần nhất: a3 đến a4',
      );
      expect(screen.getByTestId('pve-turn')).toHaveTextContent('Máy đang suy nghĩ…');

      const post = fetch.mock.calls.find(([url]) => /\/moves$/.test(url));
      const legalMovesRequest = fetch.mock.calls.find(([url]) => /\/legal-moves$/.test(url));
      expect(JSON.parse(legalMovesRequest[1].body)).toEqual({ from: 'a3' });
      expect(legalMovesRequest[1].headers.Authorization).toBeTruthy();
      expect(post[0]).toMatch(/\/api\/pve\/matches\/1\/moves$/);
      expect(JSON.parse(post[1].body)).toEqual({ from: { row: 3, col: 0 }, to: { row: 4, col: 0 } });
      expect(post[1].headers.Authorization).toBeTruthy();

      await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
      expect(screen.getByTestId('pve-ply')).toHaveTextContent('1');
      expect(container.querySelector('.last-move-marker')).toHaveAttribute(
        'aria-label',
        'Nước đi gần nhất: a3 đến a4',
      );

      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      // quân của bạn đã sang a4; máy đáp bằng chốt đen a6 -> a5
      expect(screen.getByTestId('pve-ply')).toHaveTextContent('2');
      expect(pieceAt(container, 'a4')).toHaveAttribute('aria-label', expect.stringContaining('Đỏ Chốt'));
      expect(pieceAt(container, 'a4')).toBe(playerPawn);
      expect(pieceAt(container, 'a3')).toBeNull();
      expect(pieceAt(container, 'a5')).toHaveAttribute('aria-label', expect.stringContaining('Đen Chốt'));
      expect(pieceAt(container, 'a5')).toBe(botPawn);
      expect(pieceAt(container, 'a6')).toBeNull();
      expect(container.querySelector('.last-move-marker')).toHaveAttribute(
        'aria-label',
        'Nước đi gần nhất: a6 đến a5',
      );
      expect(screen.getByTestId('pve-turn')).toHaveTextContent('Đến lượt bạn');
    });

    it('trong lúc chờ server: báo "Đang gửi nước đi", không cho gửi nước thứ hai', async () => {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const original = server.fetch;
      fetch.mockImplementation(async (url, init) => {
        if (init && init.method === 'POST' && /\/moves$/.test(url)) await gate;
        return original(url, init);
      });
      const { svg } = await mountLoaded();

      clickAt(svg, 'a3');
      fireEvent.click(await screen.findByLabelText('Đi đến a4'));
      await screen.findByText('Đang gửi nước đi…');
      clickAt(svg, 'c3');
      clickAt(svg, 'c4');
      expect(fetch.mock.calls.filter(([url, init]) => init.method === 'POST' && /\/moves$/.test(url))).toHaveLength(1);

      await act(async () => { release(); await gate; });
      await screen.findByText('Máy đang suy nghĩ…');
    });

    it('server từ chối nước đi: hiện đúng thông báo của server, bàn cờ giữ nguyên, đi lại được', async () => {
      const { container, svg } = await mountLoaded();

      clickAt(svg, 'a3');
      server.failNextMove({ status: 400, code: 'ILLEGAL_MOVE', error: 'Nước đi không hợp lệ: Tốt chưa qua sông không đi ngang được' });
      fireEvent.click(await screen.findByLabelText('Đi đến a4'));

      const alert = await screen.findByTestId('pve-move-error');
      expect(alert).toHaveTextContent('Tốt chưa qua sông không đi ngang được');
      expect(pieceAt(container, 'a3')).not.toBeNull();
      expect(screen.getByTestId('pve-ply')).toHaveTextContent('0');

      clickAt(svg, 'a3');
      fireEvent.click(await screen.findByLabelText('Đi đến a4'));
      await screen.findByText('2', { selector: '[data-testid="pve-ply"]' }, { timeout: 3000 });
      expect(screen.queryByTestId('pve-move-error')).toBeNull();
    });

    it('lỗi mạng khi đi quân: báo lỗi, không mất ván', async () => {
      const { container, svg } = await mountLoaded();
      const original = server.fetch;
      fetch.mockImplementation(async (url, init) => {
        if (init && init.method === 'POST' && /\/moves$/.test(url)) throw new TypeError('Failed to fetch');
        return original(url, init);
      });
      clickAt(svg, 'a3');
      fireEvent.click(await screen.findByLabelText('Đi đến a4'));
      expect(await screen.findByTestId('pve-move-error')).toHaveTextContent('Không kết nối được máy chủ');
      expect(pieceAt(container, 'a3')).not.toBeNull();
    });
  });

  describe('xin thua', () => {
    it('có hộp xác nhận: Huỷ thì không gọi server; Xác nhận thì POST /resign và hiện kết quả Thất bại - Xin thua', async () => {
      await mountLoaded();

      fireEvent.click(screen.getByTestId('pve-resign-btn'));
      const confirm = screen.getByTestId('pve-resign-confirm');
      expect(confirm).toHaveTextContent('Xác nhận xin thua');
      fireEvent.click(within(confirm).getByRole('button', { name: 'Tiếp tục chơi' }));
      expect(screen.queryByTestId('pve-resign-confirm')).toBeNull();
      expect(fetch.mock.calls.some(([url]) => /resign/.test(url))).toBe(false);

      fireEvent.click(screen.getByTestId('pve-resign-btn'));
      fireEvent.click(screen.getByTestId('pve-confirm-resign'));

      const title = await screen.findByTestId('pve-result-title');
      expect(title).toHaveTextContent('Thất bại');
      expect(screen.getByTestId('pve-result-reason')).toHaveTextContent('Xin thua');
      const call = fetch.mock.calls.find(([url]) => /resign/.test(url));
      expect(call[1].method).toBe('POST');
      expect(screen.getByTestId('pve-turn')).toHaveTextContent('Ván đấu đã kết thúc');
    });
  });

  describe('kết quả do server quyết định', () => {
    const cases = [
      ['WIN', 'CHECKMATE', 'Chiến thắng', 'Chiếu bí'],
      ['LOSS', 'CHECKMATE', 'Thất bại', 'Chiếu bí'],
      ['WIN', 'NO_LEGAL_MOVES', 'Chiến thắng', 'Hết nước đi'],
      ['LOSS', 'TIMEOUT', 'Thất bại', 'Hết thời gian'],
      ['DRAW', 'DRAW_PLY_LIMIT', 'Hoà cờ', 'Hết giới hạn số nước đi'],
    ];

    it.each(cases)('%s / %s hiển thị "%s" kèm lý do "%s"', async (result, endReason, title, reason) => {
      server.finish(result, endReason);
      await mountLoaded();
      expect(await screen.findByTestId('pve-result-title')).toHaveTextContent(title);
      expect(screen.getByTestId('pve-result-reason')).toHaveTextContent(reason);
    });

    it('kết quả không xác định hiển thị trung tính, KHÔNG phải "Thất bại"', async () => {
      server.finish(null, null);
      await mountLoaded();
      const dialog = await screen.findByTestId('pve-result');
      expect(within(dialog).getByTestId('pve-result-title')).toHaveTextContent('Ván đấu đã kết thúc');
      expect(dialog).not.toHaveTextContent('Thất bại');
      expect(dialog).not.toHaveTextContent('Chiến thắng');
      expect(dialog.className).toMatch(/pve-result-unknown/);
      expect(screen.queryByTestId('pve-result-reason')).toBeNull();
    });

    it('có thể đóng bảng kết quả để xem bàn cờ rồi mở lại; luôn có đường về sảnh chờ; bàn cờ bị khoá', async () => {
      server.finish('WIN', 'CHECKMATE');
      const { container } = await mountLoaded();
      await screen.findByTestId('pve-result');
      for (const link of screen.getAllByRole('link', { name: /Về sảnh chờ/ })) expect(link).toHaveAttribute('href', '/');

      fireEvent.click(screen.getByRole('button', { name: 'Xem bàn cờ' }));
      expect(screen.queryByTestId('pve-result')).toBeNull();
      expect(container.querySelector('.board-readonly-tag')).not.toBeNull();
      expect(screen.queryByTestId('pve-resign-btn')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Xem kết quả' }));
      expect(screen.getByTestId('pve-result')).toBeInTheDocument();
    });
  });

  describe('đồng hồ và hết giờ do server xử', () => {
    it('đồng hồ đếm lùi theo remainingMs của server', async () => {
      vi.useFakeTimers();
      mount();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByTestId('pve-clock')).toHaveTextContent('01:00');
      await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
      expect(screen.getByTestId('pve-clock')).toHaveTextContent('00:58');
    });

    it('server xử thua do hết giờ: lần hỏi lại định kỳ phản ánh kết quả, bàn cờ khoá', async () => {
      vi.useFakeTimers();
      const { container } = mount();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.queryByTestId('pve-result')).toBeNull();

      // người chơi không đi; server tự xử thua khi bị hỏi sau 60s (không có thao tác nào của người dùng)
      await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });

      expect(server.state.status).toBe('FINISHED');
      expect(screen.getByTestId('pve-result-title')).toHaveTextContent('Thất bại');
      expect(screen.getByTestId('pve-result-reason')).toHaveTextContent('Hết thời gian');
      expect(container.querySelector('.board-readonly-tag')).not.toBeNull();
    });

    it('đồng hồ về 0 thì hỏi lại server ngay (không chờ chu kỳ 5s) rồi hiện kết quả', async () => {
      vi.useFakeTimers();
      server.state.turnStartedAt = Date.now() - 58_000; // server báo còn 2s
      mount();
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByTestId('pve-clock')).toHaveTextContent('00:02');
      expect(screen.queryByTestId('pve-result')).toBeNull();

      await act(async () => { await vi.advanceTimersByTimeAsync(2_600); }); // < 5s của chu kỳ hỏi lại
      expect(screen.getByTestId('pve-result-reason')).toHaveTextContent('Hết thời gian');
      expect(screen.getByTestId('pve-result-title')).toHaveTextContent('Thất bại');
    });

    it('nước đi gửi sau khi server đã xử hết giờ: hiện lỗi của server và đồng bộ lại thành kết quả cuối', async () => {
      const { svg } = await mountLoaded();
      clickAt(svg, 'a3');
      const destination = await screen.findByLabelText('Đi đến a4');
      server.state.turnStartedAt = Date.now() - 120_000; // quá hạn nhưng client chưa biết
      fireEvent.click(destination);
      expect(await screen.findByTestId('pve-result-reason')).toHaveTextContent('Hết thời gian');
      expect(screen.getByTestId('pve-move-error')).toHaveTextContent('Trận đấu đã kết thúc');
    });
  });

  describe('tải lại trang tiếp tục ván', () => {
    it('sau khi đi vài nước, mount lại (reload) hiện đúng thế cờ hiện tại từ server', async () => {
      const first = await mountLoaded();
      clickAt(first.svg, 'a3');
      fireEvent.click(await screen.findByLabelText('Đi đến a4'));
      await screen.findByText('2', { selector: '[data-testid="pve-ply"]' }, { timeout: 3000 });
      first.unmount();

      fetch.mockClear();
      const second = await mountLoaded();
      expect(fetch.mock.calls[0][1].method).toBe('GET');
      expect(pieceAt(second.container, 'a4')).not.toBeNull();
      expect(pieceAt(second.container, 'a5')).not.toBeNull();
      expect(screen.getByTestId('pve-ply')).toHaveTextContent('2');
      expect(screen.getByTestId('pve-turn')).toHaveTextContent('Đến lượt bạn');
    });

    it('Root đọc ?pveMatchId= từ URL và dựng màn hình chơi với máy', async () => {
      window.history.replaceState({}, '', '/?pveMatchId=1');
      render(<Root />);
      await act(async () => { await Promise.resolve(); });
      expect(await screen.findByTestId('pve-screen')).toBeInTheDocument();
      expect(fetch.mock.calls[0][0]).toMatch(/\/api\/pve\/matches\/1$/);
      expect(document.body.classList.contains('match-view')).toBe(true);
    });

    it('Root: pveMatchId sai định dạng không gọi mạng', async () => {
      window.history.replaceState({}, '', '/?pveMatchId=abc');
      render(<Root />);
      expect(fetch).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent('Mã ván đấu với máy không hợp lệ');
    });
  });
});
