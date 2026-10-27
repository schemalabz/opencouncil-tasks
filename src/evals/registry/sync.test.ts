import { describe, expect, it } from 'vitest';
import { parseAlert } from './alertSpec.js';
import type { PosthogRequest } from '../../lib/telemetry/posthogQuery.js';
import type { FailureMode } from './schema.js';
import {
    applyPlan, desiredDestination, desiredObjects, formatPlan, isWritable, planSync, posthogWriter, readLangfuseState, readPosthogState,
    type LangfuseState, type PlanItem, type PosthogState, type SyncWriters,
} from './sync.js';

const mode = (over: Partial<FailureMode>): FailureMode => ({
    id: 'FM-0001', slug: 'context_disclaimer_preamble', title: 'disclaimer', definition: 'd', suite: 'summarize.context', scope: 'call',
    severity: 'degraded', impact: 'visible', status: 'confirmed', ...over,
});

describe('parseAlert', () => {
    it('reads a rate against a baseline, a minimum volume and a breakdown', () => {
        expect(parseAlert('fail rate over 7 days > 2× its 30-day baseline, min 50 subject-context-search calls; per-city breakdown in the alert')).toEqual({
            text: expect.any(String), kind: 'rate', windowDays: 7, factor: 2, baselineDays: 30,
            minVolume: { count: 50, unit: 'subject-context-search calls' }, breakdown: 'city', manual: [],
        });
    });

    it('keeps the clauses it does not understand, verbatim', () => {
        const spec = parseAlert("any run with a fail: Discord immediately with the run's meeting and the failing subject count");
        expect(spec).toMatchObject({ kind: 'any', cadence: 'immediate', channel: 'discord' });
        expect(spec.manual).toEqual(["Discord immediately with the run's meeting and the failing subject count"]);
        expect(parseAlert('any fail on a structured-output label; daily digest grouped by label')).toMatchObject({
            kind: 'any', cadence: 'daily', breakdown: 'label', manual: ['any fail on a structured-output label'],
        });
        expect(parseAlert('any fail per city per week; daily digest')).toMatchObject({ kind: 'any', breakdown: 'city', windowDays: 7, cadence: 'daily', manual: [] });
        expect(parseAlert('page whoever is on call')).toEqual({ text: 'page whoever is on call', manual: ['page whoever is on call'] });
    });
});

