// nowaikit-sdk/catalog-form: a Service Catalog item as a small, render-ready form model, and order
// submission. The normalisation mirrors NowAIKit's MCP App catalog form (src/apps/form-model.ts), so a
// form built here behaves like the one NowAIKit renders inside Claude, ChatGPT and other MCP hosts.

import type { ServiceNowClient } from './client.js';
import { ServiceNowError } from './errors.js';

export type FieldKind =
  | 'text' | 'textarea' | 'email' | 'url' | 'number' | 'date' | 'datetime' | 'password'
  | 'select' | 'radio' | 'checkbox' | 'reference' | 'list'
  | 'container' | 'label' | 'unsupported';

export interface FormChoice {
  value: string;
  label: string;
  /** Record forms: only offer this choice when the field it depends on has this value. */
  dependentValue?: string;
}

export interface FormField {
  name: string;
  label: string;
  kind: FieldKind;
  mandatory?: boolean;
  readOnly?: boolean;
  help?: string;
  maxLength?: number;
  choices?: FormChoice[];
  /** reference / list: table to look values up in. */
  reference?: string;
  /** Encoded-query reference qualifier (script qualifiers are dropped). */
  refQualifier?: string;
  value?: string;
  displayValue?: string;
  /** Record forms: field whose value filters this field's choices (e.g. subcategory on category). */
  dependentOn?: string;
  children?: FormField[];
  /** For unsupported fields: what ServiceNow calls the type. */
  typeLabel?: string;
  /** Select without a "-- None --" option (dictionary choice type 3). */
  noNone?: boolean;
}

export interface PolicyCondition {
  field: string;
  oper: string;
  value: string;
  or?: boolean;
  newQuery?: boolean;
}

export interface PolicyAction {
  field: string;
  visible?: boolean;
  mandatory?: boolean;
  readOnly?: boolean;
  cleared?: boolean;
}

export interface FormPolicy {
  description: string;
  onLoad: boolean;
  reverse: boolean;
  conditions: PolicyCondition[];
  actions: PolicyAction[];
}

// ─── Catalog variables ────────────────────────────────────────────────────────

/** Catalog variable `friendly_type` → field kind. Anything not listed is shown as "fill this in ServiceNow". */
const CATALOG_KIND: Record<string, FieldKind> = {
  single_line_text: 'text',
  wide_single_line_text: 'text',
  ip: 'text',
  ip_address: 'text',
  duration: 'text',
  multi_line_text: 'textarea',
  html: 'textarea',
  email: 'email',
  url: 'url',
  masked: 'password',
  select_box: 'select',
  yes_no: 'select',
  lookup_select_box: 'select',
  multiple_choice: 'radio',
  numeric_scale: 'radio',
  lookup_multiple_choice: 'radio',
  check_box: 'checkbox',
  reference: 'reference',
  requested_for: 'reference',
  list_collector: 'list',
  date: 'date',
  date_time: 'datetime',
  label: 'label',
};

/** Layout-only variable types that carry no value. */
const LAYOUT_ONLY = new Set(['break', 'container_split', 'container_end', 'formatter']);

/** Catalog numeric `type` codes, used when friendly_type is missing. */
const CATALOG_TYPE_CODES: Record<number, string> = {
  1: 'yes_no', 2: 'multi_line_text', 3: 'multiple_choice', 4: 'numeric_scale', 5: 'select_box',
  6: 'single_line_text', 7: 'check_box', 8: 'reference', 9: 'date', 10: 'date_time', 11: 'label',
  12: 'break', 16: 'wide_single_line_text', 18: 'lookup_select_box', 19: 'container_start',
  20: 'container_split', 21: 'list_collector', 22: 'lookup_multiple_choice', 23: 'html',
  24: 'container_end', 25: 'masked', 26: 'email', 27: 'url', 28: 'ip_address', 29: 'duration',
  31: 'requested_for',
};

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}

