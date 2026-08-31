-- DocSorter: схема базы.
-- Выполняется один раз при первом старте контейнера postgres.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS vector;

-- ─────────────────────────────── пользователи и сессии ───────────────────────

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login         text UNIQUE NOT NULL,
  password_hash text NOT NULL,            -- argon2id(пароль)
  kdf_salt      bytea NOT NULL,           -- соль для KEK = argon2id(пароль, kdf_salt)
  wrapped_dek   bytea NOT NULL,           -- DEK, завёрнутый в KEK: iv(12) || tag(16) || ct(32)
  totp_secret   text,                     -- base32; NULL = второй фактор выключен
  failed_count  int  NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id         text PRIMARY KEY,            -- 32 случайных байта в hex
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent text,
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_exp  ON sessions(expires_at);

-- ─────────────────────────────── документы ───────────────────────────────────

CREATE TABLE documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'pending',   -- pending|processing|ready|failed
  sha256        text NOT NULL,
  original_name text NOT NULL,
  mime          text NOT NULL,
  size_bytes    bigint NOT NULL,
  blob_key      text NOT NULL,                     -- ключ зашифрованного оригинала
  thumb_key     text,                              -- ключ зашифрованной превьюшки
  page_count    int,

  -- то, что вытащил Claude
  title         text,
  category      text,
  sender        text,
  summary       text,
  doc_date      date,
  due_date      date,
  amount        numeric(14,2),
  currency      text,
  language      text,
  action_needed text,
  tags          text[] NOT NULL DEFAULT '{}',
  full_text     text,
  ai_raw        jsonb,
  embedding     vector(1024),                      -- заполняется, только если включены эмбеддинги

  favorite      boolean NOT NULL DEFAULT false,
  archived      boolean NOT NULL DEFAULT false,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz
);

CREATE UNIQUE INDEX documents_user_sha ON documents(user_id, sha256);
CREATE INDEX documents_status   ON documents(status);
CREATE INDEX documents_category ON documents(user_id, category);
CREATE INDEX documents_sender   ON documents(user_id, sender);
CREATE INDEX documents_docdate  ON documents(user_id, doc_date DESC NULLS LAST);
CREATE INDEX documents_tags     ON documents USING gin (tags);
CREATE INDEX documents_title_tg ON documents USING gin (title gin_trgm_ops);

-- Полнотекстовый вектор. 'simple' ловит номера, IBAN и имена как есть;
-- языковые конфиги добавляют морфологию для немецкого/русского/английского.
-- Считается триггером, а не GENERATED-колонкой: array_to_string помечен как
-- STABLE, и Postgres не пускает его в генерируемое выражение.
ALTER TABLE documents ADD COLUMN tsv tsvector;

CREATE OR REPLACE FUNCTION documents_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.tsv :=
    setweight(to_tsvector('simple',  coalesce(NEW.title, '')),                   'A') ||
    setweight(to_tsvector('simple',  coalesce(NEW.sender, '')),                  'A') ||
    setweight(to_tsvector('simple',  array_to_string(NEW.tags, ' ')),            'A') ||
    setweight(to_tsvector('simple',  coalesce(NEW.category, '')),                'B') ||
    setweight(to_tsvector('simple',  coalesce(NEW.summary, '')),                 'B') ||
    setweight(to_tsvector('russian', coalesce(NEW.summary, '')),                 'B') ||
    setweight(to_tsvector('simple',  coalesce(NEW.original_name, '')),           'C') ||
    setweight(to_tsvector('simple',  left(coalesce(NEW.full_text, ''), 900000)), 'C') ||
    setweight(to_tsvector('german',  left(coalesce(NEW.full_text, ''), 900000)), 'D') ||
    setweight(to_tsvector('russian', left(coalesce(NEW.full_text, ''), 900000)), 'D') ||
    setweight(to_tsvector('english', left(coalesce(NEW.full_text, ''), 900000)), 'D');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER documents_tsv_trigger
  BEFORE INSERT OR UPDATE OF title, sender, tags, category, summary, original_name, full_text
  ON documents FOR EACH ROW EXECUTE FUNCTION documents_tsv_update();

CREATE INDEX documents_tsv ON documents USING gin (tsv);

-- ─────────────────────────────── сущности и связи ────────────────────────────

-- Точные «якоря» документа: номер договора, IBAN, Aktenzeichen, клиентский номер.
-- По ним связи строятся без всякого ИИ и без ошибок.
CREATE TABLE entities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind        text NOT NULL,   -- iban|contract_no|customer_no|case_no|tax_id|invoice_no|person|org|email|phone|address|other
  value       text NOT NULL,
  value_norm  text NOT NULL    -- upper(value) без пробелов и дефисов
);
CREATE INDEX entities_doc  ON entities(document_id);
CREATE INDEX entities_norm ON entities(kind, value_norm);

CREATE TABLE document_links (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id    uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  to_id      uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind       text NOT NULL,   -- same_entity|same_case|reply_to|invoice_for|renewal_of|same_sender|manual
  reason     text,
  confidence real NOT NULL DEFAULT 1,
  source     text NOT NULL DEFAULT 'auto',  -- auto|manual
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_id <> to_id),
  UNIQUE (from_id, to_id, kind)
);
CREATE INDEX links_from ON document_links(from_id);
CREATE INDEX links_to   ON document_links(to_id);

-- ─────────────────────────────── очередь заданий ─────────────────────────────

CREATE TABLE jobs (
  id         bigserial PRIMARY KEY,
  kind       text NOT NULL,                 -- analyze|link|embed
  payload    jsonb NOT NULL,
  status     text NOT NULL DEFAULT 'queued',-- queued|running|done|failed
  attempts   int  NOT NULL DEFAULT 0,
  last_error text,
  run_after  timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_pick ON jobs(status, run_after) WHERE status = 'queued';

-- ─────────────────────────────── журнал доступа ──────────────────────────────

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  user_id    uuid,
  ip         text,
  action     text NOT NULL,   -- login_ok|login_fail|logout|upload|download|delete|search|unlock
  detail     jsonb
);
CREATE INDEX audit_at ON audit_log(at DESC);

-- ─────────────────────────────── сохранённые поиски ──────────────────────────

CREATE TABLE saved_searches (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  query      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────── настройки из интерфейса ─────────────────────────
-- Ключи API и выбор модели редактируются в приложении, а не в .env.
-- Значения зашифрованы тем же DEK, что и файлы: прочитать их можно только
-- при открытом хранилище.

CREATE TABLE app_settings (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        text NOT NULL,
  value_enc  bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
