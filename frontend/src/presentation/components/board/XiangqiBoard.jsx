import './XiangqiBoard.css';

const BOARD = {
  left: 54,
  right: 846,
  top: 48,
  bottom: 952
};

const FILES = 'abcdefghi';
const PIECE_LABELS = {
  general: 'Tướng',
  advisor: 'Sĩ',
  elephant: 'Tượng',
  horse: 'Mã',
  chariot: 'Xe',
  cannon: 'Pháo',
  soldier: 'Chốt'
};

function point(fileIndex, rank) {
  return {
    x: BOARD.left + (BOARD.right - BOARD.left) * (fileIndex / 8),
    y: BOARD.bottom - (BOARD.bottom - BOARD.top) * (rank / 9)
  };
}

function BoardGrid() {
  const horizontalLines = Array.from({ length: 10 }, (_, rank) => {
    const { y } = point(0, rank);
    return <line key={`rank-${rank}`} x1={BOARD.left} y1={y} x2={BOARD.right} y2={y} />;
  });

  const verticalLines = Array.from({ length: 9 }, (_, fileIndex) => {
    const { x } = point(fileIndex, 0);
    const segments = fileIndex === 0 || fileIndex === 8
      ? [[BOARD.top, BOARD.bottom]]
      : [[BOARD.top, point(fileIndex, 5).y], [point(fileIndex, 4).y, BOARD.bottom]];

    return segments.map(([y1, y2], segmentIndex) => (
      <line key={`file-${fileIndex}-${segmentIndex}`} x1={x} y1={y1} x2={x} y2={y2} />
    ));
  });

  const topLeft = point(3, 9);
  const topRight = point(5, 9);
  const topCenter = point(4, 7);
  const bottomLeft = point(3, 0);
  const bottomRight = point(5, 0);
  const bottomCenter = point(4, 2);

  return (
    <g className="board-lines">
      {horizontalLines}
      {verticalLines}
      <line x1={topLeft.x} y1={topLeft.y} x2={topCenter.x} y2={topCenter.y} />
      <line x1={topRight.x} y1={topRight.y} x2={topCenter.x} y2={topCenter.y} />
      <line x1={bottomLeft.x} y1={bottomLeft.y} x2={bottomCenter.x} y2={bottomCenter.y} />
      <line x1={bottomRight.x} y1={bottomRight.y} x2={bottomCenter.x} y2={bottomCenter.y} />
    </g>
  );
}

function BoardDetails() {
  const markedPoints = [
    [1, 2], [7, 2], [1, 7], [7, 7],
    [2, 3], [4, 3], [6, 3], [2, 6], [4, 6], [6, 6]
  ];

  return (
    <g className="board-details" aria-hidden="true">
      {markedPoints.map(([fileIndex, rank]) => {
        const { x, y } = point(fileIndex, rank);
        const inset = 5;
        const arm = 10;
        const leftMark = fileIndex > 0;
        const rightMark = fileIndex < 8;

        return (
          <g key={`mark-${fileIndex}-${rank}`}>
            {leftMark && (
              <>
                <path d={`M ${x - inset} ${y - inset} h -${arm} v ${arm}`} />
                <path d={`M ${x - inset} ${y + inset} h -${arm} v -${arm}`} />
              </>
            )}
            {rightMark && (
              <>
                <path d={`M ${x + inset} ${y - inset} h ${arm} v ${arm}`} />
                <path d={`M ${x + inset} ${y + inset} h ${arm} v -${arm}`} />
              </>
            )}
          </g>
        );
      })}
      <g className="board-corner-ornaments">
        <path d="M 37 45 v -10 h 10 M 863 45 v -10 h -10 M 37 955 v 10 h 10 M 863 955 v 10 h -10" />
        <circle cx="37" cy="35" r="2.5" />
        <circle cx="863" cy="35" r="2.5" />
        <circle cx="37" cy="965" r="2.5" />
        <circle cx="863" cy="965" r="2.5" />
      </g>
    </g>
  );
}