describe('planSync', () => {
    const monitored = mode({});
    const any = mode({ id: 'FM-0002', slug: 'context_empty_after_error', alert: 'any run with a fail: Discord immediately' });
    const candidate = mode({ id: 'FM-0010', slug: 'not_a_decision_with_number', status: 'candidate', alert: 'any fail per city per week' });
    const withAlert = { ...monitored, alert: 'fail rate per city > 3× its 30-day baseline, min 5 summarize runs' };
    const modes = [withAlert, any, candidate];
    const [dRate, dAny] = desiredObjects(modes);

    const find = (items: PlanItem[], kind: PlanItem['kind'], platform: PlanItem['platform'], name: string) => items.find(i => i.kind === kind && i.platform === platform && i.name === name);

    it('mirrors only monitored modes, as BOOLEAN score configs named by slug and check:<slug> insights and alerts', () => {
        expect(desiredObjects(modes).map(d => d.mode.id)).toEqual(['FM-0001', 'FM-0002']);
        expect(dRate.scoreConfig).toMatchObject({ name: 'context_disclaimer_preamble', dataType: 'BOOLEAN' });
        expect(dRate.alert).toMatchObject({ condition: { type: 'relative_increase' }, threshold: { configuration: { type: 'percentage', bounds: { upper: 2 } } }, calculationInterval: 'daily' });
        expect(dAny.alert).toMatchObject({ condition: { type: 'absolute_value' }, threshold: { configuration: { type: 'absolute', bounds: { upper: 0 } } }, calculationInterval: 'hourly' });
        expect(JSON.stringify(dRate.insight.query)).toContain('check:context_disclaimer_preamble');
    });

    it('diffs against platform state: create, up to date, update and orphaned', () => {
        const posthog: PosthogState = {
            insights: [
                { id: 11, name: 'check:context_disclaimer_preamble', description: `Managed by eval sync from FM-0001. [eval-sync ${dRate.insight.fingerprint}]` },
                { id: 12, name: 'check:context_empty_after_error', description: 'hand-made' },
                { id: 13, name: 'check:old_mode', description: null },
                { id: 14, name: 'Daily active users', description: null },
            ],
            alerts: [
                { id: 'a1', name: 'check:context_disclaimer_preamble alert', insightId: 11, enabled: true, calculationInterval: 'daily', conditionType: 'relative_increase' },
                { id: 'a2', name: 'check:context_empty_after_error alert', insightId: 12, enabled: false, calculationInterval: 'daily', conditionType: 'absolute_value' },
                { id: 'a3', name: 'check:old_mode alert', insightId: 13, enabled: true, calculationInterval: 'daily', conditionType: 'absolute_value' },
            ],
        };
        const plan = planSync(modes, {
            langfuse: { scoreConfigs: [
                { id: 's1', name: 'context_disclaimer_preamble', dataType: 'BOOLEAN', isArchived: false },
                { id: 's2', name: 'not_a_decision_with_number', dataType: 'BOOLEAN', isArchived: false },
                { id: 's3', name: 'someone_elses_score', dataType: 'NUMERIC', isArchived: false },
            ] },
            posthog,
        });
        const { items } = plan;
        expect(find(items, 'score-config', 'langfuse', 'context_disclaimer_preamble')).toMatchObject({ action: 'up-to-date', id: 's1' });
        expect(find(items, 'score-config', 'langfuse', 'context_empty_after_error')).toMatchObject({ action: 'create' });
        expect(find(items, 'score-config', 'langfuse', 'not_a_decision_with_number')).toMatchObject({ action: 'orphaned', detail: 'its mode is not monitored' });
        expect(find(items, 'score-config', 'langfuse', 'someone_elses_score')).toBeUndefined();

        expect(find(items, 'insight', 'posthog', 'check:context_disclaimer_preamble')).toMatchObject({ action: 'up-to-date', id: 11 });
        expect(find(items, 'insight', 'posthog', 'check:context_empty_after_error')).toMatchObject({ action: 'manual', id: 12, managed: false });
        expect(find(items, 'insight', 'posthog', 'check:old_mode')).toMatchObject({ action: 'orphaned' });
        expect(items.some(i => i.name === 'Daily active users')).toBe(false);

        expect(find(items, 'alert', 'posthog', 'check:context_disclaimer_preamble alert')).toMatchObject({ action: 'up-to-date' });
        expect(find(items, 'alert', 'posthog', 'check:context_empty_after_error alert')).toMatchObject({ action: 'manual', managed: false, detail: 'watches insight 12, which eval sync did not make' });
        expect(items.filter(isWritable).map(i => `${i.kind} ${i.name}`)).toEqual(['score-config context_empty_after_error']);
        expect(find(items, 'alert', 'posthog', 'check:old_mode alert')).toMatchObject({ action: 'orphaned' });
        expect(items.filter(i => i.platform === 'langfuse' && i.kind === 'alert').map(i => i.action)).toEqual(['manual', 'manual']);
        expect(plan.notMonitored).toEqual([{ id: 'FM-0010', slug: 'not_a_decision_with_number', status: 'candidate' }]);
        expect(formatPlan(plan)).toContain('1 item(s) --apply would write');
    });

    it('marks a platform it could not read as unknown instead of guessing', () => {
        const plan = planSync(modes, { langfuse: { error: 'HTTP 401' }, posthog: { insights: [], alerts: [] } });
        expect(plan.errors).toEqual({ langfuse: 'HTTP 401' });
        expect(plan.items.filter(i => i.platform === 'langfuse' && i.kind === 'score-config').map(i => i.action)).toEqual(['unknown', 'unknown']);
        expect(formatPlan(plan)).toContain('state not read: HTTP 401');
    });

    it('lists an alert with no testable condition as manual', () => {
        const plan = planSync([mode({ alert: 'page whoever is on call' })], { langfuse: { scoreConfigs: [] }, posthog: { insights: [], alerts: [] } });
        expect(find(plan.items, 'alert', 'posthog', 'check:context_disclaimer_preamble alert')).toMatchObject({
            action: 'manual', manual: ['no condition with a threshold recognised in the alert text', 'page whoever is on call'],
        });
    });
});

