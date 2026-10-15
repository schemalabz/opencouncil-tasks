import { createHash } from 'crypto';
import { rowsOf, type PosthogQuery, type PosthogRequest } from '../../lib/telemetry/posthogQuery.js';
import { parseAlert, type AlertSpec } from './alertSpec.js';
import { CITY_PROPERTY, ENV_PROPERTY } from '../../lib/telemetry/posthogSink.js';
import { isMonitored } from './registry.js';
import { CHECK_METRIC_PREFIX as METRIC_PREFIX, checkMetricName, type FailureMode } from './schema.js';

/**
 * The platform mirrors of the failure-mode registry: per monitored mode a
 * Langfuse BOOLEAN score config named like the scores the monitor emits (the slug), a
 * PostHog insight over the `check:<slug>` `$ai_metric` events and an alert on it. The plan
 * compares them with what the platforms hold; `applyPlan` writes only what eval sync owns:
 * it creates Langfuse score configs (never changes one) and creates or updates PostHog
 * insights carrying the managed marker and the alerts that watch them.
 */

export type SyncAction = 'create' | 'up-to-date' | 'update' | 'orphaned' | 'manual' | 'unknown';
export type SyncPlatform = 'langfuse' | 'posthog';
export type SyncKind = 'score-config' | 'insight' | 'alert' | 'destination';
export const SYNC_PLATFORMS: SyncPlatform[] = ['langfuse', 'posthog'];

export type PlanItem = {
    platform: SyncPlatform;
    kind: SyncKind;
    name: string;
    action: SyncAction;
    modeId?: string;
    /** The platform object's id, when it exists. */
    id?: string | number;
    /** An existing object eval sync made (the marker on an insight; for an alert, watching such an insight). */
    managed?: boolean;
    /** What would be created, or why it differs. */
    detail?: string;
    /** Where the platform object can only approximate the alert text. */
    notes?: string[];
    /** Alert clauses no object expresses: a person sets them up from the text. */
    manual?: string[];
    alertText?: string;
};

export type SyncPlan = {
    items: PlanItem[];
    desired: DesiredMode[];
    destination?: DesiredDestination;
    monitored: Array<Pick<FailureMode, 'id' | 'slug'>>;
    notMonitored: Array<Pick<FailureMode, 'id' | 'slug' | 'status'>>;
    errors: Partial<Record<SyncPlatform, string>>;
};

export type LangfuseScoreConfig = { id: string; name: string; dataType: string; isArchived: boolean; description?: string | null };
export type LangfuseState = { scoreConfigs: LangfuseScoreConfig[] };
export type PosthogInsight = { id: number; name: string | null; description: string | null };
export type PosthogAlert = {
    id: string; name: string; insightId: number | null; enabled: boolean; calculationInterval: string | null; conditionType: string | null;
    checkOngoing?: boolean | null;
};
export type PosthogDestination = { id: string; name: string; description: string | null; enabled: boolean };
/** `destinations` is absent when they were not read (no destination is wanted). */
export type PosthogState = { insights: PosthogInsight[]; alerts: PosthogAlert[]; destinations?: PosthogDestination[] };
export type PlatformState = { langfuse: LangfuseState | { error: string }; posthog: PosthogState | { error: string } };

const MANAGED = 'Managed by eval sync';

export const insightName = checkMetricName;
export const alertName = (slug: string) => `${METRIC_PREFIX}${slug} alert`;

type Interval = 'hourly' | 'daily' | 'weekly';
const PERIOD: Record<Interval, string> = { hourly: 'hour', daily: 'day', weekly: 'week' };

export type DesiredInsight = { name: string; description: string; query: unknown; fingerprint: string; summary: string };
export type DesiredAlert = {
    name: string;
    calculationInterval: Interval;
    condition: { type: 'absolute_value' | 'relative_increase' };
    threshold: { configuration: { type: 'absolute' | 'percentage'; bounds: { upper: number } } };
    /** The insight's single series (the formula, for a rate); `checkOngoing` also tests the interval still filling up. */
    config: { type: 'TrendsAlertConfig'; series_index: 0; check_ongoing_interval: boolean };
    summary: string;
    notes: string[];
};
export type DesiredMode = {
    mode: FailureMode;
    scoreConfig: { name: string; dataType: 'BOOLEAN'; description: string };
    insight: DesiredInsight;
    alert?: DesiredAlert;
    spec?: AlertSpec;
};

/**
 * Where firing check alerts are posted. One destination serves every check alert (it filters on
 * the alert name), so alerts can be recreated without touching it. The webhook is a secret: only
 * its hash enters the fingerprint.
 */
export type DesiredDestination = {
    name: string; description: string; fingerprint: string; summary: string;
    templateId: 'template-discord';
    inputs: { webhookUrl: { value: string }; content: { value: string } };
    filters: unknown;
    /** Printed plans and logs show the fingerprint in the webhook's place; request bodies read `inputs` itself. */
    toJSON(): object;
};

