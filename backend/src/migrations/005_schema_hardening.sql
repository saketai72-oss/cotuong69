-- ====================================================================
-- Migration: 005_schema_hardening.sql
-- BE-18: ràng buộc & chỉ mục còn thiếu
-- ====================================================================

-- 1. Quan hệ bạn bè phải đối xứng: (A,B) và (B,A) không được cùng tồn tại.
--    Dùng CASE thay LEAST/GREATEST để chạy được cả PostgreSQL và SQLite.
CREATE UNIQUE INDEX IF NOT EXISTS idx_friends_unique_pair
  ON friends (
    (CASE WHEN user_id < friend_id THEN user_id ELSE friend_id END),
    (CASE WHEN user_id < friend_id THEN friend_id ELSE user_id END)
  );

-- 2. Bỏ 2 index trùng với ràng buộc UNIQUE có sẵn (tốn chỗ, không dùng)
DROP INDEX IF EXISTS idx_users_username;
DROP INDEX IF EXISTS idx_users_email;

-- 3. Bảng lưu kết quả trận PvP (trước đây chỉ nằm trong room.history ở RAM)
CREATE TABLE IF NOT EXISTS pvp_matches (
  id SERIAL PRIMARY KEY,
  match_id VARCHAR(100),
  room_code VARCHAR(20) NOT NULL,
  winner_user_id INTEGER,
  loser_user_id INTEGER,
  winner_color VARCHAR(10),
  end_reason VARCHAR(40) NOT NULL,
  winner_elo_change INTEGER DEFAULT 0,
  loser_elo_change INTEGER DEFAULT 0,
  finished_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pvp_matches_winner ON pvp_matches (winner_user_id);
CREATE INDEX IF NOT EXISTS idx_pvp_matches_room ON pvp_matches (room_code);

-- 4. CHECK constraint cho dữ liệu trạng thái — pg-only: SQLite không hỗ trợ
--    ALTER TABLE ... ADD CONSTRAINT.
-- pg-only
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('ACTIVE', 'BANNED', 'INACTIVE'));
-- pg-only
ALTER TABLE friends ADD CONSTRAINT friends_status_check CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'BLOCKED'));
-- pg-only
ALTER TABLE users ADD CONSTRAINT users_elo_non_negative CHECK (elo_rating >= 0);