describe('platform readers', () => {
    it('pages through Langfuse score configs', async () => {
        const pages = [
            { data: [{ id: '1', name: 'a', dataType: 'BOOLEAN', isArchived: false }], meta: { page: 1, totalPages: 2 } },
            { data: [{ id: '2', name: 'b', dataType: 'NUMERIC', isArchived: true, description: 'x' }], meta: { page: 2, totalPages: 2 } },
        ];
        const state = await readLangfuseState(async page => pages[page - 1]);
        expect(state.scoreConfigs.map(c => c.name)).toEqual(['a', 'b']);
    });

    it('reads PostHog insights and alerts from the HogQL system tables', async () => {
        const asked: string[] = [];
        const state = await readPosthogState(async q => {
            asked.push(q);
            return q.includes('system.insights')
                ? { columns: ['id', 'name', 'description'], results: [[7, 'check:x', 'Managed by eval sync']] }
                : { columns: ['id', 'name', 'insight_id', 'enabled', 'calculation_interval', 'condition'], results: [['u1', 'check:x alert', 7, true, 'daily', '{"type": "absolute_value"}']] };
        });
        expect(asked.every(q => q.startsWith('select') && q.includes("name like 'check:%'") && q.endsWith('limit 10000'))).toBe(true);
        expect(state).toEqual({
            insights: [{ id: 7, name: 'check:x', description: 'Managed by eval sync' }],
            alerts: [{ id: 'u1', name: 'check:x alert', insightId: 7, enabled: true, calculationInterval: 'daily', conditionType: 'absolute_value', checkOngoing: null }],
        });
    });

    it('refuses a read that stopped at the row cap, so the plan never creates what it did not see', async () => {
        const read = readPosthogState(async q => (q.includes('system.insights')
            ? { columns: ['id', 'name', 'description'], results: [[7, 'check:x', 'Managed by eval sync']], hasMore: true }
            : { columns: ['id', 'name'], results: [] }));
        await expect(read).rejects.toThrow(/more than 10000 rows/);
    });
});

/** An in-memory Langfuse + PostHog that the fake writers change and the planner reads back. */
function fakePlatforms(start: { langfuse?: LangfuseState; posthog?: PosthogState } = {}) {
    const lf: LangfuseState = structuredClone(start.langfuse ?? { scoreConfigs: [] });
    const ph: PosthogState = structuredClone(start.posthog ?? { insights: [], alerts: [] });
    const calls: string[] = [];
    let next = 100;
    const writers: SyncWriters = {
        langfuse: {
            async createScoreConfig(c) {
                calls.push(`langfuse create ${c.name}`);
                const id = `sc${next++}`;
                lf.scoreConfigs.push({ id, name: c.name, dataType: c.dataType, isArchived: false, description: c.description });
                return { id };
            },
        },
        posthog: {
            async createInsight(i) {
                calls.push(`insight create ${i.name}`);
                const id = next++;
                ph.insights.push({ id, name: i.name, description: i.description });
                return { id };
            },
            async updateInsight(id, i) {
                calls.push(`insight update ${id}`);
                Object.assign(ph.insights.find(x => x.id === id)!, { description: i.description });
            },
            async createAlert(a, insightId) {
                calls.push(`alert create ${a.name} on ${insightId}`);
                const id = `al${next++}`;
                ph.alerts.push({ id, name: a.name, insightId, enabled: true, calculationInterval: a.calculationInterval, conditionType: a.condition.type, checkOngoing: a.config.check_ongoing_interval });
                return { id };
            },
            async updateAlert(id, a, insightId) {
                calls.push(`alert update ${id} on ${insightId}`);
                Object.assign(ph.alerts.find(x => x.id === id)!, { insightId, enabled: true, calculationInterval: a.calculationInterval, conditionType: a.condition.type, checkOngoing: a.config.check_ongoing_interval });
            },
        },
    };
    return { lf, ph, calls, writers, state: () => ({ langfuse: lf, posthog: ph }) };
}