export const DESTINATION_NAME = 'check alerts → Discord';

const DISCORD_CONTENT = [
    "🔴 **{event.properties.alert_name}** is firing — {event.properties.insight_name}",
    '{event.properties.breaches}',
    'Alert: {project.url}/insights/{event.properties.insight_id}/alerts?alert_id={event.properties.alert_id}',
    'Triage: `eval harvest --source monitoring --env production`, then the eval skill\'s *Investigate an alert*.',
].join('\n');

export function desiredDestination(webhookUrl: string): DesiredDestination {
    const filters = {
        source: 'events',
        events: [{ id: '$insight_alert_firing', type: 'events' }],
        properties: [{ key: 'alert_name', value: METRIC_PREFIX, operator: 'icontains', type: 'event' }],
    };
    const inputs = { webhookUrl: { value: webhookUrl }, content: { value: DISCORD_CONTENT } };
    const fp = fingerprint({ filters, content: DISCORD_CONTENT, webhook: createHash('sha256').update(webhookUrl).digest('hex') });
    const d = {
        name: DESTINATION_NAME, templateId: 'template-discord' as const, inputs, filters, fingerprint: fp,
        description: `${MANAGED} [eval-sync ${fp}]. Posts every firing ${METRIC_PREFIX}* alert to Discord.`,
        summary: `Discord, on every firing ${METRIC_PREFIX}* alert`,
    };
    return { ...d, toJSON: () => ({ ...d, inputs: { ...inputs, webhookUrl: { value: `[redacted, eval-sync ${fp}]` } } }) };
}

function planDestination(want: DesiredDestination, have: PosthogDestination[] | undefined): PlanItem {
    const base = { platform: 'posthog' as const, kind: 'destination' as const, name: want.name };
    if (!have) return { ...base, action: 'unknown', detail: 'destinations not read' };
    const found = have.find(d => d.name === want.name);
    if (!found) return { ...base, action: 'create', detail: want.summary };
    if (!found.description?.includes(MANAGED)) return { ...base, action: 'manual', id: found.id, managed: false, detail: 'a destination eval sync did not make holds this name', manual: [`rename or delete destination ${found.id}, then sync creates its own`] };
    const stale = !found.description.includes(`[eval-sync ${want.fingerprint}]`) || !found.enabled;
    return { ...base, action: stale ? 'update' : 'up-to-date', id: found.id, managed: true, detail: stale ? 'its message, filter, webhook or enabled state differs' : want.summary };
}

const prop = (key: string, value: string) => ({ key, value: [value], operator: 'exact', type: 'event' });

function fingerprint(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 8);
}

function desiredInsight(mode: FailureMode, spec: AlertSpec | undefined, env: string): DesiredInsight {
    const metric = checkMetricName(mode.slug);
    const rate = spec?.kind !== 'any';
    const series = (name: string, failsOnly: boolean) => ({
        kind: 'EventsNode', event: '$ai_metric', math: 'total', custom_name: name,
        properties: [prop('$ai_metric_name', metric), ...(failsOnly ? [prop('$ai_metric_value', '1')] : [])],
    });
    const interval = spec?.cadence === 'immediate' ? 'hour' : (spec?.windowDays ?? 1) >= 7 ? 'week' : 'day';
    const days = spec?.baselineDays ?? 30;
    const source = {
        kind: 'TrendsQuery',
        series: rate ? [series('fails', true), series('checks', false)] : [series('fails', true)],
        // One result series, so an alert's series_index 0 is the rate itself.
        ...(rate && { trendsFilter: { formulaNodes: [{ formula: 'A/B', custom_name: 'fail rate' }] } }),
        interval,
        dateRange: { date_from: `-${days}d` },
        properties: [prop(ENV_PROPERTY, env)],
        ...(spec?.breakdown === 'city' && { breakdownFilter: { breakdown: CITY_PROPERTY, breakdown_type: 'event' } }),
    };
    const query = { kind: 'InsightVizNode', source };
    const fp = fingerprint(query);
    return {
        name: insightName(mode.slug),
        description: `${MANAGED} from ${mode.id} (${mode.title}). [eval-sync ${fp}]`,
        query,
        fingerprint: fp,
        summary: `${rate ? 'fail rate (fails/checks)' : 'fail count'} per ${interval}${spec?.breakdown === 'city' ? ' by city' : ''}, last ${days}d, ${env}`,
    };
}

