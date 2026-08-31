import { useCallback, useEffect, useRef, useState } from "react";
import { api, formatBytes } from "../lib/api.ts";
import { shrink } from "../lib/image.ts";
import * as queue from "../lib/queue.ts";
import { errorText } from "../App.tsx";

const STATUS: Record<queue.QueuedItem["status"], { label: string; cls: string }> = {
  waiting: { label: "ждёт", cls: "" },
  sending: { label: "отправляю", cls: "warn" },
  done: { label: "загружено", cls: "ok" },
  failed: { label: "ошибка", cls: "bad" },
};

export function UploadPage() {
  const [items, setItems] = useState<queue.QueuedItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => setItems(await queue.listAll()), []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const send = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await queue.drain(async (file) => {
        await api.upload([await shrink(file)]);
      }, setItems);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      void reload();
    }
  }, [busy, reload]);

  // Появилась сеть — доотправляем то, что осталось с прошлого раза.
  useEffect(() => {
    const onOnline = () => void send();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [send]);

  useEffect(() => {
    void (async () => {
      const pending = (await queue.listAll()).filter((i) => i.status !== "done");
      if (pending.length && navigator.onLine) void send();
    })();
    // разово при открытии экрана
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pick(files: FileList | null) {
    if (!files?.length) return;
    await queue.enqueue([...files]);
    await reload();
    void send();
  }

  const waiting = items.filter((i) => i.status !== "done");
  const done = items.filter((i) => i.status === "done");

  return (
    <>
      <header className="header">
        <h1>Добавить документы</h1>
        {busy && <span className="spinner" />}
      </header>

      <div className="page">
        <div className="btn-row" style={{ marginBottom: 14 }}>
          <button className="btn primary" onClick={() => cameraRef.current?.click()}>
            📷 Сфотографировать
          </button>
          <button className="btn" onClick={() => galleryRef.current?.click()}>
            🖼 Из галереи
          </button>
        </div>

        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => void pick(e.target.files)}
        />
        <input
          ref={galleryRef}
          type="file"
          accept="image/*,application/pdf"
          multiple
          hidden
          onChange={(e) => void pick(e.target.files)}
        />

        <p className="meta" style={{ marginBottom: 16 }}>
          Фото сжимаются прямо в телефоне и уходят на сервер. Без сети остаются в очереди
          и уедут сами. Разбор идёт в фоне — можно закрывать приложение.
        </p>

        {error && <div className="notice error">{error}</div>}

        {waiting.length > 0 && (
          <>
            <div className="section-title">В очереди · {waiting.length}</div>
            {waiting.map((item) => (
              <QueueRow key={item.id} item={item} onDrop={async () => { await queue.remove(item.id); void reload(); }} />
            ))}
            <button className="btn" onClick={() => void send()} disabled={busy}>
              Отправить сейчас
            </button>
          </>
        )}

        {done.length > 0 && (
          <>
            <div className="section-title">Отправлено · {done.length}</div>
            {done.slice(-8).map((item) => (
              <QueueRow key={item.id} item={item} />
            ))}
            <button
              className="btn ghost"
              onClick={async () => {
                await queue.clearFinished();
                void reload();
              }}
            >
              Очистить список
            </button>
          </>
        )}

        {items.length === 0 && (
          <div className="empty">
            <div className="big">📄</div>
            Пусто. Сфотографируй документ или выбери файлы из галереи.
          </div>
        )}
      </div>
    </>
  );
}

function QueueRow({ item, onDrop }: { item: queue.QueuedItem; onDrop?: () => void }) {
  const status = STATUS[item.status];
  return (
    <div className="card">
      <div className="between">
        <div className="grow">
          <p className="title" style={{ marginBottom: 2 }}>{item.name}</p>
          <div className="meta">
            <span>{formatBytes(item.size)}</span>
            <span className={`badge ${status.cls}`}>{status.label}</span>
          </div>
          {item.error && <p className="snippet" style={{ color: "var(--danger)" }}>{item.error}</p>}
        </div>
        {onDrop && (
          <button className="btn small ghost" onClick={onDrop}>
            убрать
          </button>
        )}
      </div>
    </div>
  );
}
