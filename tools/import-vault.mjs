#!/usr/bin/env node
// Перенос уже разобранного архива Life/Dokumente в DocSorter.
// Работает по HTTP, поэтому одинаково годится и для локального, и для удалённого сервера.
//
//   node app/tools/import-vault.mjs \
//     --url https://docs.example.com \
//     --login daniil \
//     --from ~/Documents/MyVault/Life/Dokumente
//
// Пароль спрашивается в терминале или берётся из DOCSORTER_PASSWORD.

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { Writable } from "node:stream";

const DOC_EXT = new Set([".pdf", ".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".tif", ".tiff"]);
const SKIP_DIRS = new Set(["Inbox", "Дубликаты", ".git", "node_modules", ".obsidian"]);

const MIME = {
  ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".webp": "image/webp", ".heic": "image/heic",
  ".heif": "image/heif", ".tif": "image/tiff", ".tiff": "image/tiff",
};

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes("--" + name);

function askLine(question, hidden = false) {
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) { if (!muted) process.stdout.write(chunk); cb(); },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { if (hidden) process.stdout.write("\n"); rl.close(); resolve(answer.trim()); });
    muted = hidden;
  });
}

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (DOC_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

/** Достаёт метаданные из .md-сайдкара рядом с файлом (формат старого DocSorter). */
async function readHint(filePath) {
  const sidecar = filePath.replace(/\.[^.]+$/, ".md");
  let text;
  try { text = await readFile(sidecar, "utf8"); } catch { return null; }

  const front = text.match(/^---\n([\s\S]*?)\n---/);
  if (!front) return null;
  const fields = {};
  for (const line of front[1].split("\n")) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) fields[m[1].trim()] = m[2].trim();
  }
  const undefinedish = (v) => !v || /^не\s|^\[\]$|^null$/.test(v);

  const body = text.split(/\n## .*\n/)[1]?.trim() ?? null;
  const base = path.basename(filePath, path.extname(filePath));
  const title = base.replace(/^\d{4}-\d{2}-\d{2}\s+/, "").trim();

  return {
    title: title.length >= 3 ? title.slice(0, 200) : null,
    category: undefinedish(fields["категория"]) ? null : fields["категория"],
    sender: undefinedish(fields["отправитель"]) ? null : fields["отправитель"],
    docDate: /^\d{4}-\d{2}-\d{2}$/.test(fields["дата-документа"] ?? "") ? fields["дата-документа"] : null,
    summary: body ? body.slice(0, 4000) : null,
    tags: ["импорт"],
  };
}

async function main() {
  const base = (arg("url", "http://localhost:8433")).replace(/\/$/, "");
  const login = arg("login") ?? (await askLine("Логин: "));
  const from = arg("from") ?? (await askLine("Папка с документами: "));
  const analyze = !has("no-analyze");
  const limit = Number(arg("limit", "0")) || Infinity;

  const password = process.env.DOCSORTER_PASSWORD ?? (await askLine("Пароль: ", true));
  const totp = arg("totp");

  const auth = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login, password, ...(totp ? { totp } : {}) }),
  });
  if (!auth.ok) throw new Error(`вход не удался: ${auth.status} ${await auth.text()}`);
  const cookie = (auth.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error("сервер не выдал cookie сессии");

  const files = (await walk(path.resolve(from.replace(/^~/, process.env.HOME ?? "~")))).slice(0, limit);
  console.log(`Найдено файлов: ${files.length}\n`);

  let created = 0, skipped = 0, failed = 0;
  for (const [index, file] of files.entries()) {
    const label = `[${index + 1}/${files.length}] ${path.basename(file)}`;
    try {
      const info = await stat(file);
      if (info.size === 0) { console.log(`${label} — пустой, пропуск`); skipped++; continue; }

      const hint = await readHint(file);
      const form = new FormData();
      if (hint) form.append("hint", JSON.stringify(hint));
      const ext = path.extname(file).toLowerCase();
      form.append(
        "file",
        new Blob([await readFile(file)], { type: MIME[ext] ?? "application/octet-stream" }),
        path.basename(file),
      );

      const res = await fetch(`${base}/api/documents?analyze=${analyze ? 1 : 0}`, {
        method: "POST", headers: { cookie }, body: form,
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const json = await res.json();
      if (json.created?.length) { created++; console.log(`${label} — загружен`); }
      else { skipped++; console.log(`${label} — уже есть`); }
    } catch (err) {
      failed++;
      console.error(`${label} — ОШИБКА: ${err.message}`);
    }
  }

  console.log(`\nИтог: загружено ${created}, пропущено ${skipped}, ошибок ${failed}.`);
  if (analyze) console.log("Разбор идёт в фоне — следи за счётчиком «в работе» в приложении.");
}

main().catch((err) => { console.error("Ошибка:", err.message); process.exit(1); });