function Piece({ piece }) {
  if (!piece || typeof piece.position !== 'string' || !/^[a-i][0-9]$/i.test(piece.position)) {
    return null;
  }

  const fileIndex = FILES.indexOf(piece.position[0].toLowerCase());
  const rank = Number(piece.position.slice(1));
  const { x, y } = point(fileIndex, rank);
  const label = PIECE_LABELS[piece.type];

  if (fileIndex < 0 || rank < 0 || rank > 9 || !label) {
    return null;
  }

  return (
    <g
      className={`xiangqi-piece ${piece.color}`}
      transform={`translate(${x} ${y})`}
      aria-label={`${piece.color === 'red' ? 'Đỏ' : 'Đen'} ${label} tại ${piece.position}`}
    >
      <circle className="piece-shadow" cx="1.5" cy="4" r="35" />
      <circle className="piece-edge" r="33" />
      <circle className="piece-bevel" r="30.5" />
      <circle className="piece-face" cy="-1" r="29" />
      <circle className="piece-inner-ring" cy="-1" r="23.5" />
      <path className="piece-glint" d="M -17 -20 A 27 27 0 0 1 17 -20" />
      <text
        className={`piece-label piece-label-${piece.type}`}
        textAnchor="middle"
        dominantBaseline="central"
        textLength={label.length > 3 ? 43 : undefined}
        lengthAdjust="spacingAndGlyphs"
      >
        {label}
      </text>
    </g>
  );
}

export default function XiangqiBoard({ pieces, countdown = null, readOnly = true }) {
  return (
    <div className="xiangqi-board-frame">
      <div className="board-coordinate coordinate-top">
        {FILES.split('').map((file) => <span key={file}>{file}</span>)}
      </div>
      <svg
        className="xiangqi-board"
        viewBox="0 0 900 1000"
        role="img"
        aria-label={`Bàn cờ Tướng 9 cột 10 hàng với ${pieces.length} quân${readOnly ? ', chế độ chỉ xem' : ''}`}
      >
        <defs>
          <linearGradient id="board-wood" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#85572f" />
            <stop offset="28%" stopColor="#c18b4c" />
            <stop offset="54%" stopColor="#9a6634" />
            <stop offset="78%" stopColor="#d0a064" />
            <stop offset="100%" stopColor="#774b29" />
          </linearGradient>
          <linearGradient id="board-paper" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#f6e9cc" />
            <stop offset="48%" stopColor="#efddb8" />
            <stop offset="100%" stopColor="#ead3a8" />
          </linearGradient>
          <linearGradient id="piece-ivory" x1="0" y1="0" x2="0.8" y2="1">
            <stop offset="0%" stopColor="#fff8e8" />
            <stop offset="48%" stopColor="#f2e4c9" />
            <stop offset="100%" stopColor="#ddc9a5" />
          </linearGradient>
          <linearGradient id="piece-red-ink" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#c84d3f" />
            <stop offset="100%" stopColor="#8f2e27" />
          </linearGradient>
          <linearGradient id="piece-black-ink" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#51534d" />
            <stop offset="100%" stopColor="#282b28" />
          </linearGradient>
          <filter id="board-grain">
            <feTurbulence type="fractalNoise" baseFrequency=".7" numOctaves="2" seed="7" />
            <feColorMatrix type="saturate" values="0" />
            <feComponentTransfer>
              <feFuncA type="table" tableValues="0 .08" />
            </feComponentTransfer>
            <feBlend in="SourceGraphic" mode="multiply" />
          </filter>
        </defs>
        <rect className="board-wood-mat" x="8" y="4" width="884" height="992" rx="17" fill="url(#board-wood)" />
        <rect className="board-wood-inset" x="19" y="15" width="862" height="970" rx="12" />
        <rect className="board-paper" x="22" y="17" width="856" height="966" rx="9" fill="url(#board-paper)" />
        <rect className="board-border" x="29" y="24" width="842" height="952" rx="5" />
        <g filter="url(#board-grain)">
          <BoardGrid />
        </g>
        <BoardDetails />
        <g className="river-label" aria-hidden="true">
          <text x="290" y="511" textAnchor="middle">SỞ HÀ</text>
          <text x="610" y="511" textAnchor="middle">HÁN GIỚI</text>
        </g>
        <g className="board-coordinates" aria-hidden="true">
          {Array.from({ length: 10 }, (_, rank) => {
            const { y } = point(0, rank);
            return <text key={`rank-label-${rank}`} x="40" y={y + 4} textAnchor="middle">{rank}</text>;
          })}
        </g>
        <g className="pieces-layer">
          {pieces.map((piece) => <Piece key={piece.id} piece={piece} />)}
        </g>
      </svg>
      <div className="board-coordinate coordinate-bottom">
        {FILES.split('').map((file) => <span key={file}>{file}</span>)}
      </div>
      {readOnly && <div className="board-readonly-tag"><span>◉</span> CHẾ ĐỘ QUAN SÁT</div>}
      {countdown !== null && (
        <div className="countdown-overlay" role="status" aria-live="assertive">
          <span className="countdown-caption">TRẬN ĐẤU BẮT ĐẦU SAU</span>
          <strong key={countdown} className="countdown-number">{countdown}</strong>
          <span className="countdown-subtitle">Chuẩn bị sẵn sàng</span>
        </div>
      )}
    </div>
  );
}