/** Only plain encoded queries can be applied from the browser; script and dynamic qualifiers are not. */
function usableQualifier(q: unknown): string | undefined {
  const s = str(q).trim();
  if (!s || s === 'EQ' || /^javascript:/i.test(s) || /dynamic/i.test(s)) return undefined;
  return s.replace(/\^EQ$/, '');
}

export interface CatalogFormContext {
  /** sys_id of the current user, used to resolve `javascript:gs.getUserID()` defaults. */
  currentUserSysId?: string;
  currentUserName?: string;
}

/** Normalise one sn_sc variable (recursive for containers). Returns null for layout-only entries. */
export function normalizeCatalogVariable(v: any, ctx: CatalogFormContext = {}): FormField | null {
  if (!v) return null;
  const friendly = str(v.friendly_type) || CATALOG_TYPE_CODES[Number(v.type)] || '';
  if (LAYOUT_ONLY.has(friendly)) return null;

  // The catalog API reports containers as active:false even when they render, so only fields are filtered on it.
  if (friendly === 'container_start' || Array.isArray(v.children)) {
    const children = (v.children || [])
      .map((c: any) => normalizeCatalogVariable(c, ctx))
      .filter((c: FormField | null): c is FormField => !!c);
    if (!children.length) return null;
    // ServiceNow wraps lone checkboxes in an unnamed "checkbox_container"; render those inline.
    const label = v.containerType === 'checkbox_container' && str(v.label) === 'Options' ? '' : str(v.label);
    return { name: str(v.name) || `container_${str(v.id)}`, label, kind: 'container', children };
  }

  if (v.active === false) return null;
  const kind = CATALOG_KIND[friendly] || 'unsupported';
  const field: FormField = {
    name: str(v.name),
    label: str(v.label) || str(v.name),
    kind,
  };
  if (!field.name) return null;
  if (v.mandatory) field.mandatory = true;
  if (v.read_only) field.readOnly = true;
  if (str(v.help_text)) field.help = str(v.help_text);
  if (Number(v.max_length) > 0) field.maxLength = Number(v.max_length);
  if (kind === 'unsupported') field.typeLabel = str(v.display_type) || friendly || 'custom';

  if (Array.isArray(v.choices) && (kind === 'select' || kind === 'radio')) {
    field.choices = v.choices
      .map((c: any) => ({ value: str(c.value), label: str(c.label) || str(c.value) }))
      .filter((c: FormChoice) => kind === 'select' || c.value !== '');
  }
  if (kind === 'reference') {
    field.reference = str(v.reference) || 'sys_user';
    const q = usableQualifier(v.ref_qualifier);
    if (q) field.refQualifier = q;
  }
  if (kind === 'list') {
    field.reference = str(v.table) || str(v.list_table) || str(v.reference);
    if (!field.reference) {
      field.kind = 'unsupported';
      field.typeLabel = 'List collector';
    }
  }

  // Defaults. Script defaults are resolved where we can and dropped otherwise.
  let value = str(v.value);
  let display = str(v.displayvalue);
  if (/^javascript:/i.test(value)) {
    if (/gs\.getUserID\(\)/.test(value) && ctx.currentUserSysId) {
      value = ctx.currentUserSysId;
      display = display || ctx.currentUserName || '';
    } else {
      value = '';
      display = '';
    }
  }
  if (value) field.value = value;
  if (display && display !== value) field.displayValue = display;
  return field;
}

export function normalizeCatalogVariables(vars: any[], ctx: CatalogFormContext = {}): FormField[] {
  return (vars || [])
    .map((v) => normalizeCatalogVariable(v, ctx))
    .filter((f): f is FormField => !!f);
}

/** Map catalog variable sys_ids (used as `IO:<id>` in UI policies) to variable names. */
export function catalogVariableIdMap(vars: any[], map: Record<string, string> = {}): Record<string, string> {
  for (const v of vars || []) {
    if (v && v.id && v.name) map[String(v.id)] = String(v.name);
    if (v && Array.isArray(v.children)) catalogVariableIdMap(v.children, map);
  }
  return map;
}

function tri(v: unknown): boolean | undefined {
  const s = str(v).toLowerCase();
  if (s === 'true') return true;
  if (s === 'false') return false;
  return undefined; // "ignore", "leave alone", empty
}

