// The eight Notion databases the office keeps its long-term memory in.
//
// This module is the whole of Phase 1's schema work: the definitions (what a
// row may contain), the producer that builds them under the root page, the
// verification that proves they are readable, and the repair pass that puts back
// what a person deleted. Everything is expressed so that later phases can stay
// inside Notion's free plan:
//
//   * a row is a page, and a page is one block — the eight databases themselves
//     are nine blocks (root + eight), once. Nothing here writes body blocks into
//     a row.
//   * properties are addressed by **id**, never by name. A person renaming
//     "요약" to "한 줄 요약" must not break the sync, so the schema cache stores
//     `name → id` and `id → name` and the code reads through the ids.
//   * relations are created in a second pass, because a relation needs the
//     target's data source id and that only exists once the target has been
//     created. Two passes also mean a half-built workspace can be finished by
//     running bootstrap again: existing databases are reused, never duplicated.
//   * `select` options are created up front — a sync that invents a new option
//     at write time behaves differently per account.
import type { UpstashClient } from '@agent-room/upstash-client';
import {
  NOTION_API_VERSION,
  NOTION_SCHEMA_KEY,
  NotionError,
  notionConfig,
  type NotionBlock,
  type NotionCallStats,
  type NotionClient,
  type NotionDataSource,
  type NotionDatabase,
} from './client.js';

// ─── 1. The definitions (§4.2 + 부록 A) ────────────────────────────────────

export type NotionDbKey =
  | 'projects'
  | 'staff'
  | 'meetings'
  | 'reports'
  | 'products'
  | 'finance'
  | 'deliverables'
  | 'knowledge';

export type NotionScalarType =
  | 'title'
  | 'rich_text'
  | 'number'
  | 'select'
  | 'multi_select'
  | 'date'
  | 'url'
  | 'checkbox';

export interface NotionPropertyDef {
  name: string;
  type: NotionScalarType | 'relation';
  /** Select / multi-select options, created up front. */
  options?: readonly string[];
  /** Number format: plain, 원, or percent (stored as 0.05 for 5%). */
  format?: 'number' | 'won' | 'percent';
  /** For `relation`: the database it points at. */
  relation?: NotionDbKey;
  /**
   * Who owns the value. `system` properties are overwritten by the sync,
   * `human` ones never are, and no value means both (Phase 3's conflict rules
   * read this field).
   */
  owner?: 'system' | 'human';
}

export interface NotionDbDef {
  key: NotionDbKey;
  title: string;
  /** The idempotency key property, or null for the ledger (부록 A). */
  keyProperty: string | null;
  properties: readonly NotionPropertyDef[];
}

/** 부록 A: the logical key ↔ human title map, as one exported constant. */
export const NOTION_DB = {
  projects: { title: '📊 프로젝트', key: 'Office ID' },
  staff: { title: '🧑‍💻 AI 직원 매뉴얼', key: 'Office ID' },
  meetings: { title: '🗣 회의록', key: 'Archive ID' },
  reports: { title: '📈 보고서', key: '범위 키' },
  products: { title: '📦 디지털 상품', key: '상품 코드' },
  finance: { title: '💰 재무 장부', key: null },
  deliverables: { title: '🗂 결과물', key: '파일 ID' },
  knowledge: { title: '🧠 지식 베이스', key: '키' },
} as const;

const AI_STAFF = ['망고', 'Codex', 'ChatGPT', 'Claude', 'Gemini', 'Aside'] as const;
const SALES_CHANNELS = ['크몽', '스마트스토어', '텀블벅', 'Gumroad', '직접 판매', '기타'] as const;

