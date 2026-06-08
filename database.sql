-- ════════════════════════════════════════════════════════════════
--  BETESEB BINGO — PostgreSQL Database Schema
--  Run this file once to set up all tables
--  Command: psql -U postgres -d beteseb_bingo -f database.sql
-- ════════════════════════════════════════════════════════════════

CREATE DATABASE beteseb_bingo;
\c beteseb_bingo;

-- ─── USERS ──────────────────────────────────────────────────────
CREATE TABLE users (
  id              SERIAL PRIMARY KEY,
  telegram_id     BIGINT UNIQUE NOT NULL,
  name            VARCHAR(50) NOT NULL,
  phone           VARCHAR(20),
  balance         NUMERIC(10,2) DEFAULT 500.00,
  total_games     INT DEFAULT 0,
  total_wins      INT DEFAULT 0,
  total_winnings  NUMERIC(10,2) DEFAULT 0,
  is_banned       BOOLEAN DEFAULT FALSE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  last_seen       TIMESTAMPTZ DEFAULT NOW()
);

-- ─── GAMES ──────────────────────────────────────────────────────
CREATE TABLE games (
  id            SERIAL PRIMARY KEY,
  room_id       UUID NOT NULL,
  stake_id      VARCHAR(10) NOT NULL,
  stake_amount  NUMERIC(10,2) NOT NULL,
  pot           NUMERIC(10,2) NOT NULL,
  status        VARCHAR(20) DEFAULT 'waiting',  -- waiting|playing|finished
  called_numbers INT[] DEFAULT '{}',
  winner_ids    INT[] DEFAULT '{}',
  win_amount    NUMERIC(10,2) DEFAULT 0,
  is_split      BOOLEAN DEFAULT FALSE,
  started_at    TIMESTAMPTZ,
  ended_at      TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── GAME PARTICIPANTS ───────────────────────────────────────────
CREATE TABLE game_participants (
  id            SERIAL PRIMARY KEY,
  game_id       INT REFERENCES games(id) ON DELETE CASCADE,
  user_id       INT REFERENCES users(id) ON DELETE CASCADE,
  card_id       INT NOT NULL,               -- 1–400 fixed card number
  is_winner     BOOLEAN DEFAULT FALSE,
  is_disqualified BOOLEAN DEFAULT FALSE,
  amount_won    NUMERIC(10,2) DEFAULT 0,
  joined_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(game_id, user_id)
);

-- ─── TRANSACTIONS ────────────────────────────────────────────────
CREATE TABLE transactions (
  id          SERIAL PRIMARY KEY,
  user_id     INT REFERENCES users(id) ON DELETE SET NULL,
  type        VARCHAR(20) NOT NULL,  -- deposit|stake|win|refund
  amount      NUMERIC(10,2) NOT NULL,
  balance_after NUMERIC(10,2) NOT NULL,
  reference   VARCHAR(100),         -- game_id or external ref
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── USEFUL INDEXES ──────────────────────────────────────────────
CREATE INDEX idx_users_telegram     ON users(telegram_id);
CREATE INDEX idx_games_room         ON games(room_id);
CREATE INDEX idx_games_status       ON games(status);
CREATE INDEX idx_participants_game  ON game_participants(game_id);
CREATE INDEX idx_participants_user  ON game_participants(user_id);
CREATE INDEX idx_transactions_user  ON transactions(user_id);

-- ─── LEADERBOARD VIEW ────────────────────────────────────────────
CREATE VIEW leaderboard AS
  SELECT
    u.id, u.name, u.telegram_id,
    u.total_wins,
    u.total_games,
    u.total_winnings,
    ROUND(u.total_wins::NUMERIC / NULLIF(u.total_games,0) * 100, 1) AS win_rate
  FROM users u
  ORDER BY u.total_winnings DESC;

-- ─── HELPER FUNCTIONS ────────────────────────────────────────────

-- Register or get user
CREATE OR REPLACE FUNCTION register_user(
  p_telegram_id BIGINT,
  p_name VARCHAR,
  p_phone VARCHAR
) RETURNS users AS $$
DECLARE v_user users;
BEGIN
  INSERT INTO users(telegram_id, name, phone)
  VALUES(p_telegram_id, p_name, p_phone)
  ON CONFLICT(telegram_id) DO UPDATE SET last_seen=NOW()
  RETURNING * INTO v_user;
  RETURN v_user;
END;
$$ LANGUAGE plpgsql;

-- Deduct stake from balance (atomic)
CREATE OR REPLACE FUNCTION deduct_stake(
  p_user_id INT,
  p_amount NUMERIC,
  p_game_id INT
) RETURNS NUMERIC AS $$
DECLARE v_new_balance NUMERIC;
BEGIN
  UPDATE users SET balance = balance - p_amount
  WHERE id = p_user_id AND balance >= p_amount
  RETURNING balance INTO v_new_balance;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient balance';
  END IF;

  INSERT INTO transactions(user_id, type, amount, balance_after, reference)
  VALUES(p_user_id, 'stake', -p_amount, v_new_balance, p_game_id::TEXT);

  RETURN v_new_balance;
END;
$$ LANGUAGE plpgsql;

-- Award winnings
CREATE OR REPLACE FUNCTION award_win(
  p_user_id INT,
  p_amount NUMERIC,
  p_game_id INT
) RETURNS NUMERIC AS $$
DECLARE v_new_balance NUMERIC;
BEGIN
  UPDATE users
  SET balance = balance + p_amount,
      total_wins = total_wins + 1,
      total_winnings = total_winnings + p_amount
  WHERE id = p_user_id
  RETURNING balance INTO v_new_balance;

  INSERT INTO transactions(user_id, type, amount, balance_after, reference)
  VALUES(p_user_id, 'win', p_amount, v_new_balance, p_game_id::TEXT);

  RETURN v_new_balance;
END;
$$ LANGUAGE plpgsql;