/** Undefined when the text names no condition a PostHog alert can test. */
function desiredAlert(mode: FailureMode, spec: AlertSpec): DesiredAlert | undefined {
    if (!spec.kind || (spec.kind === 'rate' && !spec.factor)) return undefined;
    const calculationInterval: Interval = spec.cadence === 'immediate' ? 'hourly' : spec.cadence === 'daily' ? 'daily' : (spec.windowDays ?? 1) >= 7 ? 'weekly' : 'daily';
    const notes: string[] = [];
    if (spec.kind === 'rate' && spec.baselineDays) notes.push(`PostHog compares each ${PERIOD[calculationInterval]} with the one before, not with a ${spec.baselineDays}-day baseline`);
    if (spec.minVolume) notes.push(`a PostHog alert has no minimum volume: "min ${spec.minVolume.count} ${spec.minVolume.unit}" is checked by whoever reads the alert`);
    if (spec.breakdown === 'city') notes.push('broken down by city: confirm the alert evaluates each breakdown value');
    if (spec.breakdown === 'label') notes.push('not grouped by label: $ai_metric events carry the call id, not its label');
    if (spec.channel === 'discord') notes.push(`posted by the managed destination "${DESTINATION_NAME}" when DISCORD_ALERT_WEBHOOK is set`);
    const rate = spec.kind === 'rate';
    const upper = rate ? spec.factor! - 1 : 0;
    return {
        name: alertName(mode.slug),
        calculationInterval,
        condition: { type: rate ? 'relative_increase' : 'absolute_value' },
        threshold: { configuration: { type: rate ? 'percentage' : 'absolute', bounds: { upper } } },
        // The last completed interval, for every alert: with check_ongoing_interval PostHog tests the
        // filling interval instead of it.
        config: { type: 'TrendsAlertConfig', series_index: 0, check_ongoing_interval: false },
        summary: rate ? `relative increase > ${Math.round(upper * 100)}%, checked ${calculationInterval}` : `fail count > 0 in the last completed ${PERIOD[calculationInterval]}, checked ${calculationInterval}`,
        notes,
    };
}

/** What should exist on the platforms for the monitored modes. */
export function desiredObjects(modes: FailureMode[], env = 'production'): DesiredMode[] {
    return modes.filter(isMonitored).map(mode => {
        const spec = mode.alert ? parseAlert(mode.alert) : undefined;
        return {
            mode,
            spec,
            scoreConfig: { name: mode.slug, dataType: 'BOOLEAN' as const, description: `${MANAGED}: ${mode.id} ${mode.title}` },
            insight: desiredInsight(mode, spec, env),
            ...(spec && { alert: desiredAlert(mode, spec) }),
        };
    });
}

const isError = (s: object): s is { error: string } => 'error' in s;
const isManagedInsight = (i: PosthogInsight) => Boolean(i.description?.includes(MANAGED));

function planLangfuse(desired: DesiredMode[], state: LangfuseState, slugs: Set<string>): PlanItem[] {
    const items: PlanItem[] = [];
    const byName = new Map(state.scoreConfigs.map(c => [c.name, c]));
    for (const d of desired) {
        const have = byName.get(d.scoreConfig.name);
        const base = { platform: 'langfuse' as const, kind: 'score-config' as const, name: d.scoreConfig.name, modeId: d.mode.id };
        if (!have) items.push({ ...base, action: 'create', detail: 'BOOLEAN' });
        else if (have.dataType !== 'BOOLEAN' || have.isArchived) {
            // Production scores may already lean on the existing config: sync only ever adds one.
            items.push({
                ...base, action: 'manual', id: have.id,
                detail: [have.dataType !== 'BOOLEAN' && `dataType ${have.dataType}, expected BOOLEAN`, have.isArchived && 'archived'].filter(Boolean).join('; '),
                manual: ['eval sync never changes a Langfuse score config: fix it in the Langfuse UI'],
            });
        } else items.push({ ...base, action: 'up-to-date', id: have.id, detail: 'BOOLEAN' });
    }
    const wanted = new Set(desired.map(d => d.scoreConfig.name));
    for (const c of state.scoreConfigs) {
        if (wanted.has(c.name) || c.isArchived) continue;
        if (slugs.has(c.name) || c.description?.includes(MANAGED)) {
            items.push({ platform: 'langfuse', kind: 'score-config', name: c.name, action: 'orphaned', id: c.id, detail: slugs.has(c.name) ? 'its mode is not monitored' : 'no failure mode has this slug' });
        }
    }
    return items;
}