export const NOTION_DATABASES: readonly NotionDbDef[] = [
  {
    key: 'projects',
    title: NOTION_DB.projects.title,
    keyProperty: NOTION_DB.projects.key,
    properties: [
      { name: '프로젝트', type: 'title' },
      { name: '상태', type: 'select', options: ['진행 중', '보류', '완료', '보관'] },
      { name: '한 줄 설명', type: 'rich_text' },
      { name: '담당 AI', type: 'multi_select', options: AI_STAFF },
      { name: '회의', type: 'relation', relation: 'meetings' },
      { name: '결과물', type: 'relation', relation: 'deliverables' },
      { name: '상품', type: 'relation', relation: 'products' },
      { name: '지식', type: 'relation', relation: 'knowledge' },
      { name: '열린 업무', type: 'number', owner: 'system' },
      { name: '완료 업무', type: 'number', owner: 'system' },
      { name: '최근 활동', type: 'date', owner: 'system' },
      { name: NOTION_DB.projects.key, type: 'rich_text', owner: 'system' },
      { name: '동기화', type: 'date', owner: 'system' },
    ],
  },
  {
    key: 'staff',
    title: NOTION_DB.staff.title,
    keyProperty: NOTION_DB.staff.key,
    properties: [
      { name: '직원', type: 'title' },
      // The roster fields are mirrored by the system; the four manual fields
      // below them are the person's own words and are never overwritten.
      { name: '역할', type: 'rich_text' },
      { name: '담당 태그', type: 'multi_select' },
      { name: '일일 업무 한도', type: 'number', owner: 'system' },
      { name: '기본 브리프', type: 'rich_text', owner: 'system' },
      { name: '업무 원칙', type: 'rich_text', owner: 'human' },
      { name: '금지 사항', type: 'rich_text', owner: 'human' },
      { name: '출력 형식', type: 'rich_text', owner: 'human' },
      { name: '도구 사용', type: 'rich_text', owner: 'human' },
      { name: '활성', type: 'checkbox', owner: 'system' },
      { name: NOTION_DB.staff.key, type: 'rich_text', owner: 'system' },
      { name: '매뉴얼 갱신', type: 'date', owner: 'human' },
    ],
  },
  {
    key: 'meetings',
    title: NOTION_DB.meetings.title,
    keyProperty: NOTION_DB.meetings.key,
    properties: [
      { name: '회의', type: 'title' },
      { name: '회의 코드', type: 'rich_text', owner: 'system' },
      { name: '일시', type: 'date', owner: 'system' },
      { name: '종료', type: 'date', owner: 'system' },
      { name: '참석자', type: 'multi_select', owner: 'system' },
      { name: '프로젝트', type: 'relation', relation: 'projects' },
      { name: '요약', type: 'rich_text', owner: 'system' },
      { name: '결정', type: 'rich_text', owner: 'system' },
      { name: '결과', type: 'rich_text', owner: 'system' },
      { name: '할 일', type: 'rich_text', owner: 'system' },
      { name: '업무 현황', type: 'rich_text', owner: 'system' },
      { name: '회의록 전문', type: 'rich_text', owner: 'system' },
      { name: '메시지 수', type: 'number', owner: 'system' },
      { name: NOTION_DB.meetings.key, type: 'rich_text', owner: 'system' },
      { name: '상태', type: 'select', options: ['진행 중', '종료', '만료'], owner: 'system' },
      { name: '지식', type: 'relation', relation: 'knowledge' },
      { name: '결과물', type: 'relation', relation: 'deliverables' },
      { name: 'Office 링크', type: 'url', owner: 'system' },
    ],
  },
  {
    key: 'reports',
    title: NOTION_DB.reports.title,
    keyProperty: NOTION_DB.reports.key,
    properties: [
      { name: '보고서', type: 'title' },
      { name: '종류', type: 'select', options: ['일일', '주간', '월간', '특별'], owner: 'system' },
      { name: '기간 시작', type: 'date', owner: 'system' },
      { name: '기간 종료', type: 'date', owner: 'system' },
      { name: '요약', type: 'rich_text', owner: 'system' },
      { name: '완료', type: 'number', owner: 'system' },
      { name: '진행', type: 'number', owner: 'system' },
      { name: '대기', type: 'number', owner: 'system' },
      { name: '실패', type: 'number', owner: 'system' },
      { name: '매출', type: 'number', format: 'won', owner: 'system' },
      { name: '비용', type: 'number', format: 'won', owner: 'system' },
      { name: '순익', type: 'number', format: 'won', owner: 'system' },
      { name: '주요 내용', type: 'rich_text', owner: 'system' },
      { name: '다음 계획', type: 'rich_text', owner: 'system' },
      { name: '경고', type: 'rich_text', owner: 'system' },
      { name: '프로젝트', type: 'relation', relation: 'projects' },
      { name: '발행', type: 'date', owner: 'system' },
      { name: NOTION_DB.reports.key, type: 'rich_text', owner: 'system' },
    ],
  },
  {
    key: 'products',
    title: NOTION_DB.products.title,
    keyProperty: NOTION_DB.products.key,
    properties: [
      { name: '상품', type: 'title' },
      { name: NOTION_DB.products.key, type: 'rich_text' },
      { name: '상태', type: 'select', options: ['기획', '제작', '검수', '판매 중', '중단'] },
      { name: '가격', type: 'number', format: 'won' },
      { name: '판매 채널', type: 'multi_select', options: SALES_CHANNELS },
      { name: '판매 페이지', type: 'url' },
      { name: '구성', type: 'rich_text' },
      { name: '제작 자료', type: 'relation', relation: 'deliverables' },
      { name: '프로젝트', type: 'relation', relation: 'projects' },
      { name: '누적 판매', type: 'number', owner: 'system' },
      { name: '누적 매출', type: 'number', format: 'won', owner: 'system' },
      { name: '누적 순익', type: 'number', format: 'won', owner: 'system' },
      { name: '정산 주기', type: 'select', options: ['즉시', 'D+7', '월 정산'] },
      { name: '출시일', type: 'date' },
      { name: '메모', type: 'rich_text' },
    ],
  },
  {
    key: 'finance',
    title: NOTION_DB.finance.title,
    keyProperty: NOTION_DB.finance.key,
    properties: [
      { name: '거래', type: 'title' },
      { name: '일자', type: 'date' },
      {
        name: '구분',
        type: 'select',
        options: ['매출', '플랫폼 수수료', '결제 수수료', '환불', '광고비', '도구 구독', '기타 비용', '정산 입금'],
      },
      { name: '상품', type: 'relation', relation: 'products' },
      { name: '채널', type: 'select', options: SALES_CHANNELS },
      { name: '거래액', type: 'number', format: 'won' },
      { name: '수수료율', type: 'number', format: 'percent' },
      // The two below are computed by the server, never typed (수수료 = 거래액 × 수수료율).
      { name: '수수료', type: 'number', format: 'won', owner: 'system' },
      { name: '실수령', type: 'number', format: 'won', owner: 'system' },
      { name: '통화', type: 'select', options: ['KRW', 'USD'] },
      { name: '정산 예정일', type: 'date' },
      { name: '정산 상태', type: 'select', options: ['예정', '완료', '보류'] },
      { name: '증빙', type: 'relation', relation: 'deliverables' },
      { name: '비고', type: 'rich_text' },
    ],
  },
  {
    key: 'deliverables',
    title: NOTION_DB.deliverables.title,
    keyProperty: NOTION_DB.deliverables.key,
    properties: [
      { name: '결과물', type: 'title' },
      { name: NOTION_DB.deliverables.key, type: 'rich_text', owner: 'system' },
      {
        name: '종류',
        type: 'select',
        options: ['문서', '스프레드시트', 'PDF', '이미지', '영상', '코드', '압축', '데이터', '기타'],
        owner: 'system',
      },
      { name: '크기', type: 'number', owner: 'system' },
      { name: '버전', type: 'number', owner: 'system' },
      { name: '프로젝트', type: 'relation', relation: 'projects' },
      { name: '회의', type: 'relation', relation: 'meetings' },
      { name: '상품', type: 'relation', relation: 'products' },
      { name: '업무', type: 'rich_text', owner: 'system' },
      { name: '작성 AI', type: 'select', options: ['owner', ...AI_STAFF], owner: 'system' },
      // Never a signed URL: it expires in 15–30 minutes. The id plus this stable
      // `/office` deep link is what stays true.
      { name: '열기', type: 'url', owner: 'system' },
      { name: '보관 위치', type: 'rich_text', owner: 'system' },
      { name: '설명', type: 'rich_text', owner: 'human' },
      { name: '생성', type: 'date', owner: 'system' },
      { name: '갱신', type: 'date', owner: 'system' },
      { name: '보존', type: 'select', options: ['결과물', '삭제됨'], owner: 'system' },
    ],
  },
  {
    key: 'knowledge',
    title: NOTION_DB.knowledge.title,
    keyProperty: NOTION_DB.knowledge.key,
    properties: [
      { name: '지식', type: 'title' },
      {
        name: '유형',
        type: 'select',
        options: ['사실', '결정', '교훈', '절차', '사양', '용어', '인물·관계', '실패사례'],
      },
      { name: '프로젝트', type: 'relation', relation: 'projects' },
      { name: '프로젝트명', type: 'rich_text', owner: 'system' },
      { name: '태그', type: 'multi_select' },
      { name: '내용', type: 'rich_text' },
      // A denormalised search corpus: Notion can filter rich_text but not a
      // row's body, so the keywords live in a property and search costs one call.
      { name: '키워드', type: 'rich_text', owner: 'system' },
      { name: '출처', type: 'select', options: ['회의', '결과물', '매뉴얼', '사용자', 'AI 정리', '외부'] },
      { name: '출처 참조', type: 'rich_text', owner: 'system' },
      { name: '검증', type: 'select', options: ['초안', '확인됨', '폐기'] },
      { name: '작성', type: 'select', options: ['owner', ...AI_STAFF], owner: 'system' },
      { name: NOTION_DB.knowledge.key, type: 'rich_text', owner: 'system' },
      { name: '최초 작성', type: 'date', owner: 'system' },
      { name: '최근 갱신', type: 'date', owner: 'system' },
      { name: '중요도', type: 'select', options: ['상', '중', '하'] },
      { name: '변경 이력', type: 'rich_text', owner: 'system' },
    ],
  },
];

