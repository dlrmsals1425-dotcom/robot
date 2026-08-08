import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);
const origin = "https://safebot.example";
const controlPassword = "test-control-password";
const sessionSecret = "test-session-secret-with-at-least-32-characters";

function normalizeBinding(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return value;
}

function result(rows = [], changes = 0) {
  return {
    success: true,
    results: rows,
    meta: { changes },
  };
}

class SqliteD1Statement {
  constructor(owner, sql, values = []) {
    this.owner = owner;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    return new SqliteD1Statement(
      this.owner,
      this.sql,
      values.map(normalizeBinding),
    );
  }

  executeRun() {
    const info = this.owner.sqlite.prepare(this.sql).run(...this.values);
    return result([], Number(info.changes));
  }

  async run() {
    return this.executeRun();
  }

  async all() {
    const rows = this.owner.sqlite.prepare(this.sql).all(...this.values);
    return result(rows, 0);
  }

  async first(columnName) {
    const row = this.owner.sqlite.prepare(this.sql).get(...this.values);
    if (!row) return null;
    return columnName === undefined ? row : row[columnName] ?? null;
  }
}

class SqliteD1 {
  constructor(sqlite) {
    this.sqlite = sqlite;
  }

  prepare(sql) {
    return new SqliteD1Statement(this, sql);
  }

  async batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement.executeRun());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

async function createDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const [firstMigration, secondMigration] = await Promise.all([
    readFile(new URL("migrations/0001_event_storage.sql", projectRoot), "utf8"),
    readFile(
      new URL("migrations/0002_d1_media_storage.sql", projectRoot),
      "utf8",
    ),
  ]);
  sqlite.exec(firstMigration);
  sqlite.exec(secondMigration);
  return new SqliteD1(sqlite);
}

function createContext() {
  const pending = [];
  return {
    waitUntil(promise) {
      pending.push(Promise.resolve(promise));
    },
    passThroughOnException() {},
    async drain() {
      await Promise.all(pending);
    },
  };
}

function environment(db) {
  return {
    ASSETS: {
      fetch: async () => new Response("Not found", { status: 404 }),
    },
    DB: db,
    CONTROL_PASSWORD: controlPassword,
    SESSION_SECRET: sessionSecret,
  };
}

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("media-api-test", `${process.pid}-${Date.now()}`);
  return (await import(workerUrl.href)).default;
}

