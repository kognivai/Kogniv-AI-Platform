const express = require('express');
const path = require('path');
const helmet = require('helmet');
const session = require('express-session');
const rateLimit = require('express-rate-limit');

const app = express();

// ─── Security middleware ───────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false })); // CSP managed separately if needed
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || (() => { throw new Error('SESSION_SECRET env var required'); })(),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' },
}));

const limiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);

// ─── Auth ─────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const validEmail = process.env.ADMIN_EMAIL;
  const validPassword = process.env.ADMIN_PASSWORD;
  if (!validEmail || !validPassword) return res.status(500).json({ error: 'Auth not configured' });
  if (email === validEmail && password === validPassword) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Invalid credentials' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ authenticated: true });
});

// ─── Input validation helpers ─────────────────────────────────────────────────
const SN_HOST_RE = /^https?:\/\/[a-zA-Z0-9-]+\.service-now\.com$/;
const SYS_ID_RE  = /^[a-f0-9]{32}$/;
const TABLE_RE   = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validateInstanceUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const clean = url.replace(/\/$/, '');
  return SN_HOST_RE.test(clean);
}

function validateSysId(id) {
  return typeof id === 'string' && SYS_ID_RE.test(id);
}

function validateTableName(table) {
  return typeof table === 'string' && TABLE_RE.test(table) && table.length <= 80;
}

