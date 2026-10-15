# KIẾN TRÚC CLEAN ARCHITECTURE - FRONTEND (REACT + VITE)

Dự án Frontend được xây dựng bằng **React (SPA)** theo chuẩn **Clean Architecture**, phân tách độc lập giữa giao diện người dùng (UI), logic nghiệp vụ (Use Cases), mô hình miền (Domain Entities) và các dịch vụ bên ngoài (API, WebSocket, WebRTC).

---

## 🏛️ Sơ Đồ Cấu Trúc Thư Mục Frontend

```text
frontend/src/
├── core/                               # Cấu hình chung, constants, helpers
│   ├── config/                         # env config, API base URL, WebSocket URL
│   ├── constants/                      # BoardCoordinates, PieceTypes, SocketEvents, SoundKeys
│   └── utils/                          # FormatElo, DateTime, SoundPlayer
│
├── domain/                             # [TẦNG 1] DOMAIN: Nghiệp vụ cốt lõi & Luật cờ
│   ├── entities/                       # User, Room, Match, Move, Piece, Board, Friend, Message
│   ├── value-objects/                  # GameStatus, PlayerColor, Coordinate, Timer, RoomRole
│   └── repositories/                   # Giao diện: IAuthRepository, IRoomRepository, IGameGateway, IFriendRepository
│
├── application/                        # [TẦNG 2] APPLICATION: Use Cases & Custom Hooks kết nối UI
│   ├── use-cases/
│   │   ├── auth/                       # LoginUseCase, RegisterUseCase, ResetPasswordUseCase
│   │   ├── room/                       # CreateRoomUseCase, JoinRoomByLinkUseCase, LeaveRoomUseCase
│   │   ├── game/                       # MakeMoveUseCase, CalculateLegalMovesUseCase, SurrenderUseCase
│   │   └── friends/                    # InviteFriendUseCase, AcceptInviteUseCase
│   └── hooks/                          # useAuth, useGame, useLobby, useFriends, useSocket, useWebRTC
│
├── infrastructure/                     # [TẦNG 3] INFRASTRUCTURE: Hiện thực hóa kỹ thuật & Driver ngoài
│   ├── api/                            # Gọi REST API (Fetch/Axios): AuthApi, UserApi, RoomApi, FriendApi
│   ├── realtime/                       # SocketClient (WebSocket/Socket.io), WebRtcClient (Video Call)
│   ├── storage/                        # LocalStorageService (Token, Session)
│   └── sound/                          # Trình phát âm thanh nước cờ, ăn quân, chiếu tướng
│
└── presentation/                       # [TẦNG 4] PRESENTATION: Giao diện React
    ├── components/                     # UI Components chia theo tính năng
    │   ├── common/                     # Button, Input, Modal, Toast, Avatar, Badge, Spinner
    │   ├── board/                      # ChessBoard, PieceView, BoardCoordinates, MoveHistory
    │   ├── room/                       # RoomCard, PlayerSlot, SpectatorList, InviteModal
    │   ├── lobby/                      # RoomList, UserProfileBar, GameModeSelector
    │   └── chat/                       # ChatBox, MessageItem, EmojiPicker
    ├── layouts/                        # MainLayout, GameLayout, AuthLayout
    ├── pages/                          # LoginPage, RegisterPage, ForgotPasswordPage, LobbyPage, RoomPage, GamePage, ProfilePage
    ├── contexts/                       # AuthContext, SocketContext, NotificationContext
    └── routes/                         # AppRoutes, ProtectedRoute (chặn truy cập khi chưa đăng nhập)
```

---

## 💡 Ưu Điểm Khi Áp Dụng Clean Architecture Cho Frontend
1. **Dễ Kiểm Thử (Testability)**: Thuật toán kiểm tra nước đi hợp lệ của Tướng/Mã/Pháo (Domain) có thể test độc lập 100% bằng Jest/Node mà không cần render UI React.
2. **Độc Lập UI Framework**: Nếu sau này đổi thư viện UI (từ CSS thuần sang Tailwind hoặc chuyển sang React Native), toàn bộ logic Use Cases và Domain được giữ nguyên 100%.
3. **Phân Công Song Song (Nhóm 7 người)**:
   - Thành viên làm giao diện (FE UI) tập trung ở `presentation/components` và `presentation/pages`.
   - Thành viên làm luật cờ/realtime tập trung ở `domain/entities` và `application/use-cases/game`.

---

## Match view cho bàn cờ COT-615

`presentation/components/board/XiangqiBoard` nhận `pieces` dưới dạng mảng quân `{ id, color, type, position }`, trong đó `color` là `red` hoặc `black`, `type` là `general`, `advisor`, `elephant`, `horse`, `chariot`, `cannon` hoặc `soldier`, và `position` là tọa độ như `e0`. Bàn cờ chỉ hiển thị trạng thái, không gắn thao tác kéo/thả hay đi quân.

Màn hình tải dữ liệu qua `application/hooks/useMatch` và `infrastructure/api/matchApi` từ `GET /api/matches/:matchId` (mặc định `COT-615`, có thể chọn bằng query `?matchId=...`). Dữ liệu được làm mới mỗi giây; countdown và đồng hồ là giá trị do server tính từ thời điểm phân bên/bắt đầu. Frontend không cung cấp thao tác cập nhật trận; endpoint hiện tại chỉ đọc để hỗ trợ chế độ khán giả.

Backend hiện cung cấp Match mẫu trong bộ nhớ cho `COT-615`; trạng thái được khởi tạo lại khi tiến trình backend khởi động và chưa nối vào luồng phòng, xác thực người chơi, cơ sở dữ liệu trận đấu hoặc WebSocket. Đây là adapter end-to-end để phát triển/giao diện COT-615, chưa phải hệ thống trận đấu production. Khi room/game backend thực tế sẵn sàng, thay nguồn khởi tạo Match ở backend để trả cùng DTO, rồi giữ nguyên giao diện đọc Match.