/** The definitions keyed by logical name. */
export const NOTION_DATABASE_BY_KEY: Record<NotionDbKey, NotionDbDef> = Object.fromEntries(
  NOTION_DATABASES.map(def => [def.key, def]),
) as Record<NotionDbKey, NotionDbDef>;

/** Property request payload for one definition (no relations — pass 1). */
export function notionPropertyPayload(def: NotionPropertyDef): Record<string, unknown> {
  switch (def.type) {
    case 'title':
      return { title: {} };
    case 'rich_text':
      return { rich_text: {} };
    case 'number':
      return { number: { format: def.format ?? 'number' } };
    case 'select':
      return { select: { options: (def.options ?? []).map(name => ({ name })) } };
    case 'multi_select':
      return { multi_select: { options: (def.options ?? []).map(name => ({ name })) } };
    case 'date':
      return { date: {} };
    case 'url':
      return { url: {} };
    case 'checkbox':
      return { checkbox: {} };
    default:
      throw new NotionError(`Unknown property type "${String(def.type)}".`, 'notion_invalid_request', 400);
  }
}

/**
 * A one-way relation.
 *
 * `dual_property` would add a column to the *target* database, and that column
 * then becomes another thing to sync — the design keeps relations single
 * property on purpose (§4.3).
 */