/** Normalise sn_sc `ui_policy` entries, translating `IO:<sys_id>` references to variable names. */
export function normalizeCatalogPolicies(policies: any[], idMap: Record<string, string>): FormPolicy[] {
  const resolve = (ref: unknown) => {
    const s = str(ref);
    const id = s.startsWith('IO:') ? s.slice(3) : s;
    return idMap[id] || (s.startsWith('IO:') ? '' : s);
  };
  const out: FormPolicy[] = [];
  for (const p of policies || []) {
    if (!p) continue;
    // Policies that need scripts can't run in the sandboxed view; their declarative part still applies.
    const conditions: PolicyCondition[] = (p.conditions || [])
      .map((c: any) => ({
        field: resolve(c.field),
        oper: str(c.oper) || '=',
        value: str(c.value),
        ...(c.or ? { or: true } : {}),
        ...(c.newquery ? { newQuery: true } : {}),
      }))
      .filter((c: PolicyCondition) => c.field);
    const actions: PolicyAction[] = (p.actions || [])
      .map((a: any) => {
        const act: PolicyAction = { field: resolve(a.name) };
        const visible = tri(a.visible);
        const mandatory = tri(a.mandatory);
        const disabled = tri(a.disabled);
        if (visible !== undefined) act.visible = visible;
        if (mandatory !== undefined) act.mandatory = mandatory;
        if (disabled !== undefined) act.readOnly = disabled;
        if (tri(a.cleared)) act.cleared = true;
        return act;
      })
      .filter((a: PolicyAction) => a.field && (a.visible !== undefined || a.mandatory !== undefined || a.readOnly !== undefined));
    if (!actions.length) continue;
    out.push({
      description: str(p.short_description),
      onLoad: p.onload !== false,
      reverse: p.reverse !== false,
      conditions,
      actions,
    });
  }
  return out;
}

/** Flatten a field tree (containers included) for lookups. */
export function flattenFields(fields: FormField[], out: FormField[] = []): FormField[] {
  for (const f of fields) {
    out.push(f);
    if (f.children) flattenFields(f.children, out);
  }
  return out;
}


// ─── Fetch and submit ─────────────────────────────────────────────────────────

const SYS_ID = /^[0-9a-f]{32}$/i;

export interface CatalogForm {
  item: {
    sys_id: string;
    name: string;
    short_description?: string;
    description?: string;
    price?: string;
    show_price?: boolean;
    show_quantity?: boolean;
    category?: string;
  };
  fields: FormField[];
  policies: FormPolicy[];
  /** Things the form cannot reproduce outside ServiceNow (client scripts, policy scripts, attachments). */
  notes: string[];
  /** Names of mandatory variables (UI policies may change this at run time). */
  mandatoryVariables: string[];
  itemUrl: string;
}

/**
 * Load a catalog item through the Service Catalog API and return its normalised form model.
 * Script defaults of `javascript:gs.getUserID()` are resolved to the calling user.
 */