async function login(worker, env) {
  const response = await worker.fetch(
    new Request(`${origin}/api/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
      },
      body: JSON.stringify({ password: controlPassword }),
    }),
    env,
    createContext(),
  );
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  return setCookie.split(";", 1)[0];
}

function webmBytes(size, seed = 0) {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index + seed) % 251;
  }
  bytes.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  return bytes;
}

function jpegBytes(size) {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index * 7) % 251;
  }
  bytes.set([0xff, 0xd8, 0xff], 0);
  return bytes;
}

function eventMeta(id, createdAt) {
  return {
    id,
    status: "emergency",
    title: "쓰러짐 의심 · 관제 확인 필요",
    detail: "누운 자세가 10초간 연속 감지되었습니다.",
    createdAt,
    durationSeconds: 10,
    confidence: 0.91,
    notification: "sent",
    people: 1,
    objects: 2,
    deviceId: "test-device",
  };
}

function uploadRequest(cookie, meta, clipBytes, posterBytes) {
  const form = new FormData();
  form.set("meta", JSON.stringify(meta));
  form.set(
    "clip",
    new Blob([clipBytes], { type: "video/webm" }),
    `${meta.id}.webm`,
  );
  form.set(
    "poster",
    new Blob([posterBytes], { type: "image/jpeg" }),
    `${meta.id}.jpg`,
  );
  return new Request(`${origin}/api/events`, {
    method: "POST",
    headers: { cookie, origin },
    body: form,
  });
}

test("D1 usage CHECK and media writes roll back atomically", async () => {
  const db = await createDatabase();
  const reserveUsage = (bytes) =>
    db
      .prepare(
        `INSERT INTO media_usage (singleton, active_bytes, updated_at)
         VALUES (1, ?1, 1)
         ON CONFLICT(singleton) DO UPDATE SET
           active_bytes = media_usage.active_bytes + excluded.active_bytes,
           updated_at = excluded.updated_at`,
      )
      .bind(bytes);
  const eventInsert = db
    .prepare(
      `INSERT INTO safety_events (
         id, status, title, detail, created_at, duration_seconds, confidence,
         notification, expires_at, media_bytes
       ) VALUES (?1, 'emergency', 't', 'd', 1, 10, 0.9, 'sent', 9999999999999, ?2)`,
    )
    .bind("atomic-event", 3);
  const invalidChunk = db
    .prepare(
      `INSERT INTO event_media_chunks (
         event_id, kind, chunk_index, bytes, byte_length
       ) VALUES (?1, 'clip', 0, ?2, 2)`,
    )
    .bind("atomic-event", new Uint8Array([1, 2, 3]).buffer);

  await assert.rejects(
    db.batch([reserveUsage(3), eventInsert, invalidChunk]),
  );
  assert.equal(
    db.sqlite.prepare("SELECT COUNT(*) AS count FROM safety_events").get()
      .count,
    0,
  );
  assert.equal(
    db.sqlite.prepare("SELECT active_bytes FROM media_usage").get()
      .active_bytes,
    0,
  );

  const capacityEvent = (id, bytes) =>
    db
      .prepare(
        `INSERT INTO safety_events (
           id, status, title, detail, created_at, duration_seconds, confidence,
           notification, expires_at, media_bytes
         ) VALUES (
           ?1, 'emergency', 't', 'd', 1, 10, 0.9, 'sent',
           9999999999999, ?2
         )`,
      )
      .bind(id, bytes);

  db.sqlite.exec("DELETE FROM media_usage");
  await db.batch([
    reserveUsage(3),
    capacityEvent("singleton-recovery", 3),
  ]);
  assert.equal(
    db.sqlite.prepare("SELECT active_bytes FROM media_usage").get()
      .active_bytes,
    3,
  );
  await db.batch([
    db
      .prepare(
        `UPDATE media_usage
         SET active_bytes = active_bytes - (
           SELECT media_bytes FROM safety_events WHERE id = ?1
         )
         WHERE singleton = 1`,
      )
      .bind("singleton-recovery"),
    db
      .prepare("DELETE FROM safety_events WHERE id = ?1")
      .bind("singleton-recovery"),
  ]);

  for (let index = 0; index < 7; index += 1) {
    await db.batch([
      reserveUsage(13_000_000),
      capacityEvent(`capacity-${index}`, 13_000_000),
    ]);
  }
  await db.batch([
    reserveUsage(9_000_000),
    capacityEvent("capacity-final", 9_000_000),
  ]);
  assert.equal(
    db.sqlite.prepare("SELECT active_bytes FROM media_usage").get()
      .active_bytes,
    100_000_000,
  );
  await assert.rejects(
    db.batch([
      reserveUsage(1),
      capacityEvent("capacity-over", 1),
    ]),
    /media_usage_active_bytes_limit/,
  );
  assert.equal(
    db.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM safety_events WHERE id = 'capacity-over'",
      )
      .get().count,
    0,
  );

  await db.batch([
    db.prepare(
      `UPDATE media_usage
       SET active_bytes = active_bytes - (
         SELECT COALESCE(SUM(media_bytes), 0) FROM safety_events
       )
       WHERE singleton = 1`,
    ),
    db.prepare("DELETE FROM safety_events"),
  ]);
  assert.equal(
    db.sqlite.prepare("SELECT active_bytes FROM media_usage").get()
      .active_bytes,
    0,
  );
});

test("concurrent uploads, Range, manual delete, and 99-event cleanup preserve D1 usage", async () => {
  const worker = await loadWorker();
  const db = await createDatabase();
  const env = environment(db);
  const cookie = await login(worker, env);
  const createdAt = new Date().toISOString();
  const meta = eventMeta("concurrent-event-001", createdAt);
  const clip = webmBytes(2_100_123);
  const poster = jpegBytes(321);
  const firstContext = createContext();
  const secondContext = createContext();

  const [first, second] = await Promise.all([
    worker.fetch(
      uploadRequest(cookie, meta, clip, poster),
      env,
      firstContext,
    ),
    worker.fetch(
      uploadRequest(cookie, meta, clip, poster),
      env,
      secondContext,
    ),
  ]);
  await Promise.all([firstContext.drain(), secondContext.drain()]);
  assert.deepEqual(
    [first.status, second.status].sort((left, right) => left - right),
    [200, 201],
  );
  const idempotentPayload = await (first.status === 200 ? first : second).json();
  assert.equal(idempotentPayload.idempotent, true);

  assert.equal(
    db.sqlite.prepare("SELECT COUNT(*) AS count FROM safety_events").get()
      .count,
    1,
  );
  assert.equal(
    db.sqlite.prepare("SELECT COUNT(*) AS count FROM event_media_chunks").get()
      .count,
    4,
  );
  assert.equal(
    db.sqlite.prepare("SELECT active_bytes FROM media_usage").get()
      .active_bytes,
    clip.byteLength + poster.byteLength,
  );

  const rangeStart = 999_990;
  const rangeEnd = 1_000_010;
  const rangeContext = createContext();
  const rangeResponse = await worker.fetch(
    new Request(`${origin}/api/events/${meta.id}/clip`, {
      headers: {
        cookie,
        range: `bytes=${rangeStart}-${rangeEnd}`,
      },
    }),
    env,
    rangeContext,
  );
  await rangeContext.drain();
  assert.equal(rangeResponse.status, 206);
  assert.equal(
    rangeResponse.headers.get("content-range"),
    `bytes ${rangeStart}-${rangeEnd}/${clip.byteLength}`,
  );
  assert.deepEqual(
    new Uint8Array(await rangeResponse.arrayBuffer()),
    clip.slice(rangeStart, rangeEnd + 1),
  );

  const headContext = createContext();
  const headResponse = await worker.fetch(
    new Request(`${origin}/api/events/${meta.id}/clip`, {
      method: "HEAD",
      headers: { cookie },
    }),
    env,
    headContext,
  );
  await headContext.drain();
  assert.equal(headResponse.status, 200);
  assert.equal(
    headResponse.headers.get("content-length"),
    String(clip.byteLength),
  );
  assert.equal((await headResponse.arrayBuffer()).byteLength, 0);

  const deleteContext = createContext();
  const deleteResponse = await worker.fetch(
    new Request(`${origin}/api/events/${meta.id}`, {
      method: "DELETE",
      headers: { cookie, origin },
    }),
    env,
    deleteContext,
  );
  await deleteContext.drain();
  assert.equal(deleteResponse.status, 200);
  assert.equal(
    db.sqlite.prepare("SELECT COUNT(*) AS count FROM event_media_chunks").get()
      .count,
    0,
  );
  assert.equal(
    db.sqlite.prepare("SELECT active_bytes FROM media_usage").get()
      .active_bytes,
    0,
  );

  const cleanupMeta = eventMeta(
    "cleanup-event-001",
    new Date().toISOString(),
  );
  const cleanupUploadContext = createContext();
  const cleanupUpload = await worker.fetch(
    uploadRequest(cookie, cleanupMeta, clip, poster),
    env,
    cleanupUploadContext,
  );
  await cleanupUploadContext.drain();
  assert.equal(cleanupUpload.status, 201);
  db.sqlite
    .prepare("UPDATE safety_events SET expires_at = 0 WHERE id = ?")
    .run(cleanupMeta.id);
  const insertExpired = db.sqlite.prepare(
    `INSERT INTO safety_events (
       id, status, title, detail, created_at, duration_seconds, confidence,
       notification, expires_at, media_bytes
     ) VALUES (
       ?, 'interrupted', 'expired', 'expired', 1, 0, 0,
       'not_sent', 0, 0
     )`,
  );
  for (let index = 0; index < 98; index += 1) {
    insertExpired.run(`expired-event-${String(index).padStart(3, "0")}`);
  }
  assert.equal(
    db.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM safety_events WHERE expires_at <= 0",
      )
      .get().count,
    99,
  );

  const cleanupContext = createContext();
  await worker.fetch(
    new Request(`${origin}/api/events`, { headers: { cookie } }),
    env,
    cleanupContext,
  );
  await cleanupContext.drain();

  assert.equal(
    db.sqlite.prepare("SELECT COUNT(*) AS count FROM safety_events").get()
      .count,
    0,
  );
  assert.equal(
    db.sqlite.prepare("SELECT COUNT(*) AS count FROM event_media_chunks").get()
      .count,
    0,
  );
  assert.equal(
    db.sqlite.prepare("SELECT active_bytes FROM media_usage").get()
      .active_bytes,
    0,
  );
});