export function notionRelationPayload(dataSourceId: string): Record<string, unknown> {
  return { relation: { data_source_id: dataSourceId, type: 'single_property', single_property: {} } };
}

// ─── 2. The schema cache ──────────────────────────────────────────────────

export interface NotionDbCache {
  key: NotionDbKey;
  title: string;
  databaseId: string;
  dataSourceId: string;
  /** true when Notion accepted `is_inline` (inside the root page's body). */
  inline: boolean;
  keyProperty: string | null;
  /** Property name → property id. The sync writes through these. */
  properties: Record<string, string>;
  /** Property name → Notion type, to catch a hand-edit that changed the type. */
  types: Record<string, string>;
  /** Property id → current name (a person may rename it; the id is the truth). */
  names: Record<string, string>;
  /** Relation property name → target data source id. */
  relations: Record<string, string>;
  updatedAt: number;
}

export interface NotionSchemaCache {
  version: 1;
  apiVersion: string;
  rootPageId: string;
  createdAt: number;
  updatedAt: number;
  databases: Partial<Record<NotionDbKey, NotionDbCache>>;
  /** What the bootstrap wrote into the root page, for idempotency. */
  guideWritten?: boolean;
}

/** Read the cache. A missing or unreadable value is "no cache", never a crash. */
export async function loadNotionSchema(store: UpstashClient): Promise<NotionSchemaCache | null> {
  const raw = await store.command<string | null>(['GET', NOTION_SCHEMA_KEY]).catch(() => null);
  if (typeof raw !== 'string' || !raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const cache = parsed as NotionSchemaCache;
  if (cache.version !== 1) return null;
  if (!cache.databases || typeof cache.databases !== 'object') return null;
  if (typeof cache.rootPageId !== 'string' || !cache.rootPageId) return null;
  return cache;
}

/** Store the cache. No TTL: it is a map of ids, not data that can go stale by age. */
export async function saveNotionSchema(store: UpstashClient, schema: NotionSchemaCache): Promise<void> {
  await store.command(['SET', NOTION_SCHEMA_KEY, JSON.stringify(schema)]);
}

// ─── 3. Bootstrap ─────────────────────────────────────────────────────────

const GUIDE_MARKER = '[AI 사무실]';
const GUIDE_PARAGRAPHS = [
  `${GUIDE_MARKER} 이 페이지 아래에는 AI 사무실 자료만 두세요. Notion 연결은 이 페이지와 그 하위 페이지를 함께 볼 수 있습니다.`,
  `${GUIDE_MARKER} 무료 플랜은 평생 블록 한도가 있습니다. 시스템은 행 하나(블록 하나)만 만들고 본문 블록은 쓰지 않습니다.`,
  `${GUIDE_MARKER} 동기화는 NOTION_SYNC_MODE로 켭니다(off · meta · full). off이면 Notion을 전혀 호출하지 않습니다.`,
];

interface RegistryEntry {
  databaseId: string;
  dataSourceId: string;
  inline: boolean;
  created: boolean;
}

export interface BootstrapOptions {
  client: NotionClient;
  store: UpstashClient;
  rootPageId: string;
  /** `NOTION_DB_MAP`: adopt an existing data source instead of creating one. */
  dbMap?: Record<string, string>;
  now?: number;
}

export interface BootstrapResult {
  ok: true;
  rootPageId: string;
  databases: number;
  created: NotionDbKey[];
  reused: NotionDbKey[];
  /** `"meetings:프로젝트"` for every property added in the second pass. */
  patched: string[];
  inlineFallback: NotionDbKey[];
  properties: number;
  rowsSeed: 'deferred';
  guide: 'written' | 'present' | 'skipped';
  warnings: string[];
  calls: NotionCallStats;
  schema: NotionSchemaCache;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function blockTitle(block: NotionBlock): string {
  if (block.type === 'child_database') return textOf(block.child_database?.title);
  if (block.type === 'child_page') return textOf(block.child_page?.title);
  return '';
}

function plainTextOf(block: NotionBlock): string {
  const rich = block.paragraph?.rich_text ?? [];
  return rich.map(item => textOf(item.plain_text) || textOf(item.text?.content)).join('');
}

/** Root page access first: everything else is pointless without it. */
async function requireRootPage(client: NotionClient, rootPageId: string): Promise<void> {
  try {
    const page = await client.retrievePage(rootPageId);
    if (page.in_trash === true || page.archived === true) {
      throw new NotionError(
        'The Notion root page is in the trash. Restore it, or point NOTION_ROOT_PAGE_ID at a live page.',
        'notion_not_found',
        404,
      );
    }
  } catch (error) {
    const failure = error instanceof NotionError ? error : null;
    if (failure && (failure.code === 'notion_not_found' || failure.code === 'notion_forbidden')) {
      // Both answers are the same mistake from the person's side: the connection
      // was not added to this page, or the id is wrong. Say both.
      throw new NotionError(
        'The Notion connection cannot see the root page. Add the connection to that page in Notion, '
          + 'and check that NOTION_ROOT_PAGE_ID is the page id (32 characters).',
        failure.code === 'notion_forbidden' ? 'notion_forbidden' : 'notion_not_found',
        failure.status,
      );
    }
    throw error;
  }
}

async function rootChildren(client: NotionClient, rootPageId: string): Promise<NotionBlock[]> {
  const page = await client.listBlockChildren(rootPageId, 100);
  return Array.isArray(page.results) ? page.results : [];
}

async function dataSourceIdOfDatabase(client: NotionClient, databaseId: string): Promise<string> {
  const database = await client.retrieveDatabase(databaseId);
  const id = database.data_sources?.[0]?.id;
  if (!id) {
    throw new NotionError(
      `Notion database ${databaseId} reports no data source. Recreate it with the current API version.`,
      'notion_unavailable',
      502,
    );
  }
  return id;
}

function databaseIds(database: NotionDatabase): { databaseId: string; dataSourceId: string } {
  const dataSourceId = database.data_sources?.[0]?.id;
  if (!database.id || !dataSourceId) {
    throw new NotionError(
      'Notion answered a database creation without a data source id; the API version and the SDK may disagree.',
      'notion_unavailable',
      502,
    );
  }
  return { databaseId: database.id, dataSourceId };
}

/**
 * Create one database inside the root page.
 *
 * `is_inline: true` keeps it in the page body (nine blocks total) instead of
 * pushing eight child pages into the sidebar. Accounts and API versions differ
 * on whether inline is allowed, so a 400 that names `is_inline` is retried as a
 * child page — same data, one block each, and the result records which form was
 * used.
 */
async function createDatabase(
  client: NotionClient,
  rootPageId: string,
  def: NotionDbDef,
): Promise<{ databaseId: string; dataSourceId: string; inline: boolean }> {
  const properties: Record<string, unknown> = {};
  for (const property of def.properties) {
    if (property.type === 'relation') continue;
    properties[property.name] = notionPropertyPayload(property);
  }
  const body: Record<string, unknown> = {
    parent: { type: 'page_id', page_id: rootPageId },
    title: [{ type: 'text', text: { content: def.title } }],
    is_inline: true,
    initial_data_source: { properties },
  };
  try {
    const created = await client.createDatabase(body);
    return { ...databaseIds(created), inline: true };
  } catch (error) {
    const failure = error instanceof NotionError ? error : null;
    const inlineRefused = failure?.code === 'notion_invalid_request' && /is[ _]inline/i.test(failure.message);
    if (!inlineRefused) throw error;
    delete body.is_inline;
    const created = await client.createDatabase(body);
    return { ...databaseIds(created), inline: false };
  }
}

/**
 * Make one data source match its definition, then read the ids back.
 *
 * Pass 2 of the design: relations are added here (their targets now exist),
 * a database that a person adopted has any property they deleted put back, and
 * the `name → id`, `id → name` maps are captured. Two rounds at most: the first
 * adds what is missing, the second only exists because a creation can surprise
 * us, and a third round would mean the workspace is fighting the schema.
 */
async function ensureDataSource(
  client: NotionClient,
  def: NotionDbDef,
  entry: RegistryEntry,
  registry: Map<NotionDbKey, RegistryEntry>,
  patched: string[],
): Promise<NotionDataSource> {
  let dataSource = entry.created ? null : await client.retrieveDataSource(entry.dataSourceId);
  for (let round = 0; round < 2; round += 1) {
    const present = new Set(Object.keys(dataSource?.properties ?? {}));
    const wanted = def.properties.filter(property =>
      entry.created && round === 0 ? property.type === 'relation' : !present.has(property.name));
    if (wanted.length === 0) break;
    const properties: Record<string, unknown> = {};
    for (const property of wanted) {
      if (property.type === 'relation') {
        const targetKey = property.relation;
        const target = targetKey ? registry.get(targetKey) : undefined;
        if (!target) {
          throw new NotionError(
            `Relation "${def.key}.${property.name}" points at "${String(targetKey)}", which was not built.`,
            'notion_unavailable',
            502,
          );
        }
        properties[property.name] = notionRelationPayload(target.dataSourceId);
      } else {
        properties[property.name] = notionPropertyPayload(property);
      }
    }
    await client.updateDataSource(entry.dataSourceId, properties);
    patched.push(...wanted.map(property => `${def.key}:${property.name}`));
    dataSource = await client.retrieveDataSource(entry.dataSourceId);
  }
  return dataSource ?? await client.retrieveDataSource(entry.dataSourceId);
}

function cacheEntry(def: NotionDbDef, entry: RegistryEntry, dataSource: NotionDataSource, now: number): NotionDbCache {
  const properties: Record<string, string> = {};
  const types: Record<string, string> = {};
  const names: Record<string, string> = {};
  for (const [name, property] of Object.entries(dataSource.properties ?? {})) {
    if (!property?.id) continue;
    properties[name] = property.id;
    types[name] = property.type;
    names[property.id] = name;
  }
  const relations: Record<string, string> = {};
  for (const property of def.properties) {
    if (property.type === 'relation' && property.relation && properties[property.name]) {
      relations[property.name] = property.relation;
    }
  }
  return {
    key: def.key,
    title: def.title,
    databaseId: entry.databaseId,
    dataSourceId: entry.dataSourceId,
    inline: entry.inline,
    keyProperty: def.keyProperty,
    properties,
    types,
    names,
    relations,
    updatedAt: now,
  };
}

/** Write the three orientation paragraphs once, so the root page explains itself. */
async function writeGuide(client: NotionClient, rootPageId: string, children: NotionBlock[]): Promise<'written' | 'present'> {
  const already = children.some(block => plainTextOf(block).includes(GUIDE_MARKER));
  if (already) return 'present';
  await client.appendBlockChildren(rootPageId, GUIDE_PARAGRAPHS.map(content => ({
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content } }] },
  })));
  return 'written';
}