describe('applyPlan', () => {
    const modes = [
        mode({ alert: 'fail rate over 7 days > 2× its 30-day baseline, min 50 subject-context-search calls; per-city breakdown in the alert' }),
        mode({ id: 'FM-0002', slug: 'context_empty_after_error', alert: 'any run with a fail: Discord immediately' }),
        mode({ id: 'FM-0003', slug: 'summary_stale_future_tense', alert: 'page whoever is on call' }),
    ];

    it('creates every managed object, each alert on its new insight, and a second apply writes nothing', async () => {
        const p = fakePlatforms();
        const first = await applyPlan(planSync(modes, p.state()), p.writers);
        expect(first.results.every(r => r.outcome === 'created')).toBe(true);
        expect(p.calls).toEqual([
            'langfuse create context_disclaimer_preamble', 'insight create check:context_disclaimer_preamble', 'alert create check:context_disclaimer_preamble alert on 101',
            'langfuse create context_empty_after_error', 'insight create check:context_empty_after_error', 'alert create check:context_empty_after_error alert on 104',
            'langfuse create summary_stale_future_tense', 'insight create check:summary_stale_future_tense',
        ]);

        const again = planSync(modes, p.state());
        expect(again.items.filter(i => i.action !== 'manual').every(i => i.action === 'up-to-date')).toBe(true);
        expect(formatPlan(again)).toContain('--apply has nothing to write');
        p.calls.length = 0;
        expect((await applyPlan(again, p.writers)).results).toEqual([]);
        expect(p.calls).toEqual([]);
    });

    it('updates a managed insight whose query changed and the alert that drifted, in place', async () => {
        const p = fakePlatforms();
        await applyPlan(planSync(modes, p.state()), p.writers);
        p.ph.insights[0].description = 'Managed by eval sync from FM-0001. [eval-sync 00000000]';
        Object.assign(p.ph.alerts[1], { enabled: false, calculationInterval: 'daily' });
        p.calls.length = 0;
        const report = await applyPlan(planSync(modes, p.state()), p.writers);
        expect(p.calls).toEqual(['insight update 101', 'alert update al105 on 104']);
        expect(report.results.map(r => r.outcome)).toEqual(['updated', 'updated']);
        expect(planSync(modes, p.state()).items.filter(isWritable)).toEqual([]);
    });

    it('never touches an object eval sync did not make, nor a Langfuse config that differs', async () => {
        const p = fakePlatforms({
            langfuse: { scoreConfigs: [{ id: 's1', name: 'context_disclaimer_preamble', dataType: 'NUMERIC', isArchived: false }, { id: 's2', name: 'context_empty_after_error', dataType: 'BOOLEAN', isArchived: true }] },
            posthog: {
                insights: [{ id: 7, name: 'check:context_disclaimer_preamble', description: 'made by hand' }, { id: 8, name: 'check:old', description: 'Managed by eval sync from FM-0099' }],
                alerts: [
                    { id: 'h1', name: 'check:context_disclaimer_preamble alert', insightId: 7, enabled: false, calculationInterval: 'daily', conditionType: 'absolute_value' },
                    { id: 'h2', name: 'check:context_empty_after_error alert', insightId: 7, enabled: true, calculationInterval: 'hourly', conditionType: 'absolute_value' },
                ],
            },
        });
        const plan = planSync(modes, p.state());
        expect(plan.items.filter(i => i.id !== undefined).map(i => `${i.id} ${i.action}`)).toEqual(['s1 manual', 's2 manual', '7 manual', 'h1 manual', 'h2 manual', '8 orphaned']);
        await applyPlan(plan, p.writers);
        expect(p.calls).toEqual([
            'insight create check:context_empty_after_error', 'langfuse create summary_stale_future_tense', 'insight create check:summary_stale_future_tense',
        ]);
    });

    it('stops a platform at the first 401/403 and carries on with the other', async () => {
        const p = fakePlatforms();
        p.writers.posthog!.createInsight = async () => { throw Object.assign(new Error("HTTP 403: API key missing required scope 'insight:write'"), { status: 403 }); };
        const report = await applyPlan(planSync(modes, p.state()), p.writers);
        expect(p.calls).toEqual(['langfuse create context_disclaimer_preamble', 'langfuse create context_empty_after_error', 'langfuse create summary_stale_future_tense']);
        expect(report.stopped.posthog).toContain('insight:write');
        expect(report.results.filter(r => r.item.platform === 'posthog').map(r => r.outcome)).toEqual(['failed', 'skipped', 'skipped', 'skipped', 'skipped']);
    });

    it('writes nothing to a platform whose preflight names a missing scope', async () => {
        const p = fakePlatforms();
        p.writers.posthog!.preflight = async kinds => `the personal API key lacks scope ${kinds.join(', ')}`;
        const report = await applyPlan(planSync(modes, p.state()), p.writers);
        expect(p.calls.every(c => c.startsWith('langfuse'))).toBe(true);
        expect(report.stopped.posthog).toBe('the personal API key lacks scope insight, alert');
    });

    it('fails one item on any other error and skips only the alert that depended on it', async () => {
        const p = fakePlatforms();
        const create = p.writers.posthog!.createInsight;
        p.writers.posthog!.createInsight = async i => {
            if (i.name === 'check:context_disclaimer_preamble') throw Object.assign(new Error('HTTP 400: bad query'), { status: 400 });
            return create(i);
        };
        const report = await applyPlan(planSync(modes, p.state(), 'production', 'posthog'), p.writers);
        expect(report.results.map(r => `${r.outcome} ${r.item.name}`)).toEqual([
            'failed check:context_disclaimer_preamble', 'skipped check:context_disclaimer_preamble alert',
            'created check:context_empty_after_error', 'created check:context_empty_after_error alert', 'created check:summary_stale_future_tense',
        ]);
        expect(p.calls.some(c => c.startsWith('langfuse'))).toBe(false);
    });
});

