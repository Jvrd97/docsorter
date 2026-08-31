import { useCallback, useEffect, useState } from "react";
import { api, type DocumentCard, type Facets } from "../lib/api.ts";
import { DocCard } from "../components/DocCard.tsx";
import { errorText } from "../App.tsx";

const PAGE = 30;

export function BrowsePage() {
  const [facets, setFacets] = useState<Facets | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [sender, setSender] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [year, setYear] = useState<number | null>(null);
  const [archived, setArchived] = useState(false);
  const [docs, setDocs] = useState<DocumentCard[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.facets().then(setFacets).catch(() => undefined);
  }, []);

  const load = useCallback(
    async (nextOffset: number) => {
      setBusy(true);
      setError(null);
      try {
        const response = await api.list({
          category: category ?? undefined,
          sender: sender ?? undefined,
          tag: tag ?? undefined,
          dateFrom: year ? `${year}-01-01` : undefined,
          dateTo: year ? `${year}-12-31` : undefined,
          archived,
          limit: PAGE,
          offset: nextOffset,
        });
        setTotal(response.total);
        setDocs((prev) => (nextOffset === 0 ? response.documents : [...prev, ...response.documents]));
        setOffset(nextOffset);
      } catch (err) {
        setError(errorText(err));
      } finally {
        setBusy(false);
      }
    },
    [category, sender, tag, year, archived],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  const toggle = <T,>(current: T | null, value: T, set: (v: T | null) => void) =>
    set(current === value ? null : value);

  return (
    <>
      <header className="header">
        <h1>Архив</h1>
        <span className="meta">{total}</span>
      </header>

      <div className="page">
        {facets && (
          <>
            <div className="scroller" style={{ marginBottom: 8 }}>
              {facets.categories.map((c) => (
                <button
                  key={c.value}
                  className={`chip ${category === c.value ? "on" : ""}`}
                  onClick={() => toggle(category, c.value, setCategory)}
                >
                  {c.value} · {c.count}
                </button>
              ))}
            </div>
            <div className="scroller" style={{ marginBottom: 8 }}>
              {facets.years.map((y) => (
                <button
                  key={y.value}
                  className={`chip ${year === y.value ? "on" : ""}`}
                  onClick={() => toggle(year, y.value, setYear)}
                >
                  {y.value}
                </button>
              ))}
            </div>
            <div className="scroller" style={{ marginBottom: 8 }}>
              {facets.senders.slice(0, 25).map((s) => (
                <button
                  key={s.value}
                  className={`chip ${sender === s.value ? "on" : ""}`}
                  onClick={() => toggle(sender, s.value, setSender)}
                >
                  {s.value}
                </button>
              ))}
            </div>
            <div className="scroller" style={{ marginBottom: 14 }}>
              {facets.tags.slice(0, 30).map((t) => (
                <button
                  key={t.value}
                  className={`chip tag ${tag === t.value ? "on" : ""}`}
                  onClick={() => toggle(tag, t.value, setTag)}
                >
                  #{t.value}
                </button>
              ))}
              <button className={`chip ${archived ? "on" : ""}`} onClick={() => setArchived(!archived)}>
                в архиве
              </button>
            </div>
          </>
        )}

        {(category || sender || tag || year) && (
          <button
            className="btn ghost small"
            style={{ marginBottom: 12 }}
            onClick={() => {
              setCategory(null);
              setSender(null);
              setTag(null);
              setYear(null);
            }}
          >
            Сбросить фильтры
          </button>
        )}

        {error && <div className="notice error">{error}</div>}

        {docs.map((doc) => (
          <DocCard key={doc.id} doc={doc} />
        ))}

        {docs.length === 0 && !busy && (
          <div className="empty">
            <div className="big">🗂</div>
            Здесь пусто.
          </div>
        )}

        {busy && (
          <div className="notice">
            <span className="spinner" /> Загружаю…
          </div>
        )}

        {docs.length < total && !busy && (
          <button className="btn" onClick={() => void load(offset + PAGE)}>
            Показать ещё
          </button>
        )}
      </div>
    </>
  );
}