function planPosthog(desired: DesiredMode[], state: PosthogState): PlanItem[] {
    const items: PlanItem[] = [];
    const insights = new Map(state.insights.filter(i => i.name).map(i => [i.name!, i]));
    const managedIds = new Set(state.insights.filter(isManagedInsight).map(i => i.id));
    const alerts = new Map(state.alerts.map(a => [a.name, a]));
    for (const d of desired) {
        const have = insights.get(d.insight.name);
        const haveManaged = have && isManagedInsight(have);
        const base = { platform: 'posthog' as const, kind: 'insight' as const, name: d.insight.name, modeId: d.mode.id };
        if (!have) items.push({ ...base, action: 'create', detail: d.insight.summary });
        else if (!haveManaged) {
            items.push({ ...base, action: 'manual', id: have.id, managed: false, detail: 'an insight eval sync did not make holds this name', manual: [`rename or delete insight ${have.id}, then sync creates its own`] });
        } else if (!have.description?.includes(`[eval-sync ${d.insight.fingerprint}]`)) items.push({ ...base, action: 'update', id: have.id, managed: true, detail: `query differs from the registry's (${d.insight.summary})` });
        else items.push({ ...base, action: 'up-to-date', id: have.id, managed: true, detail: d.insight.summary });

        const alertBase = { platform: 'posthog' as const, kind: 'alert' as const, modeId: d.mode.id, alertText: d.mode.alert };
        if (!d.alert) {
            const why = d.mode.alert ? 'no condition with a threshold recognised in the alert text' : 'the entry has no alert: text';
            items.push({ ...alertBase, name: alertName(d.mode.slug), action: 'manual', manual: [why, ...(d.spec?.manual ?? [])] });
            continue;
        }
        const a = d.alert;
        const extra = { notes: a.notes, ...(d.spec?.manual.length && { manual: d.spec.manual }) };
        const haveAlert = alerts.get(a.name);
        if (!haveAlert) {
            if (have && !haveManaged) items.push({ ...alertBase, ...extra, name: a.name, action: 'manual', detail: `${a.summary}, once its insight is one eval sync made` });
            else items.push({ ...alertBase, ...extra, name: a.name, action: 'create', detail: a.summary });
            continue;
        }
        if (haveAlert.insightId === null || !managedIds.has(haveAlert.insightId)) {
            items.push({ ...alertBase, ...extra, name: a.name, id: haveAlert.id, action: 'manual', managed: false, detail: `watches insight ${haveAlert.insightId}, which eval sync did not make`, manual: [`rename or delete alert ${haveAlert.id}, then sync creates its own`, ...(extra.manual ?? [])] });
            continue;
        }
        const diffs = [
            have && haveAlert.insightId !== have.id && `on insight ${haveAlert.insightId}, expected ${have.id}`,
            !have && 'its insight does not exist yet',
            !haveAlert.enabled && 'disabled',
            haveAlert.calculationInterval !== a.calculationInterval && `checked ${haveAlert.calculationInterval}, expected ${a.calculationInterval}`,
            haveAlert.conditionType !== a.condition.type && `condition ${haveAlert.conditionType}, expected ${a.condition.type}`,
            haveAlert.checkOngoing !== undefined && Boolean(haveAlert.checkOngoing) !== a.config.check_ongoing_interval && `${haveAlert.checkOngoing ? 'checks' : 'skips'} the current interval, expected the opposite`,
        ].filter((x): x is string => Boolean(x));
        items.push({
            ...alertBase, ...extra, name: a.name, id: haveAlert.id, managed: true, action: diffs.length ? 'update' : 'up-to-date',
            detail: diffs.length ? diffs.join('; ') : `${a.summary} (threshold not readable through the query API: compare by hand)`,
        });
    }
    const wantedInsights = new Set(desired.map(d => d.insight.name));
    const wantedAlerts = new Set(desired.flatMap(d => (d.alert ? [d.alert.name] : [])));
    for (const i of state.insights) {
        if (i.name?.startsWith(METRIC_PREFIX) && !wantedInsights.has(i.name)) items.push({ platform: 'posthog', kind: 'insight', name: i.name, action: 'orphaned', id: i.id, detail: 'no monitored mode has this metric' });
    }
    for (const a of state.alerts) {
        if (a.name.startsWith(METRIC_PREFIX) && !wantedAlerts.has(a.name)) items.push({ platform: 'posthog', kind: 'alert', name: a.name, action: 'orphaned', id: a.id, detail: 'no monitored mode defines this alert' });
    }
    return items;
}

/** Langfuse alerts have no API: each monitored mode's alert is a manual step there. */
function langfuseAlerts(desired: DesiredMode[]): PlanItem[] {
    return desired.map(d => ({
        platform: 'langfuse', kind: 'alert', name: d.mode.slug, action: 'manual', modeId: d.mode.id, alertText: d.mode.alert,
        manual: [d.mode.alert ? `set up in the Langfuse UI on score ${d.mode.slug} (no alert API)` : 'the entry has no alert: text'],
    }));
}

const unknownItems = (platform: SyncPlatform, desired: DesiredMode[]): PlanItem[] => desired.flatMap((d): PlanItem[] => platform === 'langfuse'
    ? [{ platform, kind: 'score-config' as const, name: d.scoreConfig.name, action: 'unknown' as const, modeId: d.mode.id }]
    : [
        { platform, kind: 'insight' as const, name: d.insight.name, action: 'unknown' as const, modeId: d.mode.id },
        { platform, kind: 'alert' as const, name: alertName(d.mode.slug), action: 'unknown' as const, modeId: d.mode.id, alertText: d.mode.alert },
    ]);

