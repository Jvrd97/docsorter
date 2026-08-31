import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, plural, type DocumentCard } from "../lib/api.ts";
import { DocCard } from "../components/DocCard.tsx";
import { errorText } from "../App.tsx";

const EXAMPLES = [
  "договор аренды квартиры",
  "счета от o2 за прошлый год",
  "сколько я заплатил за электричество",
  "что мне надо оплатить",
];

export function SearchPage() {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<"smart" | "fast">("smart");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [restated, setRestated] = useState<string | null>(null);
  const [results, setResults] = useState<DocumentCard[] | null>(null);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.stats>> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.stats().then(setStats).catch(() => undefined);
  }, []);

  async function run(text: string) {
    const query = text.trim();
    if (!query) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    setNote(null);
    inputRef.current?.blur();
    try {
      const response = await api.search(query, mode);
      setResults(response.documents);
      setAnswer(response.answer);
      setNote(response.note ?? null);
      setRestated(response.plan?.restated ?? null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(q);
  }

  return (
    <>
      <header className="header">
        <h1>Поиск</h1>
        <button
          className={`chip ${mode === "smart" ? "on" : ""}`}
          onClick={() => setMode(mode === "smart" ? "fast" : "smart")}
        >
          {mode === "smart" ? "умный" : "быстрый"}
        </button>
      </header>

      <div className="page">
        <form onSubmit={submit} style={{ marginBottom: 14 }}>
          <input
            ref={inputRef}
            className="input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Спроси словами: «страховка машины за 2025»"
            enterKeyHint="search"
            autoCapitalize="none"
          />
        </form>

        {busy && (
          <div className="notice">
            <span className="spinner" /> {mode === "smart" ? "Думаю и ищу…" : "Ищу…"}
          </div>
        )}
        {error && <div className="notice error">{error}</div>}
        {note && <div className="notice warn">{note}</div>}
        {answer && <div className="notice answer">{answer}</div>}
        {restated && !answer && results && results.length > 0 && (
          <p className="meta" style={{ marginBottom: 10 }}>Понял как: {restated}</p>
        )}

        {results === null && !busy && (
          <>
            {stats && <StatsBar stats={stats} />}
            <div className="section-title">Примеры запросов</div>
            <div className="chips">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  className="chip"
                  onClick={() => {
                    setQ(example);
                    void run(example);
                  }}
                >
                  {example}
                </button>
              ))}
            </div>

            {stats && stats.due.length > 0 && (
              <>
                <div className="section-title">Ближайшие сроки</div>
                {stats.due.map((doc) => (
                  <DocCard key={doc.id} doc={doc} />
                ))}
              </>
            )}
          </>
        )}

        {results !== null && !busy && (
          <>
            <div className="section-title">Найдено · {results.length}</div>
            {results.length === 0 ? (
              <div className="empty">
                <div className="big">🤷</div>
                Ничего не нашлось. Попробуй другими словами или загляни в архив.
              </div>
            ) : (
              results.map((doc) => <DocCard key={doc.id} doc={doc} />)
            )}
          </>
        )}
      </div>
    </>
  );
}

function StatsBar({ stats }: { stats: NonNullable<Awaited<ReturnType<typeof api.stats>>> }) {
  const s = stats.stats;
  return (
    <div className="card">
      <div className="between">
        <div>
          <p className="title" style={{ marginBottom: 2 }}>{plural(s.total, "документ", "документа", "документов")}</p>
          <div className="meta">
            {s.in_progress > 0 && <span className="badge warn">в работе {s.in_progress}</span>}
            {s.failed > 0 && <span className="badge bad">ошибок {s.failed}</span>}
            {s.todo > 0 && <span>{s.todo} требуют действия</span>}
          </div>
        </div>
        <Link className="btn small" to="/browse">
          Архив
        </Link>
      </div>
    </div>
  );
}
