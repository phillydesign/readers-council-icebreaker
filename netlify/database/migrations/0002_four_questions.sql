ALTER TABLE council_rooms
  DROP CONSTRAINT council_rooms_questions_check,
  ADD CONSTRAINT council_rooms_questions_check CHECK (jsonb_array_length(questions) BETWEEN 1 AND 4),
  DROP CONSTRAINT council_rooms_round_check,
  ADD CONSTRAINT council_rooms_round_check CHECK (round BETWEEN 0 AND 3);