export async function getCatalogForm(client: ServiceNowClient, itemSysId: string): Promise<CatalogForm> {
  if (!SYS_ID.test(itemSysId || '')) throw new ServiceNowError('itemSysId must be a 32-character sys_id', 'VALIDATION_ERROR');
  const base = client.getBaseUrl();
  const body = await client.apiRequest<any>(`${base}/api/sn_sc/servicecatalog/items/${itemSysId}`, { method: 'GET' });
  const item = body?.result ?? body ?? {};
  let me: { user_sys_id?: string; user_display_name?: string } = {};
  try {
    const u = await client.apiRequest<any>(`${base}/api/now/ui/user/current_user`, { method: 'GET' });
    me = u?.result ?? {};
  } catch { /* defaults that need the user are dropped */ }
  const vars: any[] = item.variables || [];
  const fields = normalizeCatalogVariables(vars, { currentUserSysId: me.user_sys_id, currentUserName: me.user_display_name });
  const policies = normalizeCatalogPolicies(item.ui_policy || [], catalogVariableIdMap(vars));
  const notes: string[] = [];
  const scripts = item.client_script || {};
  const scriptCount = ['onLoad', 'onChange', 'onSubmit'].reduce((n, k) => n + ((scripts[k] || []).length), 0);
  if (scriptCount) notes.push(`This item has ${scriptCount} catalog client script(s). They run only in ServiceNow.`);
  if ((item.ui_policy || []).some((p: any) => p.script_true || p.script_false)) notes.push('Some UI policy scripts on this item only run in ServiceNow.');
  if (item.mandatory_attachment) notes.push('This item needs an attachment. Add it in ServiceNow after submitting.');
  const id = String(item.sys_id || itemSysId);
  return {
    item: {
      sys_id: id,
      name: str(item.name),
      short_description: item.short_description,
      description: item.description,
      price: item.price,
      show_price: item.show_price,
      show_quantity: item.show_quantity,
      category: item.category?.title,
    },
    fields,
    policies,
    notes,
    mandatoryVariables: flattenFields(fields).filter((f) => f.mandatory).map((f) => f.name),
    itemUrl: `${base}/sp?id=sc_cat_item&sys_id=${id}`,
  };
}

/**
 * Check values against a form model before ordering. Returns the labels of mandatory fields that are
 * still empty, skipping fields a UI policy controls (their state depends on other answers).
 */
export function missingMandatoryFields(form: Pick<CatalogForm, 'fields' | 'policies'>, variables: Record<string, unknown>): string[] {
  const controlled = new Set(form.policies.flatMap((p) => p.actions.map((a) => a.field)));
  return flattenFields(form.fields)
    .filter((f) => f.mandatory && !controlled.has(f.name) && f.kind !== 'unsupported' && f.kind !== 'container' && f.kind !== 'label')
    .filter((f) => {
      const v = variables[f.name];
      return (v === undefined || v === null || v === '') && !f.value;
    })
    .map((f) => f.label);
}

export interface SubmitCatalogFormResult {
  requestNumber: string | null;
  requestId: string | null;
  table: string;
  requestUrl: string | null;
  raw: unknown;
}

/**
 * Order a catalog item (POST /api/sn_sc/servicecatalog/items/{id}/order_now). Variable values are sent
 * as strings. Pass `form` to check mandatory fields locally first.
 */
export async function submitCatalogForm(
  client: ServiceNowClient,
  itemSysId: string,
  variables: Record<string, unknown>,
  options: { quantity?: number; form?: Pick<CatalogForm, 'fields' | 'policies'> } = {},
): Promise<SubmitCatalogFormResult> {
  if (!SYS_ID.test(itemSysId || '')) throw new ServiceNowError('itemSysId must be a 32-character sys_id', 'VALIDATION_ERROR');
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(variables || {})) {
    if (/^[a-z0-9_]+$/i.test(k) && v !== undefined && v !== null) clean[k] = Array.isArray(v) ? v.map(String).join(',') : String(v);
  }
  if (options.form) {
    const missing = missingMandatoryFields(options.form, clean);
    if (missing.length) throw new ServiceNowError(`Missing required fields: ${missing.join(', ')}`, 'VALIDATION_ERROR');
  }
  const quantity = Math.min(Math.max(Number(options.quantity) || 1, 1), 100);
  const base = client.getBaseUrl();
  const body = await client.apiRequest<any>(`${base}/api/sn_sc/servicecatalog/items/${itemSysId}/order_now`, {
    method: 'POST',
    body: JSON.stringify({ sysparm_quantity: quantity, variables: clean }),
  });
  const r = body?.result ?? body ?? {};
  const requestId = String(r.request_id || r.sys_id || '') || null;
  const table = String(r.table || 'sc_request');
  return {
    requestNumber: r.request_number || r.number || null,
    requestId,
    table,
    requestUrl: requestId ? `${base}/nav_to.do?uri=${encodeURIComponent(`${table}.do?sys_id=${requestId}`)}` : null,
    raw: body,
  };
}
