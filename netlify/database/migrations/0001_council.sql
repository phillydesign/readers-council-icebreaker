CREATE TABLE council_rooms (
  code text PRIMARY KEY,
  title text NOT NULL,
  questions jsonb NOT NULL CHECK (jsonb_array_length(questions) BETWEEN 1 AND 3),
  round integer NOT NULL DEFAULT 0 CHECK (round BETWEEN 0 AND 2),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','open','frozen','finished')),
  version integer NOT NULL DEFAULT 1,
  history jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '48 hours'
);
CREATE TABLE council_participants (
  room text NOT NULL REFERENCES council_rooms(code) ON DELETE CASCADE,
  token_hash text NOT NULL,
  public_id uuid NOT NULL,
  PRIMARY KEY (room, token_hash),
  UNIQUE (room, public_id)
);
CREATE TABLE council_votes (
  room text NOT NULL,
  round integer NOT NULL,
  participant uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 100),
  sequence bigint NOT NULL CHECK (sequence >= 0),
  PRIMARY KEY (room, round, participant),
  FOREIGN KEY (room, participant) REFERENCES council_participants(room, public_id) ON DELETE CASCADE
);
CREATE TABLE council_login_attempts (
  fingerprint text PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 1
);
