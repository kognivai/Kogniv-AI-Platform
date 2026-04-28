const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Claude API proxy ─────────────────────────────────────────────────────────
app.post('/api/claude', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in Secrets' });
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    res.json(await response.json());
  } catch (err) {
    console.error('Claude API error:', err);
    res.status(500).json({ error: 'Failed to reach Claude API' });
  }
});

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
  const res = await fetch(url, { headers: snHeaders(username, password) });
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

function recommendPlatform(score, flowName) {
  const n = (flowName || '').toLowerCase();
  if (n.includes('hr') || n.includes('onboard') || n.includes('employee') || n.includes('offboard'))
    return 'Salesforce Agentforce';
  if (n.includes('customer') || n.includes('case') || n.includes('csm'))
    return 'Salesforce Agentforce';
  if (score < 4) return 'ServiceNow (Optimise)';
  return 'Power Automate + Copilot';
}

// ─── Test connection ──────────────────────────────────────────────────────────
app.post('/api/servicenow/test', async (req, res) => {
  const { instanceUrl, username, password } = req.body;
  if (!instanceUrl || !username || !password)
    return res.status(400).json({ error: 'instanceUrl, username and password required' });
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
app.post('/api/servicenow/scan', async (req, res) => {
  const { instanceUrl, username, password } = req.body;
  if (!instanceUrl || !username || !password)
    return res.status(400).json({ error: 'instanceUrl, username and password required' });

  try {
    console.log(`[FlowIQ] Starting scan of ${instanceUrl}`);

    // 1. Flows
    const flowsData = await snGet(instanceUrl,
      '/api/now/table/sys_hub_flow?sysparm_limit=50&sysparm_fields=name,sys_id,active,description,trigger_type,run_as,category,table_name&sysparm_query=active=true',
      username, password);
    const flows = flowsData.result || [];
    console.log(`[FlowIQ] ${flows.length} active flows found`);

    // 2. Business Rules
    const brData = await snGet(instanceUrl,
      '/api/now/table/sys_script?sysparm_limit=50&sysparm_fields=name,sys_id,table_name,when,active,advanced&sysparm_query=active=true',
      username, password);
    const businessRules = brData.result || [];
    console.log(`[FlowIQ] ${businessRules.length} active business rules found`);

    // 3. Score each flow
    const flowsToScan = flows.slice(0, 25);
    const opportunities = [];
    let totalNodes = 0;
    const nodeTypeCounts = { approvalGates: 0, decisionNodes: 0, scriptBlocks: 0, integrationCalls: 0, notifications: 0 };

    for (const flow of flowsToScan) {
      try {
        const actData = await snGet(instanceUrl,
          `/api/now/table/sys_hub_action_instance?sysparm_limit=30&sysparm_fields=name,action_type,sys_id,order&sysparm_query=flow=${flow.sys_id}`,
          username, password);
        const actions = actData.result || [];
        totalNodes += actions.length;

        let recordCount = 0;
        const tableName = flow.table_name?.value || flow.table_name;
        if (tableName && typeof tableName === 'string' && tableName.length > 2) {
          try {
            const statsData = await snGet(instanceUrl, `/api/now/stats/${tableName}?sysparm_count=true`, username, password);
            recordCount = parseInt(statsData.result?.stats?.count || '0');
          } catch (e) { /* ignore */ }
        }

        const scoring = scoreFlow(flow, actions, recordCount);
        nodeTypeCounts.approvalGates   += scoring.nodeBreakdown.approvalGates;
        nodeTypeCounts.decisionNodes   += scoring.nodeBreakdown.decisionNodes;
        nodeTypeCounts.scriptBlocks    += scoring.nodeBreakdown.scriptBlocks;
        nodeTypeCounts.integrationCalls += scoring.nodeBreakdown.integrationCalls;
        nodeTypeCounts.notifications   += scoring.nodeBreakdown.notifications;

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
          platform: recommendPlatform(scoring.score, flow.name),
          dimensions: scoring.dimensions,
          nodeBreakdown: scoring.nodeBreakdown,
          potential: Math.round(scoring.score * 10),
          recordCount,
        });
      } catch (e) {
        console.warn(`[FlowIQ] Skipped flow ${flow.name}: ${e.message}`);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`FlowIQ running at http://0.0.0.0:${PORT}`);
});


// ─── NOW Assist fit scoring ────────────────────────────────────────────────
// Determines if a workflow is better transformed inside ServiceNow vs migrating out
function nowAssistFit(flow, actions, nodeBreakdown) {
  const name = (flow.name || '').toLowerCase();
  const table = (flow.table_name?.value || flow.table_name || '').toLowerCase();
  const category = (flow.category || '').toLowerCase();
  let score = 0;
  // Domain signals — ITSM/ITOM/CSM strongly prefer NOW Assist
  if (table.startsWith('incident') || name.includes('incident')) score += 3;
  if (table.startsWith('change') || name.includes('change')) score += 3;
  if (table.startsWith('problem') || name.includes('problem')) score += 2;
  if (table.startsWith('sn_si') || name.includes('sla') || name.includes('sla')) score += 2;
  if (table.startsWith('em_') || name.includes('alert') || name.includes('event')) score += 2;
  if (name.includes('cmdb') || name.includes('config') || name.includes('asset')) score += 2;
  if (name.includes('knowledge') || name.includes('search')) score += 1;
  if (name.includes('virtual agent') || name.includes('chatbot')) score += 2;
  // HR/Finance/CRM signals — prefer migrating out
  if (name.includes('hr') || name.includes('onboard') || name.includes('offboard')) score -= 2;
  if (name.includes('finance') || name.includes('invoice') || name.includes('vendor')) score -= 1;
  if (name.includes('customer') || name.includes('crm') || name.includes('case')) score -= 1;
  // High integration call count → more complex to keep in SN
  if (nodeBreakdown.integrationCalls > 4) score -= 1;
  // Many approval gates → NOW Assist Predictive Intelligence is perfect
  if (nodeBreakdown.approvalGates >= 3) score += 1;
  return score >= 2; // true = recommend NOW Assist
}

// Override recommendPlatform to use NOW Assist logic
const _origRecommend = recommendPlatform;
function recommendPlatformV3(score, flowName, nodeBreakdown, tableStats) {
  const n = (flowName || '').toLowerCase();
  // NOW Assist candidates first
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
  // Default: if score is good, NOW Assist; otherwise consider Power Automate
  return score >= 6 ? 'NOW Assist' : 'Power Automate';
}

// ─── FlowSpark: Deep analysis endpoint ────────────────────────────────────────
app.post('/api/flowspark/analyze', async (req, res) => {
  const { instanceUrl, username, password, target } = req.body;
  // target: { type: 'flow'|'catalog'|'process', sys_id, name, table }

  if (!instanceUrl || !username || !password || !target)
    return res.status(400).json({ error: 'instanceUrl, credentials and target required' });

  try {
    const result = { target, nodes: [], businessRules: [], integrations: [], dataStats: {}, catalogs: [] };

    if (target.type === 'flow' || target.type === 'process') {
      // Get all action nodes
      const actData = await snGet(instanceUrl,
        `/api/now/table/sys_hub_action_instance?sysparm_limit=50&sysparm_fields=name,action_type,sys_id,order,condition&sysparm_query=flow=${target.sys_id}`,
        username, password);
      result.nodes = (actData.result || []).map(a => ({
        ...a,
        classification: classifyNode(a.action_type, a.name)
      }));
    }

    // Business rules for the table
    if (target.table) {
      const brData = await snGet(instanceUrl,
        `/api/now/table/sys_script?sysparm_limit=20&sysparm_fields=name,sys_id,table_name,when,advanced,script&sysparm_query=active=true^table_name=${target.table}`,
        username, password);
      result.businessRules = (brData.result || []).map(br => ({
        name: br.name, when: br.when, advanced: br.advanced,
        complexity: br.script ? Math.min(15, (br.script.match(/if\s*\(/g) || []).length * 1.5 + 2) : 3
      }));
    }

    // Integration/REST messages used
    try {
      const restData = await snGet(instanceUrl,
        `/api/now/table/sys_rest_message?sysparm_limit=10&sysparm_fields=name,rest_endpoint&sysparm_query=active=true`,
        username, password);
      result.integrations = (restData.result || []).map(r => ({ name: r.name, endpoint: r.rest_endpoint }));
    } catch(e) {}

    // Record count for data availability
    if (target.table) {
      try {
        const statsData = await snGet(instanceUrl, `/api/now/stats/${target.table}?sysparm_count=true`, username, password);
        result.dataStats.recordCount = parseInt(statsData.result?.stats?.count || '0');
      } catch(e) { result.dataStats.recordCount = 0; }
    }

    // Service Catalog items if catalog type
    if (target.type === 'catalog') {
      const catData = await snGet(instanceUrl,
        `/api/now/table/sc_cat_item?sysparm_limit=20&sysparm_fields=name,sys_id,category,description,active&sysparm_query=active=true`,
        username, password);
      result.catalogs = catData.result || [];
    }

    // Score the flow
    const scoring = scoreFlow({ name: target.name, table_name: target.table }, result.nodes, result.dataStats.recordCount || 0);
    result.scoring = scoring;
    result.platform = recommendPlatformV3(scoring.score, target.name, scoring.nodeBreakdown, result.dataStats);

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[FlowSpark] Analysis error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── FlowSpark: Browse all scannable items ────────────────────────────────────
app.post('/api/flowspark/browse', async (req, res) => {
  const { instanceUrl, username, password, type } = req.body;
  if (!instanceUrl || !username || !password)
    return res.status(400).json({ error: 'Credentials required' });

  try {
    let items = [];
    if (!type || type === 'flows') {
      const d = await snGet(instanceUrl,
        '/api/now/table/sys_hub_flow?sysparm_limit=50&sysparm_fields=name,sys_id,active,description,trigger_type,table_name,category&sysparm_query=active=true',
        username, password);
      items = items.concat((d.result || []).map(f => ({
        sys_id: f.sys_id, name: f.name, type: 'flow',
        table: f.table_name?.value || f.table_name || '',
        category: f.category || 'General',
        description: f.description || '',
        trigger: f.trigger_type || ''
      })));
    }
    if (!type || type === 'catalog') {
      try {
        const d = await snGet(instanceUrl,
          '/api/now/table/sc_cat_item?sysparm_limit=30&sysparm_fields=name,sys_id,category,description,active&sysparm_query=active=true',
          username, password);
        items = items.concat((d.result || []).map(c => ({
          sys_id: c.sys_id, name: c.name, type: 'catalog',
          category: 'Service Catalog', description: c.description || '', table: 'sc_request'
        })));
      } catch(e) {}
    }
    if (!type || type === 'process') {
      try {
        const d = await snGet(instanceUrl,
          '/api/now/table/wf_workflow?sysparm_limit=20&sysparm_fields=name,sys_id,description,table,active&sysparm_query=active=true',
          username, password);
        items = items.concat((d.result || []).map(w => ({
          sys_id: w.sys_id, name: w.name, type: 'process',
          table: w.table?.value || w.table || '', category: 'Workflow',
          description: w.description || ''
        })));
      } catch(e) {}
    }
    res.json({ success: true, items });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
