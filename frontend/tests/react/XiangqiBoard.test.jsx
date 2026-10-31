// CLEAN-04: test render + tương tác click-chọn-quân-rồi-đi của XiangqiBoard (jsdom).
import { act, fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import XiangqiBoard from '../../src/presentation/components/board/XiangqiBoard.jsx';

const FILES = 'abcdefghi';

// Thế khai cuộc đầy đủ 32 quân theo định dạng server gửi: { id, color, type, position }
function openingPieces() {
  const pieces = [];
  const back = ['chariot', 'horse', 'elephant', 'advisor', 'general', 'advisor', 'elephant', 'horse', 'chariot'];
  for (const [color, backRank, cannonRank, soldierRank] of [['red', 0, 2, 3], ['black', 9, 7, 6]]) {
    back.forEach((type, file) => {
      pieces.push({ id: `${color}-${type}-${FILES[file]}`, color, type, position: `${FILES[file]}${backRank}` });
    });
    for (const file of [1, 7]) {
      pieces.push({ id: `${color}-cannon-${FILES[file]}`, color, type: 'cannon', position: `${FILES[file]}${cannonRank}` });
    }
    for (const file of [0, 2, 4, 6, 8]) {
      pieces.push({ id: `${color}-soldier-${FILES[file]}`, color, type: 'soldier', position: `${FILES[file]}${soldierRank}` });
    }
  }
  return pieces;
}

// Toạ độ SVG (viewBox 900x1000) của giao điểm, đúng với cách bàn cờ vẽ
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

function renderBoard(props = {}) {
  const onMove = vi.fn();
  const onSelectPiece = vi.fn();
  const view = render(
    <XiangqiBoard
      pieces={openingPieces()}
      readOnly={false}
      interactive
      playerColor="red"
      legalMoves={{ from: 'a3', destinations: ['a4'] }}
      onMove={onMove}
      onSelectPiece={onSelectPiece}
      {...props}
    />,
  );
  const svg = view.container.querySelector('svg.xiangqi-board');
  stubSvgGeometry(svg);
  const clickAt = (position, orientation = props.orientation || 'red') => {
    const { x, y } = svgPointOf(position, orientation);
    fireEvent.click(svg, { clientX: x, clientY: y });
  };
  const pieceNode = (position) => view.container.querySelector(`[data-position="${position}"]`);
  return { ...view, svg, onMove, onSelectPiece, clickAt, pieceNode };
}

describe('XiangqiBoard: hiển thị', () => {
  it('vẽ đủ 32 quân của thế khai cuộc với nhãn truy cập được', () => {
    const { container, getByLabelText } = renderBoard();
    expect(container.querySelectorAll('[data-piece-id]')).toHaveLength(32);
    expect(getByLabelText('Đỏ Tướng tại e0')).toBeInTheDocument();
    expect(getByLabelText('Đen Tướng tại e9')).toBeInTheDocument();
    expect(getByLabelText('Đỏ Pháo tại b2')).toBeInTheDocument();
    expect(getByLabelText('Đen Chốt tại a6')).toBeInTheDocument();
  });

  it('đặt quân đúng vị trí: Đỏ ở phía dưới, Đen ở phía trên (góc nhìn Đỏ)', () => {
    const { pieceNode } = renderBoard();
    const red = svgPointOf('e0');
    const black = svgPointOf('e9');
    expect(pieceNode('e0').getAttribute('transform')).toBe(`translate(${red.x} ${red.y})`);
    expect(pieceNode('e9').getAttribute('transform')).toBe(`translate(${black.x} ${black.y})`);
    expect(red.y).toBeGreaterThan(black.y);
  });

  it('góc nhìn Đen lật bàn cờ và đảo thứ tự cột a..i', () => {
    const { pieceNode, container } = renderBoard({ orientation: 'black', playerColor: 'black' });
    const redGeneral = svgPointOf('e0', 'black');
    expect(pieceNode('e0').getAttribute('transform')).toBe(`translate(${redGeneral.x} ${redGeneral.y})`);
    const letters = [...container.querySelectorAll('.coordinate-top span')].map((n) => n.textContent);
    expect(letters).toEqual([...FILES].reverse());
  });

  it('vẽ hai đường chéo giao nhau thành chữ X trong cả hai cung Tướng', () => {
    const { container } = renderBoard();
    const diagonals = [...container.querySelectorAll('.board-lines line')].slice(-4);
    const expected = [
      ['d9', 'f7'],
      ['f9', 'd7'],
      ['d0', 'f2'],
      ['f0', 'd2'],
    ];

    expect(diagonals).toHaveLength(expected.length);
    diagonals.forEach((line, index) => {
      const [from, to] = expected[index];
      const start = svgPointOf(from);
      const end = svgPointOf(to);
      expect(line.getAttribute('x1')).toBe(String(start.x));
      expect(line.getAttribute('y1')).toBe(String(start.y));
      expect(line.getAttribute('x2')).toBe(String(end.x));
      expect(line.getAttribute('y2')).toBe(String(end.y));
    });
  });

  it('vẽ dấu giao điểm bốn góc rõ ràng tại đủ vị trí tốt và pháo', () => {
    const { container } = renderBoard();
    const marks = [...container.querySelectorAll('.board-position-mark')];
    const markAt = (position) => container.querySelector(`[data-mark-position="${position}"]`);

    expect(marks).toHaveLength(14);
    expect(markAt('b2').querySelectorAll('path')).toHaveLength(4);
    expect(markAt('c3').querySelectorAll('path')).toHaveLength(4);
    expect(markAt('a3').querySelectorAll('path')).toHaveLength(2);
    expect(markAt('i6').querySelectorAll('path')).toHaveLength(2);
    const cannonPoint = svgPointOf('b2');
    expect(markAt('b2').querySelector('path')).toHaveAttribute(
      'd',
      expect.stringContaining(
        `M ${cannonPoint.x - 24} ${cannonPoint.y - 24} h 18 M ${cannonPoint.x - 24} ${cannonPoint.y - 24} v 18`,
      ),
    );
  });

  it('bỏ qua quân có vị trí hoặc loại quân không hợp lệ thay vì vỡ giao diện', () => {
    const pieces = [
      { id: 'ok', color: 'red', type: 'general', position: 'e0' },
      { id: 'bad-pos', color: 'red', type: 'soldier', position: 'z9' },
      { id: 'no-pos', color: 'red', type: 'soldier', position: undefined },
      { id: 'bad-type', color: 'black', type: 'dragon', position: 'a5' },
    ];
    const { container } = renderBoard({ pieces });
    expect([...container.querySelectorAll('[data-piece-id]')].map((n) => n.dataset.pieceId)).toEqual(['ok']);
  });

  it('chế độ chỉ xem hiện nhãn quan sát, người chơi thì không', () => {
    const watching = renderBoard({ readOnly: true, interactive: false });
    expect(watching.getByText(/CHẾ ĐỘ QUAN SÁT/)).toBeInTheDocument();
    watching.unmount();
    const playing = renderBoard({ readOnly: false });
    expect(playing.queryByText(/CHẾ ĐỘ QUAN SÁT/)).not.toBeInTheDocument();
  });

  it('đếm ngược bắt đầu trận hiện số giây còn lại', () => {
    const { getByRole } = renderBoard({ countdown: 3 });
    expect(getByRole('status')).toHaveTextContent('3');
  });

  it('đánh dấu nước đi mới nhất ở cả ô xuất phát và ô đến', () => {
    const { container } = renderBoard({
      lastMove: { color: 'black', from: 'a6', to: 'a5' },
    });
    const marker = container.querySelector('.last-move-marker');
    const origin = svgPointOf('a6');
    const destination = svgPointOf('a5');

    expect(marker).toHaveClass('last-move-black');
    expect(marker.querySelector('.last-move-origin')).toHaveAttribute(
      'd',
      expect.stringContaining(`M ${origin.x - 13} ${origin.y - 31}`),
    );
    expect(marker.querySelector('.last-move-destination')).toHaveAttribute(
      'd',
      expect.stringContaining(`M ${destination.x - 16} ${destination.y - 36}`),
    );
  });

  it('giữ đúng quân qua lần đổi vị trí để quân lướt tới ô mới thay vì bị vẽ lại', () => {
    const sourcePiece = { id: 'red-soldier-a3', color: 'red', type: 'soldier', position: 'a3' };
    const props = {
      pieces: [sourcePiece],
      readOnly: false,
      interactive: false,
      playerColor: 'red',
      animateMoves: true,
    };
    const { container, rerender } = render(<XiangqiBoard {...props} />);
    const originalNode = container.querySelector('[data-position="a3"]');

    rerender(
      <XiangqiBoard
        {...props}
        pieces={[{ ...sourcePiece, id: 'red-soldier-a4', position: 'a4' }]}
        lastMove={{ color: 'red', from: 'a3', to: 'a4' }}
      />,
    );

    expect(container.querySelector('[data-position="a4"]')).toBe(originalNode);
  });

  it('highlight Tướng bị chiếu quanh đúng quân Tướng của bên bị chiếu', () => {
    const { container } = renderBoard({ checkedColor: 'black' });
    const circle = container.querySelector('.check-highlight-layer circle');
    const general = svgPointOf('e9');
    expect(circle.getAttribute('cx')).toBe(String(general.x));
    expect(circle.getAttribute('cy')).toBe(String(general.y));
    // không bị chiếu thì không có highlight
    const calm = renderBoard();
    expect(calm.container.querySelector('.check-highlight-layer')).toBeNull();
  });
});

describe('XiangqiBoard: đi quân bằng click', () => {
  it('chọn quân yêu cầu nước hợp lệ, hiện dấu gợi ý rồi bấm điểm đến để đi', () => {
    const { clickAt, onMove, onSelectPiece, pieceNode, container } = renderBoard();
    clickAt('a3');
    expect(pieceNode('a3')).toHaveClass('is-selected');
    expect(onSelectPiece).toHaveBeenCalledWith('a3');
    expect(container.querySelector('.selection-energy-ring-outer')).toBeInTheDocument();
    expect(container.querySelector('.selection-energy-ring-inner')).toBeInTheDocument();
    expect(container.querySelector('.selection-energy-glow')).toBeNull();
    expect(container.querySelector('[data-destination="a4"]')).toBeInTheDocument();
    expect(container.querySelectorAll('.legal-move-marker')).toHaveLength(1);
    expect(container.querySelector('.legal-move-energy-layer')).toBeNull();
    expect(onMove).not.toHaveBeenCalled();

    fireEvent.click(container.querySelector('[data-destination="a4"]'));
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith('a3', 'a4');
    expect(pieceNode('a3')).not.toHaveClass('is-selected');
  });

  it('nút ô đích nhận cả thao tác bàn phím', () => {
    const { clickAt, container, onMove } = renderBoard();
    clickAt('a3');
    const destination = container.querySelector('[data-destination="a4"]');

    expect(destination).toHaveAttribute('role', 'button');
    fireEvent.keyDown(destination, { key: 'Enter' });
    expect(onMove).toHaveBeenCalledWith('a3', 'a4');
  });

  it('bấm lại đúng quân đang chọn thì bỏ chọn, bấm quân mình khác thì đổi chọn', () => {
    const { clickAt, pieceNode, onMove } = renderBoard();
    clickAt('a3');
    clickAt('a3');
    expect(pieceNode('a3')).not.toHaveClass('is-selected');

    clickAt('a3');
    clickAt('c3');
    expect(pieceNode('a3')).not.toHaveClass('is-selected');
    expect(pieceNode('c3')).toHaveClass('is-selected');
    expect(onMove).not.toHaveBeenCalled();
  });

  it('chọn quân rồi bấm vào quân đối phương = đi ăn quân (onMove tới ô của quân đó)', () => {
    const { clickAt, onMove } = renderBoard({
      legalMoves: { from: 'b2', destinations: ['b9'] },
    });
    clickAt('b2'); // Pháo đỏ
    clickAt('b9'); // Mã đen
    expect(onMove).toHaveBeenCalledWith('b2', 'b9');
  });

  it('không cho đi đến ô không nằm trong danh sách nước hợp lệ từ máy chủ', () => {
    const { clickAt, onMove, pieceNode } = renderBoard();
    clickAt('a3');
    clickAt('a2');
    expect(onMove).not.toHaveBeenCalled();
    expect(pieceNode('a3')).toHaveClass('is-selected');
  });

  it('kéo thả không còn thực hiện nước đi', () => {
    const { svg, onMove } = renderBoard();
    fireEvent.pointerDown(svg, { pointerId: 1, clientX: 54, clientY: 650 });
    fireEvent.pointerUp(svg, { pointerId: 1, clientX: 54, clientY: 550 });
    expect(onMove).not.toHaveBeenCalled();
  });

  it('không chọn được quân của đối phương', () => {
    const { clickAt, pieceNode, onMove } = renderBoard();
    clickAt('a6');
    expect(pieceNode('a6')).not.toHaveClass('is-selected');
    clickAt('a5');
    expect(onMove).not.toHaveBeenCalled();
  });

  it('bấm ô trống khi chưa chọn quân thì không làm gì', () => {
    const { clickAt, onMove } = renderBoard();
    clickAt('e5');
    expect(onMove).not.toHaveBeenCalled();
  });

  it('không tương tác khi board không interactive (khán giả / chưa tới lượt)', () => {
    const { clickAt, pieceNode, onMove } = renderBoard({ interactive: false });
    clickAt('a3');
    clickAt('a4');
    expect(pieceNode('a3')).not.toHaveClass('is-selected');
    expect(onMove).not.toHaveBeenCalled();
  });

  it('ẩn vòng chọn và điểm đến ngay khi lượt đi bị khóa', () => {
    const { clickAt, container, rerender } = renderBoard();
    clickAt('a3');
    expect(container.querySelector('.selection-energy-layer')).toBeInTheDocument();

    rerender(
      <XiangqiBoard
        pieces={openingPieces()}
        readOnly={false}
        interactive={false}
        playerColor="red"
        legalMoves={{ from: 'a3', destinations: ['a4'] }}
      />,
    );
    expect(container.querySelector('.selection-energy-layer')).toBeNull();
    expect(container.querySelector('.legal-move-layer')).toBeNull();
  });

  it('khoá thao tác khi đang chờ server xác nhận nước đi trước (movePending)', () => {
    const { clickAt, onMove } = renderBoard({ movePending: true });
    clickAt('a3');
    clickAt('a4');
    expect(onMove).not.toHaveBeenCalled();
  });

  it('góc nhìn Đen: ánh xạ toạ độ chuột về đúng ô khi lật bàn cờ', () => {
    const { clickAt, onMove } = renderBoard({
      orientation: 'black',
      playerColor: 'black',
      legalMoves: { from: 'a6', destinations: ['a5'] },
    });
    clickAt('a6');
    clickAt('a5');
    expect(onMove).toHaveBeenCalledWith('a6', 'a5');
  });

  it('bấm ngoài lưới (xa mọi giao điểm) bị bỏ qua', () => {
    const { svg, onMove } = renderBoard();
    fireEvent.click(svg, { clientX: 1, clientY: 1 });
    expect(onMove).not.toHaveBeenCalled();
  });

  it('thế cờ thay đổi (server xác nhận nước đi) thì bỏ chọn quân cũ', () => {
    const initial = openingPieces();
    const { clickAt, pieceNode, rerender, onMove, container } = renderBoard({ pieces: initial });
    clickAt('a3');
    expect(pieceNode('a3')).toHaveClass('is-selected');

    const moved = initial.map((piece) => (piece.id === 'red-soldier-a' ? { ...piece, position: 'a4' } : piece));
    rerender(<XiangqiBoard pieces={moved} readOnly={false} interactive playerColor="red" onMove={onMove} />);
    expect(container.querySelector('.is-selected')).toBeNull();
    expect(container.querySelector('[data-position="a4"]')).toBeInTheDocument();
  });

  it('làm quân cờ trượt qua vị trí trung gian trước khi đến đích', () => {
    const frames = [];
    let nextFrameId = 0;
    vi.stubGlobal('requestAnimationFrame', (callback) => {
      frames.push(callback);
      nextFrameId += 1;
      return nextFrameId;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const initial = openingPieces();
    const { pieceNode, rerender } = renderBoard({ pieces: initial });
    const start = pieceNode('a3').getAttribute('transform');
    const moved = initial.map((piece) => (
      piece.id === 'red-soldier-a' ? { ...piece, position: 'a4' } : piece
    ));

    rerender(<XiangqiBoard pieces={moved} readOnly={false} interactive playerColor="red" />);
    expect(pieceNode('a4')).toHaveAttribute('transform', start);

    act(() => frames.shift()(1000));
    act(() => frames.shift()(1260));
    const intermediate = pieceNode('a4').getAttribute('transform');
    expect(intermediate).not.toBe(start);
    expect(intermediate).not.toBe(`translate(${svgPointOf('a4').x} ${svgPointOf('a4').y})`);

    act(() => frames.shift()(1520));
    expect(pieceNode('a4')).toHaveAttribute(
      'transform',
      `translate(${svgPointOf('a4').x} ${svgPointOf('a4').y})`,
    );
  });
});
