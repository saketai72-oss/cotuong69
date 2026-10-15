# KIẾN TRÚC CLEAN ARCHITECTURE - BACKEND CỜ TƯỚNG ONLINE & MẠNG XÃ HỘI

Hệ thống Backend được thiết kế theo chuẩn **Clean Architecture**, tách biệt rõ ràng các mối quan tâm (Separation of Concerns), độc lập với framework, cơ sở dữ liệu và giao diện.

---

## 🏛️ Sơ Đồ Cấu Trúc Thư Mục

```text
backend/src/
├── core/                               # Tiện ích chung, mã lỗi hệ thống
│   └── errors/                         # AppError, ValidationError, NotFoundError...
│
├── domain/                             # TẦNG 1: DOMAIN (Nghiệp vụ cốt lõi, không phụ thuộc ngoài)
│   ├── entities/                       # Thực thể: User, Room, Match, Move, Friend, OTP, Role...
│   ├── value-objects/                  # Đối tượng giá trị: EloRating, RoomRole, MoveCoordinate...
│   └── repositories/                   # Interfaces: IUserRepository, IRoomRepository, IFriendRepository...
│
├── application/                        # TẦNG 2: APPLICATION (Use Cases & Điều phối nghiệp vụ)
│   ├── use-cases/
│   │   ├── auth/                       # Đăng ký (Bcrypt), Đăng nhập (JWT), OAuth2, Quên mật khẩu...
│   │   ├── user/                       # Hồ sơ cá nhân, Đổi tên hiển thị, Upload Avatar...
│   │   ├── friends/                    # Kết bạn, Bạn bè Online, Mời bạn bè (TTL 60s)...
│   │   ├── room/                       # Tạo phòng, Vào phòng qua Deep link, Phân vai trò Khán giả/Đối thủ...
│   │   └── game/                       # Đi quân cờ, Thẩm định nước đi, Chiếu/Bí, Tính điểm Elo...
│   └── ports/                          # Interfaces dịch vụ: ITokenService, IHasher, IEmailService, ISocketNotifier
│
├── infrastructure/                     # TẦNG 3: INFRASTRUCTURE (Hiện thực hóa & Thư viện bên ngoài)
│   ├── database/                       # Kết nối CSDL, Migration, Seed & Repository Implementations
│   │   └── repositories/               # PgUserRepository, PgRoomRepository, PgFriendRepository...
│   ├── security/                       # BcryptHasher, JwtTokenService
│   ├── realtime/                       # WebSocket Server (đồng bộ bàn cờ, thông báo realtime)
│   ├── mailer/                         # Dịch vụ gửi Email (OTP, Reset link)
│   └── oauth/                          # Tích hợp Google & Facebook OAuth2
│
└── presentation/                       # TẦNG 4: PRESENTATION (Giao tiếp bên ngoài / Adapters)
    ├── http/
    │   ├── controllers/                # AuthController, UserController, RoomController, FriendController...
    │   ├── routes/                     # auth.routes.js, user.routes.js, room.routes.js...
    │   └── middlewares/                # auth.middleware.js, validate.middleware.js, error.middleware.js
    └── websocket/
        ├── handlers/                   # game.handler.js, room.handler.js, chat.handler.js
        └── middlewares/                # socketAuth.middleware.js
```

---

## 🔄 Luồng Hoạt Động Của Một Request (Ví dụ: Đăng Ký Tài Khoản COT-571)
1. **Client** gửi `POST /api/auth/register` (Username, Email, Password).
2. **Presentation (`auth.routes.js` ➔ `AuthController`)**: Tiếp nhận request, gọi middleware kiểm tra định dạng đầu vào.
3. **Application (`RegisterUseCase`)**: 
   - Kiểm tra trùng lặp email/username qua `IUserRepository`.
   - Băm mật khẩu qua `IHasher` (Bcrypt).
   - Khởi tạo Entity `User` với `EloRating = 1000`.
   - Lưu vào CSDL qua `IUserRepository.create()`.
4. **Infrastructure (`PgUserRepository`)**: Thực thi câu lệnh SQL INSERT vào PostgreSQL.
5. **Presentation (`AuthController`)**: Trả mã HTTP `201 Created` về cho Client.

---

## Match API phát triển cho COT-615

Chạy `npm start` để khởi động HTTP server tại cổng 5000 (có thể đổi bằng biến môi trường `PORT`). `GET /api/matches/COT-615` trả DTO Match chỉ đọc gồm 32 quân, người chơi, bên đi trước, trạng thái countdown và đồng hồ do server tính. Đồng hồ mẫu bắt đầu ở 2 phút mỗi bên. Các yêu cầu cập nhật trận bị từ chối để client khán giả không thể điều khiển quân.

Đây là Match mẫu trong bộ nhớ, được khởi tạo khi có lượt đọc đầu tiên sau khi server khởi động; countdown bắt đầu từ lúc đó và Match được khởi tạo lại khi server restart. Nó chưa được gắn vào room lifecycle, tài khoản/xác thực, lưu trữ DB hay Socket.IO. Không dùng endpoint/match mẫu này như backend game production.
