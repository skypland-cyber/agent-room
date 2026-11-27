// A test-only stand-in for the Notion REST API (v1).
//
// The design's test plan (부록 §15) asks for a fake Notion reachable through an
// injected `fetch`, exactly the way this repository already fakes Upstash with
// `fakeRedis`. It models the parts of the API the office actually uses — the
// database/data source split of `2025-09-03` and later, `initial_data_source`
// on create, relations patched onto a data source, one row read per database —
// and it records every call so a test can assert *how* the workspace was built
// (no duplicate databases, relations in a second pass, `is_inline` respected)
// rather than only that it was.
//
// It is not a Notion emulator: filters only validate the property reference, and
// a row is a bag of properties. That is enough for Phase 1 and honest about it.
export interface FakeNotionOptions {
  rootPageId: string;
  /** Refuse `is_inline: true` with a 400, the way some accounts do. */
  failInline?: boolean;
}

interface FakeProperty {
  id: string;
  type: string;
  options?: string[];
}

interface FakeDataSource {
  id: string;
  databaseId: string;
  title: string;
  properties: Map<string, FakeProperty>;
}

interface FakeDatabase {
  id: string;
  title: string;
  dataSourceId: string;
  inline: boolean;
}

interface FakeBlock {
  id: string;
  type: string;
  title?: string;
  text?: string;
}

export interface FakeNotionCall {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  status: number;
}

interface ScriptedResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
  /**
   * Answer only a request whose path matches, leaving the queue in order for
   * the others. Phase 2 needs "this page read succeeds, that body read 404s"
   * and a plain FIFO queue cannot say that.
   */
  path?: RegExp;
}

type FakeInit = {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
};

function plainTitle(title: unknown): string {
  if (!Array.isArray(title)) return '';
  return title
    .map(item => {
      const text = (item as { text?: { content?: string } }).text;
      return typeof text?.content === 'string' ? text.content : '';
    })
    .join('');
}

function inferType(config: Record<string, unknown>): string {
  for (const key of ['title', 'rich_text', 'number', 'select', 'multi_select', 'date', 'url', 'checkbox', 'relation']) {
    if (key in config) return key;
  }
  return 'rich_text';
}

function errorBody(status: number, code: string, message: string): Record<string, unknown> {
  return { object: 'error', status, code, message };
}

export class FakeNotion {
  readonly rootPageId: string;
  failInline: boolean;
  readonly databases = new Map<string, FakeDatabase>();
  readonly dataSources = new Map<string, FakeDataSource>();
  readonly rows = new Map<string, Array<Record<string, unknown>>>();
  readonly blocks: FakeBlock[] = [];
  readonly calls: FakeNotionCall[] = [];
  /** Authorization headers seen, so a test can prove the token is used (not leaked). */
  readonly auth = new Set<string>();
  private queue: ScriptedResponse[] = [];
  private nextId = 1;

  constructor(options: FakeNotionOptions) {
    this.rootPageId = options.rootPageId;
    this.failInline = options.failInline ?? false;
  }

  /** Queue one scripted response in front of the real router (429, 529, …). */
  enqueue(response: ScriptedResponse): void {
    this.queue.push(response);
  }

  /** Queue a response for one path pattern, wherever it lands in the order. */
  enqueueFor(path: RegExp, response: Omit<ScriptedResponse, 'path'>): void {
    this.queue.push({ ...response, path });
  }

  databaseByTitle(title: string): FakeDatabase | undefined {
    for (const database of this.databases.values()) if (database.title === title) return database;
    return undefined;
  }

  dataSourceById(id: string): FakeDataSource | undefined {
    return this.dataSources.get(id);
  }

  /** Rename a property but keep its id — what a person does in the Notion UI. */
  renameProperty(dataSourceId: string, from: string, to: string): void {
    const dataSource = this.dataSources.get(dataSourceId);
    if (!dataSource) throw new Error(`No data source ${dataSourceId}`);
    const property = dataSource.properties.get(from);
    if (!property) throw new Error(`No property ${from}`);
    dataSource.properties.delete(from);
    dataSource.properties.set(to, property);
  }

