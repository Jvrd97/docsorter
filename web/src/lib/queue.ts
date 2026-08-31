/**
 * Очередь загрузки в IndexedDB. Снял в метро без сети — файл лежит в телефоне
 * и уедет сам, когда связь появится. Приложение можно закрыть.
 */

const DB_NAME = "docsorter";
const STORE = "uploads";

export interface QueuedItem {
  id: string;
  name: string;
  type: string;
  size: number;
  blob: Blob;
  addedAt: number;
  status: "waiting" | "sending" | "done" | "failed";
  error?: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = fn(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function enqueue(files: File[]): Promise<QueuedItem[]> {
  const items: QueuedItem[] = files.map((file) => ({
    id: crypto.randomUUID(),
    name: file.name,
    type: file.type,
    size: file.size,
    blob: file,
    addedAt: Date.now(),
    status: "waiting",
  }));
  for (const item of items) await withStore("readwrite", (store) => store.put(item));
  return items;
}

export function listAll(): Promise<QueuedItem[]> {
  return withStore<QueuedItem[]>("readonly", (store) => store.getAll() as IDBRequest<QueuedItem[]>);
}

export async function update(item: QueuedItem): Promise<void> {
  await withStore("readwrite", (store) => store.put(item));
}

export async function remove(id: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(id));
}

export async function clearFinished(): Promise<void> {
  for (const item of await listAll()) {
    if (item.status === "done") await remove(item.id);
  }
}

/** Отправляет очередь по одному файлу. Возвращает, сколько ушло успешно. */
export async function drain(
  send: (file: File) => Promise<void>,
  onChange?: (items: QueuedItem[]) => void,
): Promise<number> {
  let sent = 0;
  for (const item of await listAll()) {
    if (item.status === "done" || item.status === "sending") continue;
    item.status = "sending";
    item.error = undefined;
    await update(item);
    onChange?.(await listAll());
    try {
      await send(new File([item.blob], item.name, { type: item.type }));
      item.status = "done";
      sent++;
    } catch (err) {
      item.status = "failed";
      item.error = err instanceof Error ? err.message : String(err);
    }
    await update(item);
    onChange?.(await listAll());
  }
  return sent;
}
