// Shared collection DTOs, validators, and row mappers used by the /v1/collection
// routes (full GET/PUT and the incremental items/stacks deltas).
//
// The backend is a thin id+ownership store: it keeps NO card metadata and every
// enum-ish field (kind, finish, condition, format, colors, language) is an
// OPAQUE app-owned string — validated only as "present", never enumerated.

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const STACK_COLUMNS =
  'id, name, kind, sort_order, created_at, format, colors, commander, commander_card_id, person, since';
export const ITEM_COLUMNS =
  'id, card_id, stack_id, quantity, finish, condition, language, acquired_at, notes';

export interface Stack {
  id: string;
  name: string;
  kind: string;
  sortOrder: number;
  createdAt: string;
  format: string | null;
  colors: string[];
  commander: string | null;
  commanderCardId: string | null;
  person: string | null;
  since: string | null;
}

export interface CollectionItem {
  id: string;
  cardId: string;
  stackId: string;
  quantity: number;
  finish: string;
  condition: string;
  language: string;
  acquiredAt: string | null;
  notes: string | null;
}

interface StackRow {
  id: string;
  name: string;
  kind: string;
  sort_order: number;
  created_at: string;
  format: string | null;
  colors: string[] | null;
  commander: string | null;
  commander_card_id: string | null;
  person: string | null;
  since: string | null;
}

interface ItemRow {
  id: string;
  card_id: string;
  stack_id: string;
  quantity: number;
  finish: string;
  condition: string;
  language: string;
  acquired_at: string | null;
  notes: string | null;
}

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export function mapStack(row: StackRow): Stack {
  return {
    id: String(row.id),
    name: row.name,
    kind: row.kind,
    sortOrder: Number(row.sort_order),
    createdAt: row.created_at,
    format: row.format ?? null,
    colors: Array.isArray(row.colors) ? row.colors : [],
    commander: row.commander ?? null,
    commanderCardId: row.commander_card_id ?? null,
    person: row.person ?? null,
    since: row.since ?? null
  };
}

export function mapItem(row: ItemRow): CollectionItem {
  return {
    id: String(row.id),
    cardId: String(row.card_id),
    stackId: String(row.stack_id),
    quantity: Number(row.quantity),
    finish: row.finish,
    condition: row.condition,
    language: row.language,
    acquiredAt: row.acquired_at ?? null,
    notes: row.notes ?? null
  };
}

/**
 * Validates a stacks array (each is an object with a UUID `id`; all other fields
 * are opaque and passed through verbatim). Returns the array unchanged, or null.
 */
export function validateStacks(raw: unknown): unknown[] | null {
  if (!Array.isArray(raw)) return null;
  for (const s of raw) {
    if (typeof s !== 'object' || s === null) return null;
    if (!isUuid((s as { id?: unknown }).id)) return null;
  }
  return raw;
}

/**
 * Validates an items array: UUID `id`/`cardId`/`stackId`, integer `quantity` ≥ 1.
 * When `stackIds` is given (full PUT), every `stackId` must be one of them.
 * Returns the array unchanged, or null.
 */
export function validateItems(raw: unknown, stackIds?: Set<string>): unknown[] | null {
  if (!Array.isArray(raw)) return null;
  for (const it of raw) {
    if (typeof it !== 'object' || it === null) return null;
    const o = it as Record<string, unknown>;
    if (!isUuid(o.id) || !isUuid(o.cardId) || !isUuid(o.stackId)) return null;
    if (!Number.isInteger(o.quantity) || (o.quantity as number) < 1) return null;
    if (stackIds && !stackIds.has((o.stackId as string).toLowerCase())) return null;
  }
  return raw;
}

/** Parses a delete body `{ ids: [uuid, ...] }` into a non-empty uuid list, or null. */
export function parseIdList(body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const ids = (body as { ids?: unknown }).ids;
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const out: string[] = [];
  for (const id of ids) {
    if (!isUuid(id)) return null;
    out.push(id);
  }
  return out;
}