describe('posthogWriter', () => {
    const [d] = desiredObjects([mode({ id: 'FM-0002', slug: 'context_empty_after_error', alert: 'any run with a fail: Discord immediately' })]);
    const recorder = (key: Record<string, unknown>) => {
        const sent: Array<[string, string, unknown]> = [];
        const request = (async (method: string, path: string, body?: unknown) => {
            sent.push([method, path, body]);
            return path.startsWith('personal_api_keys') ? key : { id: path.includes('alerts') ? 'a1' : 42 };
        }) as PosthogRequest;
        return { sent, request };
    };

    it('names the scopes the key lacks for the kinds it would write', async () => {
        expect(await posthogWriter(recorder({ scopes: ['query:read', 'insight:write'] }).request, '299203').preflight!(['insight', 'alert'])).toBe('the personal API key lacks scope alert:write');
        expect(await posthogWriter(recorder({ scopes: ['*'], scoped_teams: [1] }).request, '299203').preflight!(['insight'])).toBe('the personal API key is not scoped to project 299203');
    });

    it('creates the insight and an alert on it subscribed to the key\'s user', async () => {
        const { sent, request } = recorder({ scopes: ['insight:write', 'alert:write'], scoped_teams: [299203], user_id: 7 });
        const w = posthogWriter(request, '299203');
        expect(await w.preflight!(['insight', 'alert'])).toBeUndefined();
        expect(await w.createInsight(d.insight)).toEqual({ id: 42 });
        expect(await w.createAlert(d.alert!, 42)).toEqual({ id: 'a1' });
        expect(sent[1]).toEqual(['POST', 'projects/{project}/insights/', { name: 'check:context_empty_after_error', description: d.insight.description, query: d.insight.query }]);
        expect(sent[2]).toEqual(['POST', 'projects/{project}/alerts/', {
            name: 'check:context_empty_after_error alert', insight: 42, enabled: true, calculation_interval: 'hourly',
            condition: { type: 'absolute_value' }, threshold: { configuration: { type: 'absolute', bounds: { upper: 0 } } },
            config: { type: 'TrendsAlertConfig', series_index: 0, check_ongoing_interval: false }, subscribed_users: [7],
        }]);
    });
});

describe('alert destination', () => {
    const modes = [mode({ alert: 'any run with a fail: Discord immediately' })];
    const dest = desiredDestination('https://discord.example/webhook/secret');
    const state = (destinations?: PosthogState['destinations']): PosthogState => ({ insights: [], alerts: [], destinations });
    const item = (destinations?: PosthogState['destinations']) =>
        planSync(modes, { posthog: state(destinations) }, 'production', 'posthog', dest).items.find(i => i.kind === 'destination')!;

    it('never puts the webhook in its description or fingerprint', () => {
        expect(dest.description).not.toContain('secret');
        expect(dest.fingerprint).not.toContain('secret');
        const printed = JSON.stringify(planSync(modes, { posthog: state([]) }, 'production', 'posthog', dest));
        expect(printed).not.toContain('secret');
        expect(printed).toContain(`[redacted, eval-sync ${dest.fingerprint}]`);
    });

    it('creates it, keeps a managed one up to date, and leaves one it did not make alone', () => {
        expect(item([]).action).toBe('create');
        expect(item([{ id: 'd1', name: dest.name, description: dest.description, enabled: true }]).action).toBe('up-to-date');
        expect(item([{ id: 'd1', name: dest.name, description: 'Managed by eval sync [eval-sync 00000000]', enabled: true }]).action).toBe('update');
        const foreign = item([{ id: 'd1', name: dest.name, description: 'made by hand', enabled: true }]);
        expect(foreign.action).toBe('manual');
        expect(isWritable(foreign)).toBe(false);
    });

    it('writes it through the destination writer', async () => {
        const created: string[] = [];
        const plan = planSync(modes, { posthog: state([]) }, 'production', 'posthog', dest);
        const writers: SyncWriters = { posthog: {
            createInsight: async () => ({ id: 1 }), updateInsight: async () => {}, createAlert: async () => ({ id: 'a' }), updateAlert: async () => {},
            createDestination: async d => { created.push(d.name); return { id: 'd1' }; }, updateDestination: async () => {},
        } };
        const report = await applyPlan(plan, writers);
        expect(created).toEqual([dest.name]);
        expect(report.results.find(r => r.item.kind === 'destination')?.outcome).toBe('created');
    });
});