// ─── Fetch with timeout ────────────────────────────────────────────────────────
function fetchWithTimeout(url, opts, ms = 15_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// ─── ServiceNow helpers ───────────────────────────────────────────────────────
function snHeaders(username, password) {
  const encoded = Buffer.from(`${username}:${password}`).toString('base64');
  return {
    'Authorization': `Basic ${encoded}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };
}

async function snGet(instanceUrl, path, username, password) {
  const url = `${instanceUrl.replace(/\/$/, '')}${path}`;
  const res = await fetchWithTimeout(url, { headers: snHeaders(username, password) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ServiceNow ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

function classifyNode(actionType, actionName) {
  const t = (actionType || '').toLowerCase();
  const n = (actionName || '').toLowerCase();
  if (t.includes('approval') || n.includes('approval') || n.includes('approve'))
    return { class: 'APPROVAL_GATE', weight: 0.8, label: 'Approval Gate' };
  if (t.includes('if') || t.includes('decision') || t.includes('condition') || n.includes('condition'))
    return { class: 'DECISION_NODE', weight: 0.7, label: 'Decision Node' };
  if (t.includes('lookup') || t.includes('query') || n.includes('lookup'))
    return { class: 'DATA_LOOKUP', weight: 0.5, label: 'Data Lookup' };
  if (t.includes('rest') || t.includes('integration') || t.includes('spoke') || n.includes('integration'))
    return { class: 'INTEGRATION_CALL', weight: 0.3, label: 'Integration Call' };
  if (t.includes('notification') || t.includes('email') || t.includes('notify') || n.includes('notify'))
    return { class: 'NOTIFICATION', weight: 0.2, label: 'Notification' };
  if (t.includes('script') || t.includes('execute') || n.includes('script'))
    return { class: 'SCRIPT_BLOCK', weight: 0.4, label: 'Script Block' };
  return { class: 'ACTION', weight: 0.3, label: 'Action' };
}

function scoreFlow(flow, actions, recordCount) {
  const nodeClasses = actions.map(a => classifyNode(a.action_type, a.name));
  const highSignal = nodeClasses.filter(n => n.weight >= 0.5).length;
  const automationPotential = Math.min(10, (highSignal / Math.max(actions.length, 1)) * 10 + 2);
  const approvals = nodeClasses.filter(n => n.class === 'APPROVAL_GATE').length;
  const decisions = nodeClasses.filter(n => n.class === 'DECISION_NODE').length;
  const businessImpact = Math.min(10, approvals * 2 + decisions * 1.5 + 1);
  const scripts = nodeClasses.filter(n => n.class === 'SCRIPT_BLOCK').length;
  const integrations = nodeClasses.filter(n => n.class === 'INTEGRATION_CALL').length;
  const complexity = Math.max(0, 10 - scripts * 1.5 - integrations * 0.8);
  const dataAvail = recordCount > 10000 ? 9 : recordCount > 1000 ? 7 : recordCount > 100 ? 5 : 3;
  const effort = Math.max(1, 10 - actions.length / 5);
  const composite = 0.30 * automationPotential + 0.25 * businessImpact +
    0.20 * complexity + 0.15 * dataAvail + 0.10 * effort;
  const score = parseFloat(Math.min(10, Math.max(0, composite)).toFixed(2));
  let tier = 'P3', tierLabel = 'Monitor';
  if (score >= 8.5)      { tier = 'P0'; tierLabel = 'Quick Win'; }
  else if (score >= 6.5) { tier = 'P1'; tierLabel = 'High Value'; }
  else if (score >= 4.0) { tier = 'P2'; tierLabel = 'Medium Term'; }
  return {
    score, tier, tierLabel,
    dimensions: {
      automationPotential: parseFloat(automationPotential.toFixed(1)),
      businessImpact: parseFloat(businessImpact.toFixed(1)),
      aiComplexity: parseFloat(complexity.toFixed(1)),
      dataAvailability: parseFloat(dataAvail.toFixed(1)),
      effortScore: parseFloat(effort.toFixed(1)),
    },
    nodeBreakdown: {
      approvalGates: approvals, decisionNodes: decisions,
      scriptBlocks: scripts, integrationCalls: integrations,
      notifications: nodeClasses.filter(n => n.class === 'NOTIFICATION').length,
      totalNodes: actions.length,
    },
  };
}

function recommendPlatform(score, flowName, nodeBreakdown) {
  const n = (flowName || '').toLowerCase();
  // ITSM/ITOM/CSM → stay in ServiceNow
  if (n.includes('incident') || n.includes('change') || n.includes('sla') ||
      n.includes('alert') || n.includes('cmdb') || n.includes('config') ||
      n.includes('knowledge') || n.includes('virtual agent') || n.includes('problem')) {
    return 'NOW Assist';
  }
  // HR/Finance → Power Automate
  if (n.includes('hr') || n.includes('onboard') || n.includes('offboard') ||
      n.includes('employee') || n.includes('finance') || n.includes('invoice') ||
      n.includes('vendor') || n.includes('procurement'))
    return 'Power Automate';
  // CRM/Customer → Salesforce
  if (n.includes('customer') || n.includes('case') || n.includes('crm') ||
      n.includes('salesforce'))
    return 'Salesforce Agentforce';
  // Complex technical → Temporal
  if ((nodeBreakdown && nodeBreakdown.scriptBlocks > 5) || score < 4)
    return 'Temporal.io';
  return score >= 6 ? 'NOW Assist' : 'Power Automate';
}

// ─── Claude API proxy ─────────────────────────────────────────────────────────
const ALLOWED_CLAUDE_MODELS = new Set([
  'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
  'claude-sonnet-4-20250514',
]);

app.post('/api/claude', requireAuth, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

  const { model, messages, max_tokens, system } = req.body;
  if (!model || !messages || !Array.isArray(messages))
    return res.status(400).json({ error: 'model and messages required' });
  if (!ALLOWED_CLAUDE_MODELS.has(model))
    return res.status(400).json({ error: 'Model not allowed' });
  if (typeof max_tokens !== 'undefined' && (typeof max_tokens !== 'number' || max_tokens > 8192))
    return res.status(400).json({ error: 'max_tokens must be a number <= 8192' });

  const body = { model, messages, max_tokens: max_tokens || 1024 };
  if (system) body.system = system;

  try {
    const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    }, 30_000);
    if (!response.ok) return res.status(response.status).json(await response.json());
    res.json(await response.json());
  } catch (err) {
    console.error('Claude API error:', err.message);
    res.status(500).json({ error: 'Failed to reach Claude API' });
  }
});

// ─── Test connection ──────────────────────────────────────────────────────────
app.post('/api/servicenow/test', requireAuth, async (req, res) => {
  const { instanceUrl, username, password } = req.body;
  if (!instanceUrl || !username || !password)
    return res.status(400).json({ error: 'instanceUrl, username and password required' });
  if (!validateInstanceUrl(instanceUrl))
    return res.status(400).json({ error: 'instanceUrl must be a *.service-now.com URL' });
  try {
    const data = await snGet(instanceUrl,
      '/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=user_name,sys_id',
      username, password);
    res.json({ success: true, message: 'Connected successfully', user: data.result?.[0]?.user_name });
  } catch (err) {
    res.status(401).json({ success: false, error: err.message });
  }
});

// ─── Full workflow scan ───────────────────────────────────────────────────────
app.post('/api/servicenow/scan', requireAuth, async (req, res) => {
  const { instanceUrl, username, password } = req.body;
  if (!instanceUrl || !username || !password)
    return res.status(400).json({ error: 'instanceUrl, username and password required' });
  if (!validateInstanceUrl(instanceUrl))
    return res.status(400).json({ error: 'instanceUrl must be a *.service-now.com URL' });

  try {
    console.log(`[FlowIQ] Starting scan of ${instanceUrl}`);

    const [flowsData, brData] = await Promise.all([
      snGet(instanceUrl,
        '/api/now/table/sys_hub_flow?sysparm_limit=50&sysparm_fields=name,sys_id,active,description,trigger_type,run_as,category,table_name&sysparm_query=active=true',
        username, password),
      snGet(instanceUrl,
        '/api/now/table/sys_script?sysparm_limit=50&sysparm_fields=name,sys_id,table_name,when,active,advanced&sysparm_query=active=true',
        username, password),
    ]);

    const flows = flowsData.result || [];
    const businessRules = brData.result || [];
    console.log(`[FlowIQ] ${flows.length} flows, ${businessRules.length} business rules`);

    const flowsToScan = flows.slice(0, 25);
    const opportunities = [];
    let totalNodes = 0;
    const nodeTypeCounts = { approvalGates: 0, decisionNodes: 0, scriptBlocks: 0, integrationCalls: 0, notifications: 0 };

    // Process in batches of 5 to limit concurrency
    const CONCURRENCY = 5;
    for (let i = 0; i < flowsToScan.length; i += CONCURRENCY) {
      const batch = flowsToScan.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map(async (flow) => {
        const actData = await snGet(instanceUrl,
          `/api/now/table/sys_hub_action_instance?sysparm_limit=30&sysparm_fields=name,action_type,sys_id,order&sysparm_query=flow=${flow.sys_id}`,
          username, password);
        const actions = actData.result || [];

        let recordCount = 0;
        const tableName = flow.table_name?.value || flow.table_name;
        if (tableName && validateTableName(tableName)) {
          try {
            const statsData = await snGet(instanceUrl, `/api/now/stats/${tableName}?sysparm_count=true`, username, password);
            recordCount = parseInt(statsData.result?.stats?.count || '0');
          } catch (e) { /* table may not support stats */ }
        }

        const scoring = scoreFlow(flow, actions, recordCount);
        return { flow, actions, scoring, recordCount, tableName };
      }));

      for (const result of results) {
        if (result.status === 'rejected') {
          console.warn(`[FlowIQ] Skipped a flow: ${result.reason?.message}`);
          continue;
        }
        const { flow, actions, scoring, recordCount, tableName } = result.value;
        totalNodes += actions.length;
        nodeTypeCounts.approvalGates    += scoring.nodeBreakdown.approvalGates;
        nodeTypeCounts.decisionNodes    += scoring.nodeBreakdown.decisionNodes;
        nodeTypeCounts.scriptBlocks     += scoring.nodeBreakdown.scriptBlocks;
        nodeTypeCounts.integrationCalls += scoring.nodeBreakdown.integrationCalls;
        nodeTypeCounts.notifications    += scoring.nodeBreakdown.notifications;

        opportunities.push({
          sys_id: flow.sys_id,
          name: flow.name,
          description: flow.description || '',
          table: tableName || 'unknown',
          category: flow.category || 'General',
          triggerType: flow.trigger_type || '',
          score: scoring.score,
          tier: scoring.tier,
          tierLabel: scoring.tierLabel,
          platform: recommendPlatform(scoring.score, flow.name, scoring.nodeBreakdown),
          dimensions: scoring.dimensions,
          nodeBreakdown: scoring.nodeBreakdown,
          potential: Math.round(scoring.score * 10),
          recordCount,
        });
      }
    }

    opportunities.sort((a, b) => b.score - a.score);

    const p0 = opportunities.filter(o => o.tier === 'P0').length;
    const p1 = opportunities.filter(o => o.tier === 'P1').length;
    const p2 = opportunities.filter(o => o.tier === 'P2').length;
    const p3 = opportunities.filter(o => o.tier === 'P3').length;
    const avgScore = opportunities.length > 0
      ? parseFloat((opportunities.reduce((s, o) => s + o.score, 0) / opportunities.length).toFixed(2))
      : 0;

    console.log(`[FlowIQ] Scan complete — ${opportunities.length} opportunities, avg score ${avgScore}`);

    res.json({
      success: true,
      instance: instanceUrl,
      scannedAt: new Date().toISOString(),
      summary: {
        totalFlows: flows.length,
        scannedFlows: flowsToScan.length,
        totalBusinessRules: businessRules.length,
        totalNodes,
        opportunities: opportunities.length,
        p0, p1, p2, p3,
        avgScore,
      },
      nodeTypeCounts,
      opportunities,
      businessRules: businessRules.slice(0, 10).map(br => ({
        name: br.name,
        table: br.table_name?.value || br.table_name,
        when: br.when,
        advanced: br.advanced,
      })),
    });

  } catch (err) {
    console.error('[FlowIQ] Scan error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── FlowSpark: Deep analysis endpoint ────────────────────────────────────────
app.post('/api/flowspark/analyze', requireAuth, async (req, res) => {
  const { instanceUrl, username, password, target } = req.body;

  if (!instanceUrl || !username || !password || !target)
    return res.status(400).json({ error: 'instanceUrl, credentials and target required' });
  if (!validateInstanceUrl(instanceUrl))
    return res.status(400).json({ error: 'instanceUrl must be a *.service-now.com URL' });

  const VALID_TARGET_TYPES = new Set(['flow', 'catalog', 'process']);
  if (!VALID_TARGET_TYPES.has(target.type))
    return res.status(400).json({ error: 'target.type must be flow, catalog, or process' });
  if (target.sys_id && !validateSysId(target.sys_id))
    return res.status(400).json({ error: 'Invalid target.sys_id format' });
  if (target.table && !validateTableName(target.table))
    return res.status(400).json({ error: 'Invalid target.table name' });

  try {
    const result = { target, nodes: [], businessRules: [], integrations: [], dataStats: {}, catalogs: [] };

    if (target.type === 'flow' || target.type === 'process') {
      const actData = await snGet(instanceUrl,
        `/api/now/table/sys_hub_action_instance?sysparm_limit=50&sysparm_fields=name,action_type,sys_id,order,condition&sysparm_query=flow=${target.sys_id}`,
        username, password);
      result.nodes = (actData.result || []).map(a => ({
        ...a,
        classification: classifyNode(a.action_type, a.name)
      }));
    }

    const parallelTasks = [];

    if (target.table) {
      parallelTasks.push(
        snGet(instanceUrl,
          `/api/now/table/sys_script?sysparm_limit=20&sysparm_fields=name,sys_id,table_name,when,advanced,script&sysparm_query=active=true^table_name=${target.table}`,
          username, password)
          .then(brData => {
            result.businessRules = (brData.result || []).map(br => ({
              name: br.name, when: br.when, advanced: br.advanced,
              complexity: br.script ? Math.min(15, (br.script.match(/if\s*\(/g) || []).length * 1.5 + 2) : 3
            }));
          })
          .catch(() => {}),

        snGet(instanceUrl, `/api/now/stats/${target.table}?sysparm_count=true`, username, password)
          .then(statsData => {
            result.dataStats.recordCount = parseInt(statsData.result?.stats?.count || '0');
          })
          .catch(() => { result.dataStats.recordCount = 0; })
      );
    }

    parallelTasks.push(
      snGet(instanceUrl,
        `/api/now/table/sys_rest_message?sysparm_limit=10&sysparm_fields=name,rest_endpoint&sysparm_query=active=true`,
        username, password)
        .then(restData => {
          result.integrations = (restData.result || []).map(r => ({ name: r.name, endpoint: r.rest_endpoint }));
        })
        .catch(() => {})
    );

    if (target.type === 'catalog') {
      parallelTasks.push(
        snGet(instanceUrl,
          `/api/now/table/sc_cat_item?sysparm_limit=20&sysparm_fields=name,sys_id,category,description,active&sysparm_query=active=true`,
          username, password)
          .then(catData => { result.catalogs = catData.result || []; })
          .catch(() => {})
      );
    }

    await Promise.all(parallelTasks);

    const scoring = scoreFlow({ name: target.name, table_name: target.table }, result.nodes, result.dataStats.recordCount || 0);
    result.scoring = scoring;
    result.platform = recommendPlatform(scoring.score, target.name, scoring.nodeBreakdown);

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[FlowSpark] Analysis error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── FlowSpark: Browse all scannable items ────────────────────────────────────
app.post('/api/flowspark/browse', requireAuth, async (req, res) => {
  const { instanceUrl, username, password, type } = req.body;
  if (!instanceUrl || !username || !password)
    return res.status(400).json({ error: 'Credentials required' });
  if (!validateInstanceUrl(instanceUrl))
    return res.status(400).json({ error: 'instanceUrl must be a *.service-now.com URL' });

  try {
    const fetches = [];

    if (!type || type === 'flows') {
      fetches.push(
        snGet(instanceUrl,
          '/api/now/table/sys_hub_flow?sysparm_limit=50&sysparm_fields=name,sys_id,active,description,trigger_type,table_name,category&sysparm_query=active=true',
          username, password)
          .then(d => (d.result || []).map(f => ({
            sys_id: f.sys_id, name: f.name, type: 'flow',
            table: f.table_name?.value || f.table_name || '',
            category: f.category || 'General',
            description: f.description || '',
            trigger: f.trigger_type || ''
          })))
          .catch(() => [])
      );
    }

    if (!type || type === 'catalog') {
      fetches.push(
        snGet(instanceUrl,
          '/api/now/table/sc_cat_item?sysparm_limit=30&sysparm_fields=name,sys_id,category,description,active&sysparm_query=active=true',
          username, password)
          .then(d => (d.result || []).map(c => ({
            sys_id: c.sys_id, name: c.name, type: 'catalog',
            category: 'Service Catalog', description: c.description || '', table: 'sc_request'
          })))
          .catch(() => [])
      );
    }

    if (!type || type === 'process') {
      fetches.push(
        snGet(instanceUrl,
          '/api/now/table/wf_workflow?sysparm_limit=20&sysparm_fields=name,sys_id,description,table,active&sysparm_query=active=true',
          username, password)
          .then(d => (d.result || []).map(w => ({
            sys_id: w.sys_id, name: w.name, type: 'process',
            table: w.table?.value || w.table || '', category: 'Workflow',
            description: w.description || ''
          })))
          .catch(() => [])
      );
    }

    const arrays = await Promise.all(fetches);
    const items = arrays.flat();
    res.json({ success: true, items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`FlowIQ running at http://0.0.0.0:${PORT}`);
});
