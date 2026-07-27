/**
 * Minimal in-memory fake of the Supabase JS client's postgrest/storage/rpc
 * surface, used by tests that exercise src/lib/**, src/stages/** and
 * app/api/** code which only ever receives a `ServiceClient` — never a live
 * Supabase project (none is provisioned for this build; see
 * .pipeline/changes.md "Known gaps" #5). It supports exactly the query
 * shapes this codebase actually issues:
 *   .from(table).select()/.insert()/.update()/.upsert(), .eq(), .order(),
 *   .limit(), .single(), .maybeSingle(), and a bare-awaited builder (used by
 *   src/lib/cost/engine.ts's rate_card lookup and src/lib/versioning.ts's
 *   plain `.update().eq(...)` calls with no terminal .select()).
 *   .storage.from(bucket).upload()/.download()/.createSignedUrl()/.remove().
 *   .rpc(name, args) — an escape hatch, throws unless a handler is
 *   registered via `_registerRpc` (nothing in the tests below needs it, but
 *   failing loudly beats silently returning undefined).
 * It is NOT a general Postgrest emulator — no or/gt/lt/in, no joins.
 *
 * Mocking boundary: tests `vi.mock("@/src/lib/supabase/service", ...)` to
 * swap `createServiceClient()` for one of these, then exercise the REAL
 * src/lib/*, src/stages/* and app/api/** route code against it — the same
 * "mock the SDK boundary, run the real logic" pattern the adapter tests use
 * for @google/genai / global fetch (see e.g.
 * src/adapters/video_broll/veo.test.ts).
 */
import { randomUUID } from "node:crypto";

export type FakeRow = Record<string, unknown>;

export interface PgError {
  code?: string;
  message: string;
}

export interface UniqueConstraint {
  table: string;
  columns: string[];
  /** Only enforced for rows matching this predicate (mirrors a partial index, e.g. cost_log's idempotency_key IS NOT NULL). */
  where?: (row: FakeRow) => boolean;
}

export interface FakeSupabaseOptions {
  uniqueConstraints?: UniqueConstraint[];
}

function ok<T>(data: T): { data: T; error: null } {
  return { data, error: null };
}
function fail(error: PgError): { data: null; error: PgError } {
  return { data: null, error };
}

type ExecMode = "select" | "insert" | "update" | "upsert" | null;

class FakeQueryBuilder {
  private mode: ExecMode = null;
  private filters: Array<[string, unknown]> = [];
  private payload: FakeRow | FakeRow[] | null = null;
  private upsertConflictCol = "id";
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;

  constructor(
    private readonly tableName: string,
    private readonly rows: () => FakeRow[],
    private readonly checkUnique: (table: string, row: FakeRow) => PgError | null
  ) {}

  select(_cols?: string): this {
    if (this.mode == null) this.mode = "select";
    return this;
  }
  insert(payload: FakeRow | FakeRow[]): this {
    this.mode = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: FakeRow): this {
    this.mode = "update";
    this.payload = payload;
    return this;
  }
  upsert(payload: FakeRow, opts?: { onConflict?: string }): this {
    this.mode = "upsert";
    this.payload = payload;
    this.upsertConflictCol = opts?.onConflict ?? "id";
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push([col, val]);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderCol = col;
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  private matching(): FakeRow[] {
    return this.rows().filter((row) => this.filters.every(([col, val]) => row[col] === val));
  }

  private execSelect(): { data: FakeRow[]; error: null } {
    let out = this.matching();
    if (this.orderCol) {
      const col = this.orderCol;
      out = [...out].sort((a, b) => {
        const av = a[col] as number | string;
        const bv = b[col] as number | string;
        if (av === bv) return 0;
        return (av > bv ? 1 : -1) * (this.orderAsc ? 1 : -1);
      });
    }
    if (this.limitN != null) out = out.slice(0, this.limitN);
    return ok(out);
  }

  private execInsert(): { data: FakeRow[] | null; error: PgError | null } {
    const table = this.rows();
    const items = Array.isArray(this.payload) ? this.payload : [this.payload as FakeRow];
    const inserted: FakeRow[] = [];
    for (const partial of items) {
      const row: FakeRow = { id: randomUUID(), created_at: new Date().toISOString(), ...partial };
      const violation = this.checkUnique(this.tableName, row);
      if (violation) return fail(violation);
      table.push(row);
      inserted.push(row);
    }
    return ok(inserted);
  }

  private execUpdate(): { data: FakeRow[]; error: null } {
    const matched = this.matching();
    for (const row of matched) Object.assign(row, this.payload as FakeRow);
    return ok(matched);
  }

  private execUpsert(): { data: FakeRow[]; error: null } {
    const table = this.rows();
    const payload = this.payload as FakeRow;
    const existing = table.find((row) => row[this.upsertConflictCol] === payload[this.upsertConflictCol]);
    if (existing) {
      Object.assign(existing, payload);
      return ok([existing]);
    }
    const row: FakeRow = { id: randomUUID(), created_at: new Date().toISOString(), ...payload };
    table.push(row);
    return ok([row]);
  }

  private exec(): { data: unknown; error: PgError | null } {
    if (this.mode === "insert") return this.execInsert();
    if (this.mode === "update") return this.execUpdate();
    if (this.mode === "upsert") return this.execUpsert();
    return this.execSelect();
  }

  async single(): Promise<{ data: FakeRow | null; error: PgError | null }> {
    const { data, error } = this.exec();
    if (error) return fail(error);
    const rows = (data as FakeRow[]) ?? [];
    if (rows.length !== 1) {
      return fail({ code: "PGRST116", message: `expected exactly one row for ${this.tableName}, got ${rows.length}` });
    }
    return ok(rows[0]);
  }

  async maybeSingle(): Promise<{ data: FakeRow | null; error: PgError | null }> {
    const { data, error } = this.exec();
    if (error) return fail(error);
    const rows = (data as FakeRow[]) ?? [];
    return ok(rows[0] ?? null);
  }

  // Makes the builder itself awaitable — mirrors real supabase-js, where a
  // chain with no terminal .single()/.maybeSingle() still resolves to
  // {data, error} on `await` (used by cost/engine.ts's rate_card lookup and
  // versioning.ts's bare `.update(...).eq(...)` calls).
  then<TResult1 = { data: unknown; error: PgError | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: PgError | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.exec()).then(onfulfilled, onrejected);
  }
}

