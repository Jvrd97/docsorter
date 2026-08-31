import { Link } from "react-router-dom";
import { formatDate, formatMoney, type DocumentCard } from "../lib/api.ts";

const STATUS_LABEL: Record<string, string> = {
  pending: "в очереди",
  processing: "разбираю",
  failed: "не разобрал",
};

export function DocCard({ doc }: { doc: DocumentCard }) {
  const money = formatMoney(doc.amount, doc.currency);
  return (
    <Link className="card" to={`/doc/${doc.id}`}>
      <div className="row">
        {doc.has_thumb ? (
          <img className="thumb" src={`/api/documents/${doc.id}/thumb`} alt="" loading="lazy" />
        ) : (
          <div className="thumb thumb-fallback">{doc.mime === "application/pdf" ? "PDF" : "IMG"}</div>
        )}
        <div className="grow">
          <p className="title">{doc.title ?? doc.original_name}</p>
          <div className="meta">
            <span>{formatDate(doc.doc_date)}</span>
            {doc.category && <span>· {doc.category}</span>}
            {doc.sender && <span>· {doc.sender}</span>}
            {money && <span>· {money}</span>}
          </div>
          {doc.status !== "ready" && (
            <div className="meta" style={{ marginTop: 4 }}>
              <span className={`badge ${doc.status === "failed" ? "bad" : "warn"}`}>
                {STATUS_LABEL[doc.status] ?? doc.status}
              </span>
            </div>
          )}
          {doc.due_date && (
            <div className="meta" style={{ marginTop: 4 }}>
              <span className="badge warn">срок {formatDate(doc.due_date)}</span>
            </div>
          )}
          {doc.snippet ? (
            <p className="snippet" dangerouslySetInnerHTML={{ __html: sanitize(doc.snippet) }} />
          ) : (
            doc.summary && <p className="snippet">{doc.summary}</p>
          )}
        </div>
      </div>
    </Link>
  );
}

// ts_headline возвращает <b>…</b> вокруг совпадений. Всё остальное экранируем,
// чтобы содержимое документа не могло принести в интерфейс свою разметку.
function sanitize(html: string): string {
  return html
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/&lt;b&gt;/g, "<b>")
    .replace(/&lt;\/b&gt;/g, "</b>");
}