/** `only` leaves the other platform out of the plan entirely: no state read, no items. */
export function planSync(modes: FailureMode[], state: Partial<PlatformState>, env = 'production', only?: SyncPlatform, destination?: DesiredDestination): SyncPlan {
    const desired = desiredObjects(modes, env);
    const slugs = new Set(modes.map(m => m.slug));
    const errors: SyncPlan['errors'] = {};
    const items: PlanItem[] = [];
    const wants = (p: SyncPlatform) => !only || only === p;
    if (wants('langfuse')) {
        const lf = state.langfuse ?? { error: 'state not read' };
        if (isError(lf)) { errors.langfuse = lf.error; items.push(...unknownItems('langfuse', desired)); }
        else items.push(...planLangfuse(desired, lf, slugs));
        items.push(...langfuseAlerts(desired));
    }
    if (wants('posthog')) {
        const ph = state.posthog ?? { error: 'state not read' };
        if (isError(ph)) { errors.posthog = ph.error; items.push(...unknownItems('posthog', desired)); }
        else items.push(...planPosthog(desired, ph));
        if (destination) items.push(isError(ph) ? { platform: 'posthog', kind: 'destination', name: destination.name, action: 'unknown' } : planDestination(destination, ph.destinations));
    }
    return {
        items,
        desired,
        ...(destination && { destination }),
        monitored: desired.map(d => ({ id: d.mode.id, slug: d.mode.slug })),
        notMonitored: modes.filter(m => !isMonitored(m)).map(m => ({ id: m.id, slug: m.slug, status: m.status })),
        errors,
    };
}

type ScoreConfigPage = { data: LangfuseScoreConfig[]; meta: { page: number; totalPages: number } };

export async function readLangfuseState(listPage: (page: number) => Promise<ScoreConfigPage>): Promise<LangfuseState> {
    const scoreConfigs: LangfuseScoreConfig[] = [];
    for (let page = 1; ; page++) {
        const out = await listPage(page);
        scoreConfigs.push(...out.data.map(c => ({ id: c.id, name: c.name, dataType: c.dataType, isArchived: c.isArchived, description: c.description ?? null })));
        if (page >= out.meta.totalPages || out.data.length === 0) break;
    }
    return { scoreConfigs };
}

const parseJson = (v: unknown): Record<string, unknown> | null => {
    try { return (typeof v === 'string' ? JSON.parse(v) : v) ?? null; } catch { return null; }
};

const STATE_ROW_LIMIT = 10_000;

/** HogQL caps an unlimited select at a default row count, and a short read would plan `create` for what it missed. */
async function allRows(query: PosthogQuery, hogql: string): Promise<Array<Record<string, unknown>>> {
    const out = await query(`${hogql} limit ${STATE_ROW_LIMIT}`);
    if (out.hasMore) throw new Error(`PostHog has more than ${STATE_ROW_LIMIT} rows for: ${hogql}`);
    return rowsOf(out);
}

/**
 * Insights and alerts through HogQL's system tables, which a query-scoped personal key can read.
 * Only `check:` names matter here, so only they are read; `saved` is left to the API's default.
 */
export async function readPosthogState(query: PosthogQuery): Promise<PosthogState> {
    const managedName = `name like '${METRIC_PREFIX}%'`;
    const insights = (await allRows(query, `select id, name, description from system.insights where deleted = 0 and ${managedName}`)).map(r => ({
        id: Number(r.id), name: (r.name as string | null) ?? null, description: (r.description as string | null) ?? null,
    }));
    const alerts = (await allRows(query, `select id, name, insight_id, enabled, calculation_interval, condition, config from system.alerts where ${managedName}`)).map(r => {
        const condition = parseJson(r.condition);
        const config = parseJson(r.config);
        return {
            id: String(r.id), name: String(r.name ?? ''), insightId: r.insight_id === null || r.insight_id === undefined ? null : Number(r.insight_id),
            enabled: r.enabled === true || r.enabled === 1, calculationInterval: (r.calculation_interval as string | null) ?? null,
            conditionType: (condition?.type as string | undefined) ?? null,
            checkOngoing: (config?.check_ongoing_interval as boolean | null | undefined) ?? null,
        };
    });
    return { insights, alerts };
}

/** Internal destinations through REST (hog_function:read); only needed when a destination is wanted. */
export async function readPosthogDestinations(request: PosthogRequest): Promise<PosthogDestination[]> {
    const out = await request<{ results: Array<{ id: string; name: string; description?: string | null; enabled: boolean }> }>('GET', 'projects/{project}/hog_functions/?type=internal_destination&limit=200');
    return out.results.map(d => ({ id: d.id, name: d.name, description: d.description ?? null, enabled: d.enabled }));
}