export interface FakeUpload {
  bucket: string;
  path: string;
  contentType?: string;
  bytes: Buffer;
}

export interface FakeSupabaseClient {
  from(table: string): FakeQueryBuilder;
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        data: Buffer | string,
        opts?: { contentType?: string; upsert?: boolean }
      ): Promise<{ data: { path: string } | null; error: PgError | null }>;
      download(path: string): Promise<{ data: { arrayBuffer(): Promise<ArrayBufferLike> } | null; error: PgError | null }>;
      createSignedUrl(path: string, expiresIn?: number): Promise<{ data: { signedUrl: string } | null; error: PgError | null }>;
      remove(paths: string[]): Promise<{ data: unknown; error: PgError | null }>;
    };
  };
  rpc(name: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: PgError | null }>;
  /** Direct access to the in-memory tables, for test setup/assertions. */
  _tables: Record<string, FakeRow[]>;
  /** Every storage upload made during the test, in call order. */
  _uploads: FakeUpload[];
  _registerRpc(name: string, handler: (args: Record<string, unknown>) => unknown): void;
}

export function createFakeSupabase(
  seed: Record<string, FakeRow[]> = {},
  options: FakeSupabaseOptions = {}
): FakeSupabaseClient {
  const tables: Record<string, FakeRow[]> = {};
  for (const [name, rows] of Object.entries(seed)) {
    tables[name] = rows.map((r) => ({ ...r }));
  }
  const buckets: Record<string, Map<string, { data: Buffer; contentType: string }>> = {};
  const uploads: FakeUpload[] = [];
  const rpcHandlers: Record<string, (args: Record<string, unknown>) => unknown> = {};

  function rowsFor(name: string): FakeRow[] {
    if (!tables[name]) tables[name] = [];
    return tables[name];
  }

  function checkUnique(table: string, row: FakeRow): PgError | null {
    for (const c of options.uniqueConstraints ?? []) {
      if (c.table !== table) continue;
      if (c.where && !c.where(row)) continue;
      const dup = rowsFor(table).some((existing) => {
        if (c.where && !c.where(existing)) return false;
        return c.columns.every((col) => existing[col] === row[col]);
      });
      if (dup) {
        return {
          code: "23505",
          message: `duplicate key value violates unique constraint on ${table}(${c.columns.join(",")})`,
        };
      }
    }
    return null;
  }

  function bucketFor(name: string) {
    if (!buckets[name]) buckets[name] = new Map();
    return buckets[name];
  }

  return {
    from(tableName: string) {
      return new FakeQueryBuilder(tableName, () => rowsFor(tableName), checkUnique);
    },
    storage: {
      from(bucketName: string) {
        const map = bucketFor(bucketName);
        return {
          async upload(path: string, data: Buffer | string, opts?: { contentType?: string; upsert?: boolean }) {
            const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as string, "base64");
            map.set(path, { data: buf, contentType: opts?.contentType ?? "application/octet-stream" });
            uploads.push({ bucket: bucketName, path, contentType: opts?.contentType, bytes: buf });
            return { data: { path }, error: null };
          },
          async download(path: string) {
            const entry = map.get(path);
            if (!entry) return { data: null, error: { message: `fake storage: not found ${bucketName}/${path}` } };
            return {
              data: {
                arrayBuffer: async () =>
                  entry.data.buffer.slice(entry.data.byteOffset, entry.data.byteOffset + entry.data.byteLength),
              },
              error: null,
            };
          },
          async createSignedUrl(path: string, expiresIn = 3600) {
            return { data: { signedUrl: `https://fake-signed.example/${bucketName}/${path}?exp=${expiresIn}` }, error: null };
          },
          async remove(paths: string[]) {
            for (const p of paths) map.delete(p);
            return { data: null, error: null };
          },
        };
      },
    },
    async rpc(name: string, args: Record<string, unknown> = {}) {
      const handler = rpcHandlers[name];
      if (!handler) throw new Error(`fake supabase: no rpc handler registered for "${name}"`);
      return { data: handler(args), error: null };
    },
    _tables: tables,
    _uploads: uploads,
    _registerRpc(name: string, handler: (args: Record<string, unknown>) => unknown) {
      rpcHandlers[name] = handler;
    },
  };
}
