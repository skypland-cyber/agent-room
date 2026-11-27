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

  /** Seed one row (so a query has something to return). */
  insertRow(dataSourceId: string, properties: Record<string, unknown> = {}): void {
    const rows = this.rows.get(dataSourceId) ?? [];
    rows.push({ object: 'page', id: `page_${this.nextId++}`, properties });
    this.rows.set(dataSourceId, rows);
  }

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

    const scripted = this.queue.shift();
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

    if (resource === 'pages' && method === 'GET') {
      if (!id || id !== this.rootPageId) {
        return { status: 404, payload: errorBody(404, 'object_not_found', 'No page with that id') };
      }
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

  private queryDataSource(
    id: string,
    body: Record<string, unknown> | undefined,
  ): { status: number; payload: unknown } {
    const dataSource = this.dataSources.get(id);
    if (!dataSource) return { status: 404, payload: errorBody(404, 'object_not_found', 'No data source') };
    const filter = body?.filter as { property?: string } | undefined;
    if (filter?.property) {
      const known = dataSource.properties.has(filter.property)
        || [...dataSource.properties.values()].some(property => property.id === filter.property);
      if (!known) {
        return {
          status: 400,
          payload: errorBody(
            400,
            'validation_error',
            `Could not find property ${filter.property} in data source ${id}`,
          ),
        };
      }
    }
    const all = this.rows.get(id) ?? [];
    const pageSize = typeof body?.page_size === 'number' ? body.page_size as number : 100;
    return {
      status: 200,
      payload: {
        object: 'list',
        results: all.slice(0, Math.max(0, Math.min(100, pageSize))),
        has_more: all.length > pageSize,
        next_cursor: null,
      },
    };
  }
}