// ---- Writing -------------------------------------------------------------------------------

/** Score configs are created, never updated: production scores may already rely on one. */
export type LangfuseWriter = { createScoreConfig(c: DesiredMode['scoreConfig']): Promise<{ id: string }> };

export type PosthogWriter = {
    /** A reason not to write at all (a missing scope), asked once before the first write. */
    preflight?(kinds: SyncKind[]): Promise<string | undefined>;
    createInsight(i: DesiredInsight): Promise<{ id: number }>;
    updateInsight(id: number, i: DesiredInsight): Promise<void>;
    createAlert(a: DesiredAlert, insightId: number): Promise<{ id: string }>;
    updateAlert(id: string, a: DesiredAlert, insightId: number): Promise<void>;
    createDestination?(d: DesiredDestination): Promise<{ id: string }>;
    updateDestination?(id: string, d: DesiredDestination): Promise<void>;
};

export type SyncWriters = { langfuse?: LangfuseWriter; posthog?: PosthogWriter };

export type ApplyOutcome = 'created' | 'updated' | 'failed' | 'skipped';
export type ApplyResult = { item: PlanItem; outcome: ApplyOutcome; id?: string | number; message?: string };
export type ApplyReport = { results: ApplyResult[]; stopped: Partial<Record<SyncPlatform, string>> };

/** What `applyPlan` may write: creations, and updates of PostHog objects eval sync made. */
export const isWritable = (i: PlanItem): boolean => i.action === 'create' || (i.action === 'update' && i.platform === 'posthog' && i.managed === true);

const httpStatus = (e: unknown): number | undefined => {
    const err = e as { status?: unknown; statusCode?: unknown };
    const s = err?.status ?? err?.statusCode;
    return typeof s === 'number' ? s : undefined;
};

/**
 * Executes the plan's writable items, insight before its alert. A 401/403 stops every later
 * write to that platform (a missing scope fails them all the same way); any other error fails
 * only its item, and an alert whose insight was not written is skipped.
 */
export async function applyPlan(plan: SyncPlan, writers: SyncWriters): Promise<ApplyReport> {
    const results: ApplyResult[] = [];
    const stopped: ApplyReport['stopped'] = {};
    const writable = plan.items.filter(isWritable);

    const phKinds = [...new Set(writable.filter(i => i.platform === 'posthog').map(i => i.kind))];
    if (writers.posthog?.preflight && phKinds.length) {
        const why = await writers.posthog.preflight(phKinds).catch(e => `preflight failed: ${(e as Error).message}`);
        if (why) stopped.posthog = why;
    }

    async function step<T extends string | number | void>(item: PlanItem, write: () => Promise<T>): Promise<T | undefined> {
        if (stopped[item.platform]) { results.push({ item, outcome: 'skipped', message: `${item.platform} writes stopped: ${stopped[item.platform]}` }); return undefined; }
        try {
            const id = await write();
            results.push({ item, outcome: item.action === 'create' ? 'created' : 'updated', id: id ?? item.id });
            return id ?? (item.id as T);
        } catch (e) {
            const message = (e as Error).message;
            const status = httpStatus(e);
            if (status === 401 || status === 403) stopped[item.platform] = message;
            results.push({ item, outcome: 'failed', message });
            return undefined;
        }
    }

    const find = (d: DesiredMode, platform: SyncPlatform, kind: SyncKind) => plan.items.find(i => i.modeId === d.mode.id && i.platform === platform && i.kind === kind);
    const skip = (item: PlanItem, message: string) => results.push({ item, outcome: 'skipped', message });

    for (const d of plan.desired) {
        const config = find(d, 'langfuse', 'score-config');
        if (config && isWritable(config)) {
            const lf = writers.langfuse;
            if (!lf) skip(config, 'no Langfuse writer');
            else await step(config, async () => (await lf.createScoreConfig(d.scoreConfig)).id);
        }

        const insight = find(d, 'posthog', 'insight');
        const alert = find(d, 'posthog', 'alert');
        const ph = writers.posthog;
        let insightId = insight?.managed && typeof insight.id === 'number' ? insight.id : undefined;
        if (insight && isWritable(insight)) {
            if (!ph) skip(insight, 'no PostHog writer');
            else if (insight.action === 'create') insightId = await step(insight, async () => (await ph.createInsight(d.insight)).id);
            else if ((await step(insight, async () => ph.updateInsight(insight.id as number, d.insight))) === undefined) insightId = undefined;
        }
        if (alert && isWritable(alert) && d.alert) {
            const a = d.alert;
            if (!ph) skip(alert, 'no PostHog writer');
            else if (insightId === undefined && !stopped.posthog) skip(alert, 'its insight was not written');
            else if (alert.action === 'create') await step(alert, async () => (await ph.createAlert(a, insightId!)).id);
            else await step(alert, async () => ph.updateAlert(alert.id as string, a, insightId!));
        }
    }
    const destItem = plan.items.find(i => i.kind === 'destination');
    if (destItem && isWritable(destItem) && plan.destination) {
        const ph = writers.posthog;
        const d = plan.destination;
        if (!ph?.createDestination || !ph.updateDestination) skip(destItem, 'no PostHog destination writer');
        else if (destItem.action === 'create') await step(destItem, async () => (await ph.createDestination!(d)).id);
        else await step(destItem, async () => ph.updateDestination!(destItem.id as string, d));
    }
    return { results, stopped };
}

