import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  api, formatBytes, formatDate, formatMoney,
  type DocLink, type DocumentCard, type Entity,
} from "../lib/api.ts";
import { errorText } from "../App.tsx";

const LINK_LABEL: Record<string, string> = {
  same_entity: "общий номер",
  same_case: "то же дело",
  reply_to: "ответ на",
  invoice_for: "счёт к",
  renewal_of: "продление",
  same_sender: "тот же отправитель",
  manual: "связано вручную",
};

const ENTITY_LABEL: Record<string, string> = {
  iban: "IBAN", contract_no: "договор №", customer_no: "клиент №",
  case_no: "дело №", tax_id: "налоговый №", invoice_no: "счёт №",
  person: "человек", org: "организация", email: "почта",
  phone: "телефон", address: "адрес", other: "прочее",
};

export function DocPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [doc, setDoc] = useState<DocumentCard | null>(null);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [links, setLinks] = useState<DocLink[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [showText, setShowText] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const response = await api.get(id);
      setDoc(response.document);
      setEntities(response.entities);
      setLinks(response.links);
    } catch (err) {
      setError(errorText(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Пока документ разбирается, подтягиваем карточку сама собой.
  useEffect(() => {
    if (!doc || doc.status === "ready" || doc.status === "failed") return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [doc, load]);

  if (error) return <div className="page"><div className="notice error">{error}</div></div>;
  if (!doc) return <div className="page"><span className="spinner" /></div>;

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const money = formatMoney(doc.amount, doc.currency);

  return (
    <>
      <header className="header">
        <button className="btn small ghost" onClick={() => navigate(-1)}>‹ назад</button>
        <h1 style={{ fontSize: 16 }}>{doc.title ?? doc.original_name}</h1>
        <button
          className="btn small ghost"
          onClick={() => void act(() => api.patch(doc.id, { favorite: !doc.favorite }))}
        >
          {doc.favorite ? "★" : "☆"}
        </button>
      </header>

      <div className="page">
        {doc.status !== "ready" && (
          <div className={`notice ${doc.status === "failed" ? "error" : ""}`}>
            {doc.status === "failed"
              ? `Не удалось разобрать: ${doc.error ?? "неизвестная ошибка"}`
              : "Разбираю документ… это займёт до минуты."}
          </div>
        )}

        <div className="preview" style={{ marginBottom: 14 }}>
          {doc.mime === "application/pdf" ? (
            <iframe src={`/api/documents/${doc.id}/file`} title="документ" />
          ) : (
            <img src={`/api/documents/${doc.id}/file`} alt={doc.title ?? ""} />
          )}
        </div>

        <div className="btn-row" style={{ marginBottom: 16 }}>
          <a className="btn" href={`/api/documents/${doc.id}/file?download=1`} download>
            ⬇ Скачать
          </a>
          <button className="btn" onClick={() => setEditing(!editing)}>
            {editing ? "Свернуть" : "✎ Править"}
          </button>
          <button className="btn" disabled={busy} onClick={() => void act(() => api.reanalyze(doc.id))}>
            ↻ Переразобрать
          </button>
        </div>

        {editing ? (
          <EditForm doc={doc} onSaved={async () => { setEditing(false); await load(); }} />
        ) : (
          <>
            {doc.summary && <div className="notice">{doc.summary}</div>}
            {doc.action_needed && (
              <div className="notice answer">
                <b>Нужно сделать:</b> {doc.action_needed}
                {doc.due_date && ` · до ${formatDate(doc.due_date)}`}
              </div>
            )}

            <dl className="kv">
              <dt>Дата</dt><dd>{formatDate(doc.doc_date)}</dd>
              <dt>Категория</dt><dd>{doc.category ?? "—"}</dd>
              <dt>Отправитель</dt><dd>{doc.sender ?? "—"}</dd>
              {money && (<><dt>Сумма</dt><dd>{money}</dd></>)}
              <dt>Файл</dt>
              <dd>
                {doc.original_name} · {formatBytes(doc.size_bytes)}
                {doc.page_count ? ` · ${doc.page_count} стр.` : ""}
              </dd>
              <dt>Загружен</dt><dd>{new Date(doc.created_at).toLocaleString("ru-RU")}</dd>
            </dl>

            {doc.tags.length > 0 && (
              <div className="chips" style={{ marginTop: 12 }}>
                {doc.tags.map((tag) => (
                  <span key={tag} className="chip tag">#{tag}</span>
                ))}
              </div>
            )}
          </>
        )}

        {entities.length > 0 && (
          <>
            <div className="section-title">Номера и реквизиты</div>
            <dl className="kv">
              {entities.map((entity) => (
                <div key={entity.id} style={{ display: "contents" }}>
                  <dt>{ENTITY_LABEL[entity.kind] ?? entity.kind}</dt>
                  <dd>{entity.value}</dd>
                </div>
              ))}
            </dl>
          </>
        )}

        <div className="section-title">Связанные документы · {links.length}</div>
        {links.length === 0 && <p className="meta">Пока ничего не связано.</p>}
        {links.map((link) => (
          <div key={link.id} className="card">
            <div className="between">
              <Link className="grow" to={`/doc/${link.other_id}`} style={{ color: "inherit" }}>
                <p className="title" style={{ marginBottom: 2 }}>{link.other_title ?? "без названия"}</p>
                <div className="meta">
                  <span className="chip tag">{LINK_LABEL[link.kind] ?? link.kind}</span>
                  <span>{formatDate(link.other_date)}</span>
                  {link.other_sender && <span>· {link.other_sender}</span>}
                </div>
                {link.reason && <p className="snippet">{link.reason}</p>}
              </Link>
              <button
                className="btn small ghost"
                onClick={() => void act(() => api.removeLink(link.id))}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
        <LinkPicker docId={doc.id} onLinked={load} />

        {doc.full_text && (
          <>
            <div className="section-title">
              Распознанный текст{" "}
              <button className="btn small ghost" onClick={() => setShowText(!showText)}>
                {showText ? "скрыть" : "показать"}
              </button>
            </div>
            {showText && (
              <pre
                className="card"
                style={{ whiteSpace: "pre-wrap", fontSize: 13, color: "var(--muted)", maxHeight: "50vh", overflow: "auto" }}
              >
                {doc.full_text}
              </pre>
            )}
          </>
        )}

        <div className="section-title">Опасная зона</div>
        <div className="btn-row">
          <button
            className="btn"
            disabled={busy}
            onClick={() => void act(() => api.patch(doc.id, { archived: !doc.archived }))}
          >
            {doc.archived ? "Вернуть из архива" : "В архив"}
          </button>
          <button
            className="btn danger"
            disabled={busy}
            onClick={async () => {
              if (!confirm("Удалить документ навсегда? Файл сотрётся с сервера.")) return;
              await api.remove(doc.id);
              navigate("/browse");
            }}
          >
            Удалить
          </button>
        </div>
      </div>
    </>
  );
}

function EditForm({ doc, onSaved }: { doc: DocumentCard; onSaved: () => void }) {
  const [title, setTitle] = useState(doc.title ?? "");
  const [category, setCategory] = useState(doc.category ?? "");
  const [sender, setSender] = useState(doc.sender ?? "");
  const [docDate, setDocDate] = useState(doc.doc_date ?? "");
  const [dueDate, setDueDate] = useState(doc.due_date ?? "");
  const [tags, setTags] = useState(doc.tags.join(", "));
  const [summary, setSummary] = useState(doc.summary ?? "");
  const [categories, setCategories] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.facets().then((f) => setCategories(f.allCategories)).catch(() => undefined);
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(doc.id, {
        title: title.trim() || undefined,
        category: category || undefined,
        sender: sender.trim() || null,
        docDate: docDate || null,
        dueDate: dueDate || null,
        summary,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <label className="field">
        <span>Название</span>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="field">
        <span>Категория</span>
        <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">—</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Отправитель</span>
        <input className="input" value={sender} onChange={(e) => setSender(e.target.value)} />
      </label>
      <label className="field">
        <span>Дата документа</span>
        <input className="input" type="date" value={docDate} onChange={(e) => setDocDate(e.target.value)} />
      </label>
      <label className="field">
        <span>Срок</span>
        <input className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </label>
      <label className="field">
        <span>Теги через запятую</span>
        <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} />
      </label>
      <label className="field">
        <span>Описание</span>
        <textarea className="textarea" value={summary} onChange={(e) => setSummary(e.target.value)} />
      </label>
      {error && <div className="notice error">{error}</div>}
      <button className="btn primary" onClick={() => void save()} disabled={busy}>
        Сохранить
      </button>
    </div>
  );
}

function LinkPicker({ docId, onLinked }: { docId: string; onLinked: () => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<DocumentCard[]>([]);
  const [busy, setBusy] = useState(false);

  async function find() {
    if (q.trim().length < 2) return;
    setBusy(true);
    try {
      const response = await api.search(q, "fast");
      setFound(response.documents.filter((d) => d.id !== docId).slice(0, 8));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="btn ghost small" onClick={() => setOpen(true)}>
        + Связать с другим документом
      </button>
    );
  }

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <input
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Найти документ"
          onKeyDown={(e) => e.key === "Enter" && void find()}
        />
        <button className="btn small" onClick={() => void find()} disabled={busy}>
          Найти
        </button>
      </div>
      {found.map((candidate) => (
        <div key={candidate.id} className="between" style={{ padding: "7px 0" }}>
          <span className="grow">{candidate.title ?? candidate.original_name}</span>
          <button
            className="btn small"
            onClick={async () => {
              await api.addLink(docId, candidate.id);
              setOpen(false);
              setFound([]);
              setQ("");
              onLinked();
            }}
          >
            связать
          </button>
        </div>
      ))}
      <button className="btn ghost small" onClick={() => setOpen(false)}>
        отмена
      </button>
    </div>
  );
}