/**
 * Build (or finish building) the eight databases under the root page.
 *
 * Idempotent by construction: the root page's own children are read first, a
 * database whose title already exists is reused, relations are patched rather
 * than recreated, and the property ids are re-read every run. Running this
 * twice therefore creates nothing the second time — which is the property the
 * tests pin down.
 *
 * Row seeding (staff manuals, the first product) is deliberately *not* here:
 * without Phase 3's idempotency map (`notion:v1:link`) a seed would either
 * duplicate on every run or need a query per agent, and Phase 1's contract is
 * the schema, not the rows. `rowsSeed: 'deferred'` says so out loud.
 */
export async function bootstrapNotion(options: BootstrapOptions): Promise<BootstrapResult> {
  const { client, store, rootPageId } = options;
  const config = notionConfig();
  const dbMap = options.dbMap ?? config.dbMap;
  const now = options.now ?? Date.now();
  const warnings: string[] = [];
  const created: NotionDbKey[] = [];
  const reused: NotionDbKey[] = [];
  const patched: string[] = [];
  const inlineFallback: NotionDbKey[] = [];
  const registry = new Map<NotionDbKey, RegistryEntry>();

  await requireRootPage(client, rootPageId);
  const children = await rootChildren(client, rootPageId);
  const byTitle = new Map<string, NotionBlock>();
  for (const block of children) {
    const title = blockTitle(block).toLowerCase();
    if (title && !byTitle.has(title)) byTitle.set(title, block);
  }
  const knownTitles = new Set(NOTION_DATABASES.map(def => def.title.toLowerCase()));
  for (const block of children) {
    const title = blockTitle(block);
    if (title && !knownTitles.has(title.toLowerCase())) {
      warnings.push(`Unexpected database "${title}" sits under the root page; it is left alone.`);
    }
  }

  const cached = await loadNotionSchema(store);
  const cachedFor = (key: NotionDbKey): NotionDbCache | undefined =>
    cached && cached.rootPageId === rootPageId ? cached.databases[key] : undefined;

  // Pass 1 — containers only. A creation is the only call that can duplicate a
  // database, so it happens only when the title is genuinely absent.
  for (const def of NOTION_DATABASES) {
    const mapped = dbMap[def.key];
    if (mapped) {
      const cachedEntry = cachedFor(def.key);
      registry.set(def.key, {
        databaseId: cachedEntry?.dataSourceId === mapped ? cachedEntry.databaseId : '',
        dataSourceId: mapped,
        inline: cachedEntry?.inline ?? true,
        created: false,
      });
      reused.push(def.key);
      continue;
    }
    const existing = byTitle.get(def.title.toLowerCase());
    if (existing) {
      const cachedEntry = cachedFor(def.key);
      const databaseId = existing.id;
      const dataSourceId = cachedEntry && cachedEntry.databaseId === databaseId
        ? cachedEntry.dataSourceId
        : await dataSourceIdOfDatabase(client, databaseId);
      registry.set(def.key, {
        databaseId,
        dataSourceId,
        inline: cachedEntry?.inline ?? existing.type === 'child_database',
        created: false,
      });
      reused.push(def.key);
      continue;
    }
    const built = await createDatabase(client, rootPageId, def);
    registry.set(def.key, { ...built, created: true });
    created.push(def.key);
    if (!built.inline) inlineFallback.push(def.key);
  }

  // Pass 2 — relations, repairs and the property-id maps.
  const nextSchema: NotionSchemaCache = {
    version: 1,
    apiVersion: client.apiVersion || NOTION_API_VERSION,
    rootPageId,
    createdAt: cached && cached.rootPageId === rootPageId ? cached.createdAt : now,
    updatedAt: now,
    databases: {},
  };
  for (const def of NOTION_DATABASES) {
    const entry = registry.get(def.key);
    if (!entry) continue;
    const dataSource = await ensureDataSource(client, def, entry, registry, patched);
    if (!entry.databaseId) {
      const parentId = dataSource.parent?.database_id;
      if (parentId) entry.databaseId = parentId;
    }
    nextSchema.databases[def.key] = cacheEntry(def, entry, dataSource, now);
  }

  const guide = await writeGuide(client, rootPageId, children).catch(error => {
    // The page's own text is a nicety; the databases are the deliverable.
    warnings.push(`Could not write the root page guide: ${(error as Error).message}`);
    return 'skipped' as const;
  });
  if (guide === 'written') nextSchema.guideWritten = true;
  else if (cached?.guideWritten) nextSchema.guideWritten = true;

  await saveNotionSchema(store, nextSchema);
  return {
    ok: true,
    rootPageId,
    databases: Object.keys(nextSchema.databases).length,
    created,
    reused,
    patched,
    inlineFallback,
    properties: Object.values(nextSchema.databases)
      .reduce((total, entry) => total + Object.keys(entry?.properties ?? {}).length, 0),
    rowsSeed: 'deferred',
    guide,
    warnings,
    calls: client.stats,
    schema: nextSchema,
  };
}