/** The real Langfuse writer: create only, through the public score-configs API. */
export function langfuseWriter(create: (req: { name: string; dataType: 'BOOLEAN'; description: string }) => Promise<{ id: string }>): LangfuseWriter {
    return { createScoreConfig: c => create({ name: c.name, dataType: c.dataType, description: c.description }) };
}

const SCOPE: Record<SyncKind, string> = { 'score-config': '', insight: 'insight:write', alert: 'alert:write', destination: 'hog_function:write' };

/**
 * The real PostHog writer over the REST API. The alert's subscriber is the key's own user,
 * which the preflight reads along with the key's scopes.
 */
const destinationBody = (d: DesiredDestination) => ({
    type: 'internal_destination', name: d.name, description: d.description, template_id: d.templateId,
    inputs: d.inputs, filters: d.filters, enabled: true,
});

/**
 * Sends a sample firing alert through the destination: what a real one will look like where it lands.
 * Only the invocation's status comes back: its logs can echo the webhook.
 */
export async function testDestination(request: PosthogRequest, id: string, d: DesiredDestination, projectUrl: string): Promise<string> {
    const out = await request<{ status?: unknown } | null>('POST', `projects/{project}/hog_functions/${id}/invocations/`, {
        configuration: destinationBody(d),
        mock_async_functions: false,
        globals: {
            project: { url: projectUrl, name: 'test' },
            event: {
                event: '$insight_alert_firing', distinct_id: 'eval-sync-test', timestamp: new Date().toISOString(), uuid: '00000000-0000-0000-0000-000000000000',
                properties: {
                    alert_name: `${METRIC_PREFIX}context_empty_after_error alert (TEST)`, insight_name: `${METRIC_PREFIX}context_empty_after_error`,
                    insight_id: 'TEST', alert_id: 'TEST', breaches: 'TEST message from eval sync --test-destination: the fail count (1) is above the threshold (0).',
                },
            },
        },
    });
    return typeof out?.status === 'string' ? out.status : 'unknown';
}

export function posthogWriter(request: PosthogRequest, project: string): PosthogWriter {
    let subscribers: number[] = [];
    const insightBody = (i: DesiredInsight) => ({ name: i.name, description: i.description, query: i.query });
    const alertBody = (a: DesiredAlert, insightId: number) => ({
        name: a.name, insight: insightId, enabled: true, calculation_interval: a.calculationInterval,
        condition: a.condition, threshold: a.threshold, config: a.config,
    });
    return {
        async preflight(kinds) {
            const key = await request<{ scopes?: string[]; scoped_teams?: number[] | null; user_id?: number }>('GET', 'personal_api_keys/@current/');
            const scopes = key.scopes ?? [];
            const missing = kinds.map(k => SCOPE[k]).filter(s => s && !scopes.includes('*') && !scopes.includes(s));
            if (missing.length) return `the personal API key lacks scope ${missing.join(', ')}`;
            if (key.scoped_teams?.length && !key.scoped_teams.map(String).includes(project)) return `the personal API key is not scoped to project ${project}`;
            if (key.user_id) subscribers = [key.user_id];
            return undefined;
        },
        createInsight: async i => ({ id: (await request<{ id: number }>('POST', 'projects/{project}/insights/', insightBody(i))).id }),
        updateInsight: async (id, i) => { await request('PATCH', `projects/{project}/insights/${id}/`, insightBody(i)); },
        createAlert: async (a, insightId) => ({ id: (await request<{ id: string }>('POST', 'projects/{project}/alerts/', { ...alertBody(a, insightId), subscribed_users: subscribers })).id }),
        updateAlert: async (id, a, insightId) => { await request('PATCH', `projects/{project}/alerts/${id}/`, alertBody(a, insightId)); },
        createDestination: async d => ({ id: (await request<{ id: string }>('POST', 'projects/{project}/hog_functions/', destinationBody(d))).id }),
        updateDestination: async (id, d) => { await request('PATCH', `projects/{project}/hog_functions/${id}/`, destinationBody(d)); },
    };
}

// ---- Output --------------------------------------------------------------------------------