  /** Seed one row (so a query has something to return). Returns its page id. */
  insertRow(dataSourceId: string, properties: Record<string, unknown> = {}): string {
    const dataSource = this.dataSources.get(dataSourceId);
    const id = `page_${this.nextId++}`;
    this.rows.set(dataSourceId, [
      ...(this.rows.get(dataSourceId) ?? []),
      this.rowPage(id, dataSourceId, properties, dataSource),
    ]);
    return id;
  }

  /**
   * What Notion answers for a row: properties keyed by **name**, each value
   * stamped with the property's id and type. The office reads through the id, so
   * a fake that omitted them would let a name-based implementation pass here and
   * fail in the workspace.
   */
  private rowPage(
    id: string,
    dataSourceId: string,
    properties: Record<string, unknown>,
    dataSource: FakeDataSource | undefined,
  ): Record<string, unknown> {
    const normalized: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(properties)) {
      const property = dataSource?.properties.get(name);
      const entry = value && typeof value === 'object' && !Array.isArray(value)
        ? { ...(value as Record<string, unknown>) }
        : {};
      if (property) {
        entry.id = property.id;
        entry.type = property.type;
      }
      normalized[name] = entry;
    }
    const now = new Date().toISOString();
    return {
      object: 'page',
      id,
      url: `https://app.notion.com/p/${id}`,
      created_time: now,
      last_edited_time: now,
      properties: normalized,
      parent: { type: 'data_source_id', data_source_id: dataSourceId },
    };
  }

  /** The row a page id names, for assertions about what a write actually stored. */
  rowProperties(pageId: string): Record<string, unknown> | undefined {
    return this.findRowPage(pageId)?.page.properties as Record<string, unknown> | undefined;
  }

  /** Seed a page body, for `GET /v1/pages/{id}/markdown`. */
  setMarkdown(pageId: string, markdown: string): void {
    this.markdown.set(pageId, markdown);
  }

  private readonly markdown = new Map<string, string>();

  created = (): FakeNotionCall[] => this.calls.filter(call => call.method === 'POST' && call.path === '/v1/databases');

  /** The `fetch` the Notion client is given in tests. */
  fetch = async (url: string, init?: FakeInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = new URL(url).pathname.replace(/\/$/, '');
    const authorization = init?.headers?.Authorization ?? init?.headers?.authorization;
    if (authorization) this.auth.add(authorization);
    let body: Record<string, unknown> | undefined;
    if (init?.body) {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = undefined;
      }
    }

    const scriptedIndex = this.queue.findIndex(entry => !entry.path || entry.path.test(path));
    const scripted = scriptedIndex >= 0 ? this.queue.splice(scriptedIndex, 1)[0] : undefined;
    if (scripted) {
      if (scripted.delayMs) await new Promise(resolve => setTimeout(resolve, scripted.delayMs));
      this.calls.push({ method, path, ...(body ? { body } : {}), status: scripted.status });
      return this.respond(
        scripted.status,
        scripted.body ?? errorBody(scripted.status, 'rate_limited', 'scripted response'),
        scripted.headers,
      );
    }

    const result = this.route(method, path, body);
    this.calls.push({ method, path, ...(body ? { body } : {}), status: result.status });
    return this.respond(result.status, result.payload);
  };

  private respond(status: number, payload: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  }

  private route(
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
  ): { status: number; payload: unknown } {
    const parts = path.split('/').filter(Boolean);
    if (parts[0] !== 'v1') return { status: 404, payload: errorBody(404, 'object_not_found', 'Not found') };
    const [, resource, id, ...rest] = parts;

    if (resource === 'pages' && method === 'GET' && rest[0] === 'markdown') {
      if (!id) return { status: 404, payload: errorBody(404, 'object_not_found', 'No page with that id') };
      if (!this.pageExists(id)) return { status: 404, payload: errorBody(404, 'object_not_found', 'No page with that id') };
      return {
        status: 200,
        payload: {
          object: 'page_markdown',
          id,
          markdown: this.markdown.get(id) ?? '',
          truncated: false,
          unknown_block_ids: [],
        },
      };
    }

    if (resource === 'pages' && method === 'POST' && rest.length === 0) {
      return this.createPage(body);
    }
    if (resource === 'pages' && method === 'PATCH' && id && rest.length === 0) {
      return this.updatePage(id, body);
    }

    if (resource === 'pages' && method === 'GET') {
      if (!id) return { status: 404, payload: errorBody(404, 'object_not_found', 'No page with that id') };
      if (id === this.rootPageId) {
        return {
          status: 200,
          payload: {
            object: 'page',
            id,
            url: `https://app.notion.com/p/${id}`,
            in_trash: false,
            properties: {},
          },
        };
      }
      const row = this.findRowPage(id);
      if (!row) {
        return { status: 404, payload: errorBody(404, 'object_not_found', 'No page with that id') };
      }
      return {
        status: 200,
        payload: {
          ...row.page,
          parent: { type: 'data_source_id', data_source_id: row.dataSourceId },
        },
      };
    }

    if (resource === 'blocks' && id && rest[0] === 'children') {
      if (id !== this.rootPageId) {
        return { status: 404, payload: errorBody(404, 'object_not_found', 'No block with that id') };
      }
      if (method === 'GET') {
        return {
          status: 200,
          payload: { object: 'list', results: this.blocks.map(block => this.blockPayload(block)), has_more: false },
        };
      }
      if (method === 'PATCH') {
        const children = Array.isArray(body?.children) ? body!.children as Array<Record<string, unknown>> : [];
        for (const child of children) {
          const paragraph = child.paragraph as { rich_text?: Array<{ text?: { content?: string } }> } | undefined;
          const text = (paragraph?.rich_text ?? []).map(item => item.text?.content ?? '').join('');
          this.blocks.push({ id: `block_${this.nextId++}`, type: 'paragraph', text });
        }
        return {
          status: 200,
          payload: { object: 'list', results: this.blocks.map(block => this.blockPayload(block)) },
        };
      }
      return { status: 405, payload: errorBody(405, 'invalid_request', 'Method not allowed') };
    }

    if (resource === 'databases' && method === 'POST') {
      return this.createDatabase(body);
    }
    if (resource === 'databases' && method === 'GET' && id) {
      const database = this.databases.get(id);
      if (!database) return { status: 404, payload: errorBody(404, 'object_not_found', 'No database') };
      return {
        status: 200,
        payload: {
          object: 'database',
          id: database.id,
          url: `https://app.notion.com/p/${database.id}`,
          data_sources: [{ id: database.dataSourceId, name: database.title }],
        },
      };
    }

    if (resource === 'data_sources' && id && rest.length === 0 && method === 'GET') {
      const dataSource = this.dataSources.get(id);
      if (!dataSource) return { status: 404, payload: errorBody(404, 'object_not_found', 'No data source') };
      return { status: 200, payload: this.dataSourcePayload(dataSource) };
    }
    if (resource === 'data_sources' && id && rest.length === 0 && method === 'PATCH') {
      return this.updateDataSource(id, body);
    }
    if (resource === 'data_sources' && id && rest[0] === 'query' && method === 'POST') {
      return this.queryDataSource(id, body);
    }

    return { status: 404, payload: errorBody(404, 'object_not_found', `Unhandled ${method} ${path}`) };
  }

  /** `POST /v1/pages` — a row inside one of the office's data sources. */
  private createPage(body: Record<string, unknown> | undefined): { status: number; payload: unknown } {
    if (!body) return { status: 400, payload: errorBody(400, 'validation_error', 'Body is required') };
    const parent = body.parent as { type?: string; data_source_id?: string; database_id?: string } | undefined;
    let dataSourceId = parent?.data_source_id;
    if (!dataSourceId && parent?.database_id) {
      // Notion also accepts the database id as a parent; the office uses the data
      // source, but a fake that refused the older form would be wrong.
      dataSourceId = this.databases.get(parent.database_id)?.dataSourceId;
    }
    const dataSource = dataSourceId ? this.dataSources.get(dataSourceId) : undefined;
    if (!dataSource) {
      return { status: 404, payload: errorBody(404, 'object_not_found', 'No data source for that parent') };
    }
    const properties = (body.properties ?? {}) as Record<string, unknown>;
    const invalid = Object.keys(properties).find(name => !this.propertyNameFor(dataSource, name));
    if (invalid) {
      return {
        status: 400,
        payload: errorBody(400, 'validation_error', `Could not find property ${invalid} in data source ${dataSource.id}`),
      };
    }
    const byName: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(properties)) {
      const real = this.propertyNameFor(dataSource, name);
      if (real) byName[real] = value;
    }
    const id = `page_${this.nextId++}`;
    this.rows.set(dataSource.id, [
      ...(this.rows.get(dataSource.id) ?? []),
      this.rowPage(id, dataSource.id, byName, dataSource),
    ]);
    return { status: 200, payload: this.rowPage(id, dataSource.id, byName, dataSource) };
  }

  /** `PATCH /v1/pages/{id}` — replace the properties given, keep the rest. */
  private updatePage(id: string, body: Record<string, unknown> | undefined): { status: number; payload: unknown } {
    const found = this.findRowPage(id);
    if (!found) return { status: 404, payload: errorBody(404, 'object_not_found', 'No page with that id') };
    const dataSource = this.dataSources.get(found.dataSourceId);
    if (!dataSource) return { status: 404, payload: errorBody(404, 'object_not_found', 'No data source') };
    const properties = (body?.properties ?? {}) as Record<string, unknown>;
    const invalid = Object.keys(properties).find(name => !this.propertyNameFor(dataSource, name));
    if (invalid) {
      return {
        status: 400,
        payload: errorBody(400, 'validation_error', `Could not find property ${invalid} in data source ${dataSource.id}`),
      };
    }
    const current = (found.page.properties ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = { ...current };
    for (const [name, value] of Object.entries(properties)) {
      const real = this.propertyNameFor(dataSource, name);
      const property = real ? dataSource.properties.get(real) : undefined;
      if (!real || !property) continue;
      next[real] = {
        ...(value && typeof value === 'object' ? value as Record<string, unknown> : {}),
        id: property.id,
        type: property.type,
      };
    }
    found.page.properties = next;
    found.page.last_edited_time = new Date().toISOString();
    return { status: 200, payload: found.page };
  }

  private findRowPage(id: string): { page: Record<string, unknown>; dataSourceId: string } | undefined {
    for (const [dataSourceId, rows] of this.rows) {
      const page = rows.find(row => row.id === id);
      if (page) return { page, dataSourceId };
    }
    return undefined;
  }

  private pageExists(id: string): boolean {
    return id === this.rootPageId || this.findRowPage(id) !== undefined;
  }

  private blockPayload(block: FakeBlock): Record<string, unknown> {
    if (block.type === 'child_database') {
      return {
        object: 'block',
        id: block.id,
        type: 'child_database',
        child_database: { title: block.title ?? '' },
      };
    }
    return {
      object: 'block',
      id: block.id,
      type: 'paragraph',
      paragraph: { rich_text: [{ plain_text: block.text ?? '', text: { content: block.text ?? '' } }] },
    };
  }

  private dataSourcePayload(dataSource: FakeDataSource): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    for (const [name, property] of dataSource.properties) {
      properties[name] = {
        id: property.id,
        name,
        type: property.type,
        ...(property.options ? { [property.type]: { options: property.options.map(option => ({ name: option })) } } : {}),
      };
    }
    return {
      object: 'data_source',
      id: dataSource.id,
      title: [{ plain_text: dataSource.title, text: { content: dataSource.title } }],
      parent: { type: 'database_id', database_id: dataSource.databaseId },
      properties,
    };
  }

  private createDatabase(body: Record<string, unknown> | undefined): { status: number; payload: unknown } {
    if (!body) return { status: 400, payload: errorBody(400, 'validation_error', 'Body is required') };
    if (body.is_inline === true && this.failInline) {
      return {
        status: 400,
        payload: errorBody(400, 'validation_error', 'is_inline is not supported for this workspace'),
      };
    }
    const parent = body.parent as { type?: string; page_id?: string } | undefined;
    if (parent?.type !== 'page_id' || parent.page_id !== this.rootPageId) {
      return {
        status: 400,
        payload: errorBody(400, 'validation_error', 'parent.page_id must be the root page this fake serves'),
      };
    }
    const title = plainTitle(body.title);
    if (!title) return { status: 400, payload: errorBody(400, 'validation_error', 'A title is required') };
    const source = body.initial_data_source as { properties?: Record<string, Record<string, unknown>> } | undefined;
    const definitions = source?.properties ?? {};
    if (!Object.values(definitions).some(config => 'title' in config)) {
      return { status: 400, payload: errorBody(400, 'validation_error', 'Exactly one title property is required') };
    }

    const databaseId = `db_${this.nextId++}`;
    const dataSourceId = `ds_${this.nextId++}`;
    const dataSource: FakeDataSource = { id: dataSourceId, databaseId, title, properties: new Map() };
    for (const [name, config] of Object.entries(definitions)) {
      const type = inferType(config);
      const select = (config[type] as { options?: Array<{ name?: string }> } | undefined)?.options;
      dataSource.properties.set(name, {
        id: `prop_${this.nextId++}`,
        type,
        ...(Array.isArray(select) ? { options: select.map(option => option.name ?? '').filter(Boolean) } : {}),
      });
    }
    this.dataSources.set(dataSourceId, dataSource);
    this.databases.set(databaseId, { id: databaseId, title, dataSourceId, inline: body.is_inline === true });
    // Notion gives the child_database block and the database the same id — a
    // database inside a page *is* that block. The fake honours that, because a
    // reader finding a database by listing the page's children depends on it.
    this.blocks.push({ id: databaseId, type: 'child_database', title });
    return {
      status: 200,
      payload: {
        object: 'database',
        id: databaseId,
        url: `https://app.notion.com/p/${databaseId}`,
        parent: { type: 'page_id', page_id: this.rootPageId },
        data_sources: [{ id: dataSourceId, name: title }],
      },
    };
  }

  private updateDataSource(
    id: string,
    body: Record<string, unknown> | undefined,
  ): { status: number; payload: unknown } {
    const dataSource = this.dataSources.get(id);
    if (!dataSource) return { status: 404, payload: errorBody(404, 'object_not_found', 'No data source') };
    const properties = (body?.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const [name, config] of Object.entries(properties)) {
      const type = inferType(config);
      if (type === 'relation') {
        const relation = config.relation as { data_source_id?: string } | undefined;
        if (!relation?.data_source_id || !this.dataSources.has(relation.data_source_id)) {
          return {
            status: 400,
            payload: errorBody(400, 'validation_error', `relation.${name} points at an unknown data source`),
          };
        }
      }
      const existing = dataSource.properties.get(name);
      if (existing) {
        existing.type = type;
        continue;
      }
      const select = (config[type] as { options?: Array<{ name?: string }> } | undefined)?.options;
      dataSource.properties.set(name, {
        id: `prop_${this.nextId++}`,
        type,
        ...(Array.isArray(select) ? { options: select.map(option => option.name ?? '').filter(Boolean) } : {}),
      });
    }
    return { status: 200, payload: this.dataSourcePayload(dataSource) };
  }

  private propertyNameFor(dataSource: FakeDataSource, key: string): string | undefined {
    if (dataSource.properties.has(key)) return key;
    for (const [name, property] of dataSource.properties) if (property.id === key) return name;
    return undefined;
  }

  /** The first property reference the filter names that the data source lacks. */
  private unknownProperty(dataSource: FakeDataSource, node: unknown): string | null {
    if (!node || typeof node !== 'object') return null;
    const entry = node as Record<string, unknown>;
    for (const group of ['and', 'or']) {
      const children = entry[group];
      if (Array.isArray(children)) {
        for (const child of children) {
          const bad = this.unknownProperty(dataSource, child);
          if (bad) return bad;
        }
      }
    }
    if (typeof entry.property === 'string' && !this.propertyNameFor(dataSource, entry.property)) {
      return entry.property;
    }
    return null;
  }

  private rowText(value: unknown): string {
    const entry = (value ?? {}) as Record<string, unknown>;
    const items = Array.isArray(entry.title) ? entry.title : Array.isArray(entry.rich_text) ? entry.rich_text : [];
    return (items as Array<Record<string, unknown>>)
      .map(item => String(item.plain_text ?? (item.text as Record<string, unknown> | undefined)?.content ?? ''))
      .join('');
  }

  private matchesRow(dataSource: FakeDataSource, row: Record<string, unknown>, node: unknown): boolean {
    if (!node || typeof node !== 'object') return true;
    const entry = node as Record<string, unknown>;
    if (Array.isArray(entry.and)) return entry.and.every(child => this.matchesRow(dataSource, row, child));
    if (Array.isArray(entry.or)) return entry.or.some(child => this.matchesRow(dataSource, row, child));
    const propertyName = typeof entry.property === 'string'
      ? this.propertyNameFor(dataSource, entry.property)
      : undefined;
    if (!propertyName) return true;
    const properties = (row.properties ?? {}) as Record<string, Record<string, unknown>>;
    const value = properties[propertyName] ?? {};
    /** The filter's own condition for one type — never the row's value. */
    const condition = (type: string): Record<string, unknown> => {
      const part = entry[type];
      return part && typeof part === 'object' ? part as Record<string, unknown> : {};
    };
    const contains = (haystack: string, needle: unknown): boolean =>
      typeof needle === 'string' && needle !== '' && haystack.toLowerCase().includes(needle.toLowerCase());

    for (const type of ['title', 'rich_text']) {
      if (entry[type]) {
        const text = this.rowText(value);
        const wanted = condition(type);
        if (typeof wanted.contains === 'string') return contains(text, wanted.contains);
        if (typeof wanted.equals === 'string') return text === wanted.equals;
        if (wanted.is_empty === true) return text.trim() === '';
        return true;
      }
    }
    if (entry.select) {
      const name = (value.select as { name?: string } | undefined)?.name;
      const wanted = (entry.select as { equals?: string }).equals;
      return wanted === undefined ? true : name === wanted;
    }
    if (entry.multi_select) {
      const wanted = (entry.multi_select as { contains?: string }).contains;
      const names = ((value.multi_select ?? []) as Array<{ name?: string }>).map(option => option.name ?? '');
      return wanted === undefined ? true : names.some(name => name.toLowerCase() === wanted.toLowerCase());
    }
    if (entry.date) {
      const start = ((value.date as { start?: string } | undefined)?.start) ?? '';
      const condition_ = entry.date as { on_or_after?: string; before?: string; equals?: string };
      if (typeof condition_.on_or_after === 'string') return start >= condition_.on_or_after;
      if (typeof condition_.before === 'string') return start < condition_.before;
      if (typeof condition_.equals === 'string') return start.slice(0, 10) === condition_.equals;
      return true;
    }
    if (entry.checkbox) {
      return (value.checkbox === true) === (entry.checkbox as { equals?: boolean }).equals;
    }
    if (entry.number) {
      const wanted = (entry.number as { equals?: number }).equals;
      return wanted === undefined ? true : value.number === wanted;
    }
    return true;
  }

  private sortValue(row: Record<string, unknown>, propertyName: string): string | number {
    const properties = (row.properties ?? {}) as Record<string, Record<string, unknown>>;
    const value = properties[propertyName] ?? {};
    const date = (value.date as { start?: string } | undefined)?.start;
    if (typeof date === 'string') return Date.parse(date) || 0;
    const number = value.number;
    if (typeof number === 'number') return number;
    return this.rowText(value);
  }

  private queryDataSource(
    id: string,
    body: Record<string, unknown> | undefined,
  ): { status: number; payload: unknown } {
    const dataSource = this.dataSources.get(id);
    if (!dataSource) return { status: 404, payload: errorBody(404, 'object_not_found', 'No data source') };
    const unknown = this.unknownProperty(dataSource, body?.filter);
    if (unknown) {
      return {
        status: 400,
        payload: errorBody(
          400,
          'validation_error',
          `Could not find property ${unknown} in data source ${id}`,
        ),
      };
    }
    const all = (this.rows.get(id) ?? []).filter(row => this.matchesRow(dataSource, row, body?.filter));
    const sorts = Array.isArray(body?.sorts) ? body!.sorts as Array<{ property?: string; direction?: string }> : [];
    const sorted = sorts.length === 0 ? all : [...all].sort((left, right) => {
      for (const sort of sorts) {
        const propertyName = sort.property ? this.propertyNameFor(dataSource, sort.property) : undefined;
        if (!propertyName) continue;
        const a = this.sortValue(left, propertyName);
        const b = this.sortValue(right, propertyName);
        if (a === b) continue;
        const order = a > b ? 1 : -1;
        return sort.direction === 'ascending' ? order : -order;
      }
      return 0;
    });
    const pageSize = typeof body?.page_size === 'number' ? body.page_size as number : 100;
    const limit = Math.max(0, Math.min(100, pageSize));
    return {
      status: 200,
      payload: {
        object: 'list',
        results: sorted.slice(0, limit),
        has_more: sorted.length > limit,
        next_cursor: null,
      },
    };
  }
}