// ─── 4. Self test ─────────────────────────────────────────────────────────

export interface SelftestCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface SelftestResult {
  ok: boolean;
  passed: number;
  total: number;
  /** Every property was verified by id, not by name — renames cannot fake a pass. */
  propertyIdMode: true;
  checks: SelftestCheck[];
  warnings: string[];
  calls: NotionCallStats;
}

/**
 * Prove the setup works, the way the design asks: reach the root page, read one
 * row from each of the eight databases, and confirm that every recorded
 * property id still exists with the type we expect.
 *
 * The property check is by id on purpose. A person may rename "요약" to
 * "회의 요약" tomorrow; Notion keeps the id, so the map in Redis stays valid and
 * this test must keep passing. If it were name-based, a harmless rename would
 * look like a broken workspace.
 */
export async function selftestNotion(options: {
  client: NotionClient;
  store: UpstashClient;
  rootPageId: string;
}): Promise<SelftestResult> {
  const { client, store, rootPageId } = options;
  const checks: SelftestCheck[] = [];
  const warnings: string[] = [];
  const schema = await loadNotionSchema(store);

  if (!schema) {
    checks.push({
      key: 'schema',
      label: 'Schema cache',
      ok: false,
      detail: 'No schema cache in Redis. Run bootstrap first.',
    });
    return {
      ok: false,
      passed: 0,
      total: 1,
      propertyIdMode: true,
      checks,
      warnings,
      calls: client.stats,
    };
  }
  if (schema.rootPageId !== rootPageId) {
    warnings.push(`The cached schema was built for another root page (${schema.rootPageId}).`);
  }

  try {
    const page = await client.retrievePage(rootPageId);
    checks.push({
      key: 'root',
      label: 'Root page',
      ok: page.in_trash !== true && page.archived !== true,
      detail: page.in_trash === true ? 'The root page is in the trash.' : `Reached page ${page.id}.`,
    });
  } catch (error) {
    checks.push({
      key: 'root',
      label: 'Root page',
      ok: false,
      detail: (error as Error).message,
    });
  }

  for (const def of NOTION_DATABASES) {
    const entry = schema.databases[def.key];
    if (!entry) {
      checks.push({ key: def.key, label: def.title, ok: false, detail: 'Not in the schema cache. Run bootstrap.' });
      continue;
    }
    try {
      const dataSource = await client.retrieveDataSource(entry.dataSourceId);
      const byId = new Map<string, { name: string; type: string }>();
      for (const [name, property] of Object.entries(dataSource.properties ?? {})) {
        if (property?.id) byId.set(property.id, { name, type: property.type });
      }
      const missing: string[] = [];
      const wrongType: string[] = [];
      for (const property of def.properties) {
        const id = entry.properties[property.name];
        if (!id) {
          missing.push(property.name);
          continue;
        }
        const live = byId.get(id);
        if (!live) {
          missing.push(property.name);
          continue;
        }
        if (live.type !== property.type) wrongType.push(`${property.name} (${live.type} ≠ ${property.type})`);
      }
      const rows = await client.queryDataSource(entry.dataSourceId, { page_size: 1 });
      const readable = Array.isArray(rows.results);
      const ok = missing.length === 0 && wrongType.length === 0 && readable;
      const detail = ok
        ? `${def.properties.length} properties verified by id · 1 row readable`
        : [
          missing.length ? `missing: ${missing.join(', ')}` : '',
          wrongType.length ? `wrong type: ${wrongType.join(', ')}` : '',
          readable ? '' : 'row read failed',
        ].filter(Boolean).join(' · ');
      checks.push({ key: def.key, label: def.title, ok, detail });
    } catch (error) {
      checks.push({ key: def.key, label: def.title, ok: false, detail: (error as Error).message });
    }
  }

  try {
    const children = await rootChildren(client, rootPageId);
    const known = new Set(NOTION_DATABASES.map(def => def.title.toLowerCase()));
    for (const block of children) {
      const title = blockTitle(block);
      if (title && !known.has(title.toLowerCase())) {
        warnings.push(`Unexpected database "${title}" under the root page — the connection can see it.`);
      }
    }
  } catch (error) {
    warnings.push(`Could not list the root page: ${(error as Error).message}`);
  }

  const passed = checks.filter(check => check.ok).length;
  return {
    ok: passed === checks.length && checks.length === NOTION_DATABASES.length + 1,
    passed,
    total: checks.length,
    propertyIdMode: true,
    checks,
    warnings,
    calls: client.stats,
  };
}