const ACTION_ORDER: SyncAction[] = ['create', 'update', 'orphaned', 'manual', 'unknown', 'up-to-date'];
const ACTION_LABEL: Record<SyncAction, string> = { create: 'create', update: 'update', orphaned: 'orphaned', manual: 'manual', unknown: 'unknown', 'up-to-date': 'up to date' };
const SECTIONS: Array<[SyncPlatform, SyncKind, string]> = [
    ['langfuse', 'score-config', 'Langfuse score configs'],
    ['posthog', 'insight', 'PostHog insights ($ai_metric check:<slug>)'],
    ['posthog', 'alert', 'PostHog alerts'],
    ['posthog', 'destination', 'PostHog alert destinations'],
    ['langfuse', 'alert', 'Langfuse alerts (UI only, no API)'],
];

export function formatPlan(plan: SyncPlan, where: Partial<Record<SyncPlatform, string>> = {}): string {
    const lines: string[] = [];
    lines.push(`Monitored modes: ${plan.monitored.map(m => `${m.id} ${m.slug}`).join(', ') || 'none'}`);
    if (plan.notMonitored.length) lines.push(`Not monitored, no platform objects: ${plan.notMonitored.map(m => `${m.id} (${m.status})`).join(', ')}`);
    const platforms = new Set(plan.items.map(i => i.platform));
    for (const [platform, kind, title] of SECTIONS) {
        if (!platforms.has(platform)) continue;
        const items = plan.items.filter(i => i.platform === platform && i.kind === kind).sort((a, b) => ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action) || a.name.localeCompare(b.name));
        lines.push('', `${title}${where[platform] ? ` — ${where[platform]}` : ''}`);
        if (plan.errors[platform] && kind !== 'alert') lines.push(`  state not read: ${plan.errors[platform]}`);
        if (items.length === 0) lines.push('  (nothing)');
        for (const i of items) {
            lines.push(`  ${ACTION_LABEL[i.action].padEnd(10)}  ${i.name}${i.modeId ? `  (${i.modeId})` : ''}${i.id !== undefined ? `  id ${i.id}` : ''}${i.detail ? `  — ${i.detail}` : ''}`);
            if (i.alertText && (i.kind === 'alert')) lines.push(`              alert: "${i.alertText}"`);
            for (const n of i.notes ?? []) lines.push(`              approximation: ${n}`);
            for (const m of i.manual ?? []) lines.push(`              manual: ${m}`);
        }
    }
    const count = (a: SyncAction) => plan.items.filter(i => i.action === a).length;
    lines.push('', `${count('create')} to create, ${count('update')} to update, ${count('up-to-date')} up to date, ${count('orphaned')} orphaned, ${count('manual')} manual, ${count('unknown')} unknown`);
    const writable = plan.items.filter(isWritable).length;
    lines.push(writable ? `${writable} item(s) --apply would write. Orphaned, manual and unknown items are never written.` : 'Everything eval sync manages is up to date: --apply has nothing to write.');
    return lines.join('\n');
}

export function formatApply(report: ApplyReport): string {
    const lines = report.results.map(r => `  ${r.outcome.padEnd(8)}  ${r.item.platform} ${r.item.kind} ${r.item.name}${r.id !== undefined ? `  id ${r.id}` : ''}${r.message ? `  — ${r.message}` : ''}`);
    for (const [platform, why] of Object.entries(report.stopped)) lines.push(`  ${platform}: writes stopped — ${why}`);
    const count = (o: ApplyOutcome) => report.results.filter(r => r.outcome === o).length;
    lines.push(`${count('created')} created, ${count('updated')} updated, ${count('failed')} failed, ${count('skipped')} skipped`);
    return lines.join('\n');
}

type TrendSeries = { label?: string; breakdown_value?: unknown; data?: number[]; days?: string[] };

/**
 * What each desired insight shows now, computed by running its query through the query API
 * (query:read is enough), so the data an alert would read can be checked before the insight exists.
 */
export async function insightData(desired: DesiredMode[], request: PosthogRequest, intervals = 3): Promise<string> {
    const lines: string[] = [];
    for (const d of desired) {
        lines.push(`${d.insight.name} — ${d.insight.summary}`);
        try {
            const out = await request<{ results?: TrendSeries[] }>('POST', 'projects/{project}/query/', { query: (d.insight.query as { source: unknown }).source, refresh: 'force_blocking' });
            const series = (out.results ?? []).filter(s => (s.data ?? []).some(v => v));
            if (series.length === 0) lines.push('  no non-zero interval');
            for (const s of series) {
                const recent = (s.data ?? []).map((v, i) => [s.days?.[i] ?? String(i), v] as const).slice(-intervals);
                lines.push(`  ${s.breakdown_value !== undefined ? `${s.breakdown_value}: ` : ''}${recent.map(([day, v]) => `${day} ${Number.isInteger(v) ? v : v.toFixed(4)}`).join(', ')}`);
            }
        } catch (e) {
            lines.push(`  query failed: ${(e as Error).message.slice(0, 200)}`);
        }
    }
    return lines.join('\n');
}