// ─── 5. Repair ────────────────────────────────────────────────────────────

export interface RepairResult {
  ok: boolean;
  needsBootstrap: boolean;
  repaired: Array<{ key: NotionDbKey; added: string[] }>;
  missing: NotionDbKey[];
  warnings: string[];
  calls: NotionCallStats;
  schema?: NotionSchemaCache;
}

/**
 * Put back what a person (or a bad afternoon) removed.
 *
 * The skeleton Phase 1 needs: re-collect property ids from Notion, add any
 * property the definition has and the data source does not, adopt a database
 * that was rebuilt by hand (same title, new id), and say plainly which databases
 * are gone so the next step is obvious — bootstrap. It never deletes.
 */
export async function repairNotion(options: {
  client: NotionClient;
  store: UpstashClient;
  rootPageId: string;
  dbMap?: Record<string, string>;
  now?: number;
}): Promise<RepairResult> {
  const { client, store, rootPageId } = options;
  const config = notionConfig();
  const dbMap = options.dbMap ?? config.dbMap;
  const now = options.now ?? Date.now();
  const cached = await loadNotionSchema(store);
  if (!cached) {
    return {
      ok: false,
      needsBootstrap: true,
      repaired: [],
      missing: NOTION_DATABASES.map(def => def.key),
      warnings: ['No schema cache yet — run bootstrap to build the eight databases.'],
      calls: client.stats,
    };
  }

  await requireRootPage(client, rootPageId);
  const children = await rootChildren(client, rootPageId);
  const byTitle = new Map<string, NotionBlock>();
  for (const block of children) {
    const title = blockTitle(block).toLowerCase();
    if (title && !byTitle.has(title)) byTitle.set(title, block);
  }

  const registry = new Map<NotionDbKey, RegistryEntry>();
  const missing: NotionDbKey[] = [];
  const warnings: string[] = [];

  for (const def of NOTION_DATABASES) {
    const cachedEntry = cached.databases[def.key];
    const mapped = dbMap[def.key];
    const existing = byTitle.get(def.title.toLowerCase());
    if (mapped) {
      registry.set(def.key, {
        databaseId: cachedEntry?.dataSourceId === mapped ? cachedEntry.databaseId : '',
        dataSourceId: mapped,
        inline: cachedEntry?.inline ?? true,
        created: false,
      });
      continue;
    }
    if (!existing) {
      missing.push(def.key);
      continue;
    }
    const databaseId = existing.id;
    const dataSourceId = cachedEntry && cachedEntry.databaseId === databaseId
      ? cachedEntry.dataSourceId
      : await dataSourceIdOfDatabase(client, databaseId);
    registry.set(def.key, {
      databaseId,
      dataSourceId,
      inline: cachedEntry?.inline ?? existing.type === 'child_database',
      created: false,
    });
  }

  const repaired: Array<{ key: NotionDbKey; added: string[] }> = [];
  const schema: NotionSchemaCache = {
    ...cached,
    version: 1,
    apiVersion: client.apiVersion || NOTION_API_VERSION,
    rootPageId,
    updatedAt: now,
    databases: { ...cached.databases },
  };

  for (const def of NOTION_DATABASES) {
    const entry = registry.get(def.key);
    if (!entry) {
      delete schema.databases[def.key];
      continue;
    }
    const patched: string[] = [];
    try {
      const dataSource = await ensureDataSource(client, def, entry, registry, patched);
      if (!entry.databaseId) {
        const parentId = dataSource.parent?.database_id;
        if (parentId) entry.databaseId = parentId;
      }
      schema.databases[def.key] = cacheEntry(def, entry, dataSource, now);
      repaired.push({ key: def.key, added: patched.map(item => item.slice(def.key.length + 1)) });
    } catch (error) {
      const failure = error instanceof NotionError ? error : null;
      if (failure?.code === 'notion_not_found') {
        // The data source ids in the cache point at something that no longer
        // exists. A bootstrap run rebuilds it; guessing here would create a
        // second database with the same name.
        missing.push(def.key);
        delete schema.databases[def.key];
        continue;
      }
      throw error;
    }
  }

  if (missing.length === 0) await saveNotionSchema(store, schema);
  if (missing.length > 0) {
    warnings.push(`Missing databases: ${missing.join(', ')}. Run bootstrap to recreate them.`);
  }
  return {
    ok: missing.length === 0,
    needsBootstrap: missing.length > 0,
    repaired: repaired.filter(item => item.added.length > 0),
    missing,
    warnings,
    calls: client.stats,
    schema,
  };
}
