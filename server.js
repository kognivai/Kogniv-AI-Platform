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


// ═══════════════════════════════════════════════════════════════════════════
// KOGNIV OBSERVE — Celonis-style Process Mining Engine
// ═══════════════════════════════════════════════════════════════════════════
//
// Architecture mirrors Celonis Process Intelligence:
//
//  1. EVENT LOG EXTRACTION  — sys_audit + approval_approver + wf_history
//     → (case_id, activity, timestamp, resource) tuples per record
//
//  2. PROCESS GRAPH DISCOVERY (Alpha Miner inspired)
//     → directly-follows graph (DFG): activity A → activity B, frequency + avg time
//     → dominant path = process map
//
//  3. VARIANT MINING
//     → unique activity sequences across all cases
//     → ranked by frequency, colour-coded by cycle time
//
//  4. CONFORMANCE CHECKING
//     → expected path from flow definition vs actual paths
//     → deviation rate, rework loops, skipped steps
//
//  5. BOTTLENECK DETECTION
//     → measured avg wait time between each transition pair in DFG
//     → top bottleneck = highest (frequency × avg_wait)
//
//  6. AI GAP ANALYSIS
//     → map bottleneck activities to AI capability catalogue
//     → score by (bottleneck_impact × ai_readiness)
//
// ═══════════════════════════════════════════════════════════════════════════

// ── Event log extraction ──────────────────────────────────────────────────

// Activity labels: map state transitions to human-readable activity names
const STATE_ACTIVITY_MAP = {
  incident: {
    '1': 'New',           '2': 'In Progress',  '3': 'On Hold',
    '4': 'Awaiting Info', '5': 'Resolved',      '6': 'Closed',
    '7': 'Cancelled',
  },
  change_request: {
    '-5': 'New',       '-4': 'Assess',     '-3': 'Authorize',
    '-2': 'Scheduled', '0': 'Implement',   '3': 'Review',
    '4': 'Closed',     '7': 'Cancelled',
  },
  sn_hr_core_case: {
    '1': 'Draft', '2': 'Open', '3': 'Awaiting Info',
    '4': 'Closed Complete', '5': 'Closed Incomplete', '6': 'Cancelled',
  },
  sc_request: {
    '1': 'Submitted', '2': 'Approved', '3': 'Fulfilled',
    '4': 'Closed', '5': 'Declined',
  },
  problem: {
    '1': 'Open', '2': 'Known Error', '3': 'Pending Change',
    '4': 'Closed/Resolved', '5': 'Closed/Cancelled', '6': 'Resolved',
  },
};

// Pull event log from sys_audit for a set of case sys_ids
async function extractEventLog(instanceUrl, username, password, table, caseIds) {
  if (!caseIds.length) return [];

  // Batch into groups of 10 to avoid URL length limits
  const batches = [];
  for (let i = 0; i < Math.min(caseIds.length, 30); i += 10) {
    batches.push(caseIds.slice(i, i + 10));
  }

  const activityMap = STATE_ACTIVITY_MAP[table] || {};
  const allEvents = [];

  for (const batch of batches) {
    try {
      // Query sys_audit for state field changes on these records
      const idList = batch.join(',');
      const auditData = await snGet(instanceUrl,
        `/api/now/table/sys_audit` +
        `?sysparm_limit=500` +
        `&sysparm_fields=documentkey,fieldname,oldvalue,newvalue,sys_created_on,sys_created_by` +
        `&sysparm_query=tablename=${table}^fieldnameINstate,priority,assigned_to,approval^documentkeyIN${idList}` +
        `&sysparm_orderby=sys_created_on`,
        username, password);

      const auditRecords = auditData.result || [];

      auditRecords.forEach(a => {
        const field = a.fieldname?.value || a.fieldname || '';
        const newVal = a.newvalue?.value || a.newvalue || '';
        const oldVal = a.oldvalue?.value || a.oldvalue || '';
        const ts = a.sys_created_on?.value || a.sys_created_on || '';
        const resource = a.sys_created_by?.value || a.sys_created_by || 'system';
        const caseId = a.documentkey?.value || a.documentkey || '';

        if (field === 'state' && newVal && ts) {
          const activity = activityMap[newVal] || `State ${newVal}`;
          const fromActivity = activityMap[oldVal] || (oldVal ? `State ${oldVal}` : 'START');
          allEvents.push({
            caseId,
            activity,
            fromActivity,
            timestamp: new Date(ts).getTime(),
            timestampStr: ts,
            resource,
            field: 'state',
          });
        } else if (field === 'assigned_to' && newVal && ts) {
          allEvents.push({
            caseId,
            activity: 'Assigned',
            fromActivity: oldVal ? 'Re-assigned' : 'Unassigned',
            timestamp: new Date(ts).getTime(),
            timestampStr: ts,
            resource,
            field: 'assigned_to',
          });
        } else if (field === 'approval' && ts) {
          const act = newVal === 'approved' ? 'Approved' :
                      newVal === 'rejected' ? 'Rejected' :
                      newVal === 'requested' ? 'Approval Requested' : `Approval: ${newVal}`;
          allEvents.push({
            caseId,
            activity: act,
            fromActivity: 'Awaiting Approval',
            timestamp: new Date(ts).getTime(),
            timestampStr: ts,
            resource,
            field: 'approval',
          });
        }
      });
    } catch(e) {
      console.warn('[Observe] sys_audit batch failed:', e.message);
    }
  }

  // Also pull approval history from approval_approver table
  try {
    const approvalBatch = caseIds.slice(0, 20).join(',');
    const approvalData = await snGet(instanceUrl,
      `/api/now/table/approval_approver` +
      `?sysparm_limit=200` +
      `&sysparm_fields=sysapproval,approver,state,sys_created_on,sys_updated_on` +
      `&sysparm_query=sysapprovalIN${approvalBatch}`,
      username, password);

    (approvalData.result || []).forEach(a => {
      const caseId = a.sysapproval?.value || a.sysapproval || '';
      const ts = a.sys_updated_on?.value || a.sys_created_on?.value || '';
      if (!caseId || !ts) return;
      const state = a.state?.value || a.state || '';
      if (state === 'approved' || state === 'rejected') {
        allEvents.push({
          caseId,
          activity: state === 'approved' ? 'CAB Approved' : 'CAB Rejected',
          fromActivity: 'CAB Review',
          timestamp: new Date(ts).getTime(),
          timestampStr: ts,
          resource: a.approver?.display_value || 'approver',
          field: 'approval_approver',
        });
      }
    });
  } catch(e) {}

  // Sort all events by timestamp
  return allEvents.sort((a, b) => a.timestamp - b.timestamp);
}

// ── Process graph discovery (Directly-Follows Graph) ─────────────────────

function buildDFG(eventLog, caseMap) {
  // Group events by case
  const caseEvents = {};
  eventLog.forEach(e => {
    if (!caseEvents[e.caseId]) caseEvents[e.caseId] = [];
    caseEvents[e.caseId].push(e);
  });

  // Build DFG: for each consecutive pair (A → B) record frequency and time
  const edges = {}; // 'A→B' → { count, totalMs, cases }
  const nodeStats = {}; // activity → { count, totalMs (wait time at node) }
  const caseVariants = []; // per-case path sequences

  Object.entries(caseEvents).forEach(([caseId, events]) => {
    // Sort events for this case
    events.sort((a, b) => a.timestamp - b.timestamp);

    // Prepend START from case open time
    const caseRecord = caseMap[caseId];
    const openTime = caseRecord?.openedAt ? new Date(caseRecord.openedAt).getTime() : null;
    if (openTime && events[0]?.timestamp > openTime) {
      events.unshift({ caseId, activity: 'START', timestamp: openTime, resource: 'system' });
    }
    // Append END if case is closed
    if (caseRecord?.closedAt) {
      const closeTime = new Date(caseRecord.closedAt).getTime();
      if (closeTime > (events[events.length - 1]?.timestamp || 0)) {
        events.push({ caseId, activity: 'END', timestamp: closeTime, resource: 'system' });
      }
    }

    const path = events.map(e => e.activity);
    caseVariants.push({ caseId, path, events });

    // Record edges
    for (let i = 0; i < events.length - 1; i++) {
      const from = events[i].activity;
      const to   = events[i + 1].activity;
      const waitMs = events[i + 1].timestamp - events[i].timestamp;
      const key = `${from}→${to}`;
      if (!edges[key]) edges[key] = { from, to, count: 0, totalMs: 0, cases: [] };
      edges[key].count++;
      edges[key].totalMs += waitMs;
      edges[key].cases.push(caseId);
    }

    // Node stats: time spent at each activity (= wait until next event)
    for (let i = 0; i < events.length - 1; i++) {
      const act = events[i].activity;
      const waitMs = events[i + 1].timestamp - events[i].timestamp;
      if (!nodeStats[act]) nodeStats[act] = { count: 0, totalMs: 0 };
      nodeStats[act].count++;
      nodeStats[act].totalMs += waitMs;
    }
  });

  // Compute averages
  const edgeList = Object.values(edges).map(e => ({
    ...e,
    avgHours: parseFloat((e.totalMs / e.count / 3600000).toFixed(2)),
  })).sort((a, b) => b.count - a.count);

  const nodeList = Object.entries(nodeStats).map(([activity, s]) => ({
    activity,
    count: s.count,
    avgWaitHours: parseFloat((s.totalMs / s.count / 3600000).toFixed(2)),
    totalMs: s.totalMs,
  })).sort((a, b) => b.totalMs - a.totalMs);

  return { edges: edgeList, nodes: nodeList, caseVariants };
}

// ── Variant mining ────────────────────────────────────────────────────────

function mineVariants(caseVariants, caseMap) {
  // Group cases by their activity sequence
  const variantMap = {};
  caseVariants.forEach(({ caseId, path }) => {
    const key = path.join(' → ');
    if (!variantMap[key]) variantMap[key] = { path, cases: [], totalCycleMs: 0, cycleMsValues: [] };
    variantMap[key].cases.push(caseId);
    const rec = caseMap[caseId];
    if (rec?.openedAt && rec?.closedAt) {
      const ms = new Date(rec.closedAt).getTime() - new Date(rec.openedAt).getTime();
      if (ms > 0) {
        variantMap[key].totalCycleMs += ms;
        variantMap[key].cycleMsValues.push(ms);
      }
    }
  });

  const total = caseVariants.length || 1;
  return Object.entries(variantMap)
    .sort((a, b) => b[1].cases.length - a[1].cases.length)
    .slice(0, 8)
    .map(([key, v], i) => {
      const avgMs = v.cycleMsValues.length
        ? v.cycleMsValues.reduce((s, t) => s + t, 0) / v.cycleMsValues.length
        : null;
      return {
        id: i + 1,
        path: v.path,
        pathStr: key,
        caseCount: v.cases.length,
        pct: Math.round((v.cases.length / total) * 100),
        avgCycleHours: avgMs ? parseFloat((avgMs / 3600000).toFixed(1)) : null,
        // Classify variant type
        type: classifyVariant(v.path),
      };
    });
}

function classifyVariant(path) {
  const p = path.join(' ');
  // Detect rework loops: same activity appears more than once
  const unique = new Set(path);
  if (unique.size < path.length - 1) return 'rework_loop';
  if (p.includes('Rejected') || p.includes('Declined')) return 'rejection_path';
  if (p.includes('On Hold') || p.includes('Awaiting')) return 'wait_heavy';
  if (path.length <= 3) return 'happy_path';
  return 'standard';
}

// ── Conformance checking ──────────────────────────────────────────────────

function checkConformance(caseVariants, expectedNodes) {
  if (!expectedNodes.length) return { conformanceRate: null, deviations: [] };

  const expectedActivities = new Set(
    expectedNodes.map(n => n.name?.toLowerCase())
  );

  let conforming = 0;
  const deviationTypes = {};

  caseVariants.forEach(({ path, caseId }) => {
    const actualActivities = new Set(path.map(a => a.toLowerCase()));
    // A case conforms if it visits the expected main activities
    const hits = [...expectedActivities].filter(a => actualActivities.has(a)).length;
    const conformanceScore = hits / Math.max(expectedActivities.size, 1);

    if (conformanceScore >= 0.6) {
      conforming++;
    } else {
      // Identify deviation types
      const missing = [...expectedActivities].filter(a => !actualActivities.has(a));
      missing.forEach(m => {
        deviationTypes[m] = (deviationTypes[m] || 0) + 1;
      });
    }
  });

  const total = caseVariants.length || 1;
  const deviations = Object.entries(deviationTypes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([activity, count]) => ({
      activity,
      count,
      pct: Math.round((count / total) * 100),
    }));

  return {
    conformanceRate: Math.round((conforming / total) * 100),
    conformingCases: conforming,
    totalCases: total,
    deviations,
  };
}

// ── Bottleneck detection from actual transition wait times ────────────────

function detectBottlenecks(dfgEdges, dfgNodes) {
  // Primary: edges with highest avg wait time × frequency (impact score)
  const edgeBottlenecks = dfgEdges
    .filter(e => e.avgHours > 0.05 && e.from !== 'START')
    .map(e => ({
      type: 'transition',
      label: `${e.from} → ${e.to}`,
      from: e.from,
      to: e.to,
      avgHours: e.avgHours,
      frequency: e.count,
      impactScore: parseFloat((e.avgHours * Math.log(e.count + 1)).toFixed(2)),
    }))
    .sort((a, b) => b.impactScore - a.impactScore)
    .slice(0, 6);

  // Secondary: nodes with highest total dwell time
  const nodeBottlenecks = dfgNodes
    .filter(n => n.avgWaitHours > 0.05 && n.activity !== 'START' && n.activity !== 'END')
    .map(n => ({
      type: 'node',
      label: n.activity,
      avgHours: n.avgWaitHours,
      frequency: n.count,
      impactScore: parseFloat((n.avgWaitHours * Math.log(n.count + 1)).toFixed(2)),
    }))
    .sort((a, b) => b.impactScore - a.impactScore)
    .slice(0, 4);

  // Merge, deduplicate, rank
  const all = [...edgeBottlenecks, ...nodeBottlenecks]
    .sort((a, b) => b.impactScore - a.impactScore)
    .slice(0, 6);

  return all;
}

// ── AI gap analysis from process mining results ───────────────────────────

// ── AI_CAPABILITY_MAP: Bottleneck-triggered capabilities ─────────────────
// These fire when a measured bottleneck activity label matches a trigger keyword.
// Impact score scales the estimated saving.
const AI_CAPABILITY_MAP = [
  { trigger: ['approval','cab','authorize','review'],
    cap: 'Approval Gate Automation', platform: 'NOW Assist', saving: 12000, effort: 'Low',
    detail: 'Predictive auto-approve for low-risk cases eliminates manual wait on majority of approvals. Rule: priority≤P3 AND affected_users<10 AND ci.risk=low → auto-approve.' },

  { trigger: ['assigned','route','triage','dispatch'],
    cap: 'Intelligent Assignment & Routing', platform: 'NOW Assist', saving: 8000, effort: 'Low',
    detail: 'Skills-based routing via Predictive Intelligence assigns to right team on first touch — eliminates manual re-assignment loops and reduces MTTR 34%.' },

  { trigger: ['new','start','open','submitted'],
    cap: 'Intake Classification', platform: 'NOW Assist', saving: 7000, effort: 'Low',
    detail: 'Predictive Intelligence auto-classifies and categorises incoming records — removes manual categorisation step from the process entry point.' },

  { trigger: ['in progress','implement','work in progress'],
    cap: 'Resolution Assist', platform: 'NOW Assist', saving: 9000, effort: 'Low',
    detail: 'NOW Assist Resolution Assist surfaces similar past incidents, recommended KB articles, and AI-generated resolution steps at the agent\'s fingertips — reducing time-to-resolve by 35-50%.' },

  { trigger: ['resolved','resolve','closed','close','complete'],
    cap: 'Incident Summarization', platform: 'NOW Assist', saving: 6000, effort: 'Low',
    detail: 'NOW Assist GenAI Summarise auto-generates a structured incident summary at closure — captures root cause, actions taken, and resolution in seconds. Eliminates manual write-up.' },

  { trigger: ['on hold','awaiting','pending','waiting','stall'],
    cap: 'Proactive SLA Escalation', platform: 'NOW Assist', saving: 4000, effort: 'Medium',
    detail: 'SLA Intelligence detects stalled cases 2h before breach and proactively escalates or notifies — cutting SLA breach rate from 11% to <3%.' },

  { trigger: ['notify','email','communication','notif'],
    cap: 'GenAI Contextual Notifications', platform: 'NOW Assist', saving: 2500, effort: 'Low',
    detail: 'GenAI Summarise replaces static notification templates with contextual updates — reducing follow-up calls by ~22%.' },

  { trigger: ['assess','evaluate','risk','impact','priority'],
    cap: 'AI Risk & Priority Scoring', platform: 'NOW Assist', saving: 6000, effort: 'Medium',
    detail: 'ML-based priority and risk scoring uses CI relationships, user impact, and historical patterns — replaces manual priority assessment with a consistent, data-driven score.' },
];

// ── PROCESS_GENAI_CATALOGUE: GenAI capabilities tied to process/table type ─
// These fire based on the process being observed — not from bottleneck labels.
// Every incident process gets these evaluated regardless of what the DFG shows.
const PROCESS_GENAI_CATALOGUE = {
  incident: [
    {
      cap: 'Incident Summarization',
      platform: 'NOW Assist',
      effort: 'Low',
      saving: 8000,
      trigger: 'always', // always surfaces for incident process
      why: 'Every resolved incident requires a written summary. NOW Assist GenAI Summarise auto-generates structured summaries at closure — root cause, actions taken, resolution steps.',
      detail: 'Agents spend avg 8-12 min per incident on closure notes. GenAI Summarise reduces this to <60 seconds. At 100 incidents/day that is 13-20 hours of agent time saved daily.',
      nowAssistFeature: 'GenAI Summarise',
    },
    {
      cap: 'Resolution Assist',
      platform: 'NOW Assist',
      effort: 'Low',
      saving: 14000,
      trigger: 'always',
      why: 'Agents manually search KB articles and past incidents for solutions. NOW Assist Resolution Assist surfaces AI-recommended resolution steps inline in the incident form.',
      detail: 'Resolution Assist analyses the incident description + CI context and surfaces the top 3-5 similar past resolutions and relevant KB articles — reducing MTTR by 35-50%.',
      nowAssistFeature: 'Resolution Assist',
    },
    {
      cap: 'Knowledge Article Creation',
      platform: 'NOW Assist',
      effort: 'Low',
      saving: 5000,
      trigger: 'rework_rate_above_10', // only when rework/reopen rate is high
      why: 'High reopen/rework rate indicates knowledge gaps. Agents re-solve the same issues because knowledge is not captured. NOW Assist auto-drafts KB articles from resolved incidents.',
      detail: 'NOW Assist GenAI drafts a KB article from the incident resolution — including symptoms, root cause, and fix steps. One click to review and publish. Reduces repeat incidents 20-30%.',
      nowAssistFeature: 'Knowledge Creation',
    },
    {
      cap: 'Virtual Agent Deflection',
      platform: 'NOW Assist',
      effort: 'Medium',
      saving: 18000,
      trigger: 'high_volume', // fires when record count > 1000
      why: 'High incident volume indicates many repetitive, self-serviceable issues. Virtual Agent + GenAI can deflect 20-35% of incoming incidents before they reach a human.',
      detail: 'NOW Assist Virtual Agent handles password resets, access requests, and common IT issues end-to-end. GenAI enables natural language conversations — no scripted flows required.',
      nowAssistFeature: 'Virtual Agent + GenAI',
    },
    {
      cap: 'Intelligent Work Notes',
      platform: 'NOW Assist',
      effort: 'Low',
      saving: 4000,
      trigger: 'always',
      why: 'Agents write free-text work notes inconsistently. NOW Assist suggests structured work note templates based on the current incident state and category.',
      detail: 'GenAI-assisted work notes prompt agents with the right information to capture at each stage — reducing note quality issues that cause handoff failures and re-work.',
      nowAssistFeature: 'GenAI Assist',
    },
    {
      cap: 'Chat Summarization for Handoffs',
      platform: 'NOW Assist',
      effort: 'Low',
      saving: 3500,
      trigger: 'rework_rate_above_10',
      why: 'Rework loops are often caused by poor handoff context. NOW Assist summarises the full incident history into a concise handoff brief before reassignment.',
      detail: 'When an incident is reassigned, GenAI Summarise generates a handoff brief covering what was tried, what failed, and current status — cutting ramp-up time for the new agent.',
      nowAssistFeature: 'GenAI Summarise',
    },
  ],
  change_request: [

    // ── GenAI Plan Creation ──────────────────────────────────────────────
    {
      cap: 'Implementation Plan Creation',
      platform: 'NOW Assist', effort: 'Low', saving: 11000, trigger: 'always',
      why: 'Engineers spend 2-3 hours manually writing implementation plans. Most plans are incomplete, inconsistent, or copied from unrelated changes.',
      detail: 'NOW Assist GenAI generates a full step-by-step implementation plan from the change description, affected CI context, and CMDB relationships. Covers pre-checks, execution steps, verification steps, and timing estimates. Reduces authoring from 2h to 10 min.',
      nowAssistFeature: 'GenAI Implementation Plan',
    },
    {
      cap: 'Backout & Rollback Plan Creation',
      platform: 'NOW Assist', effort: 'Low', saving: 9000, trigger: 'always',
      why: 'Backout plans are frequently missing or inadequate. When changes fail, engineers scramble to reverse actions without a documented rollback path — causing extended outages.',
      detail: 'GenAI automatically generates a rollback plan from the implementation steps — reversing each action in sequence, adding verification checkpoints, and flagging steps that cannot be automatically reversed. Reduces change-related MTTR by 40% when rollback is required.',
      nowAssistFeature: 'GenAI Backout Plan',
    },
    {
      cap: 'Test Plan Creation',
      platform: 'NOW Assist', effort: 'Low', saving: 7000, trigger: 'always',
      why: 'Test plans are often written after the fact or not at all. GenAI generates test cases from change scope and affected CI service map.',
      detail: 'NOW Assist analyses the change scope and CMDB service relationships to generate a test plan covering pre-change baseline capture, functional test cases for affected services, and post-change validation steps. Engineers review and approve — not write from scratch.',
      nowAssistFeature: 'GenAI Test Plan',
    },
    {
      cap: 'CAB Justification & Notes Drafting',
      platform: 'NOW Assist', effort: 'Low', saving: 5000, trigger: 'always',
      why: 'CAB submission notes are manually written and often lack the technical and business justification reviewers need — leading to change rejections and rescheduling.',
      detail: 'GenAI drafts the full CAB submission: business justification, technical rationale, risk assessment narrative, rollback approach, and communication plan. Engineers review and submit. Reduces CAB prep time from 45 min to 5 min and cut rejection rate.',
      nowAssistFeature: 'GenAI CAB Notes',
    },
    {
      cap: 'Change Summarization at Closure',
      platform: 'NOW Assist', effort: 'Low', saving: 4000, trigger: 'always',
      why: 'Change closure notes are inconsistent or missing. Future audits, incident correlation, and repeat changes all depend on accurate closure documentation.',
      detail: 'GenAI Summarise auto-generates a structured change closure summary: what was implemented, actual vs planned outcome, any incidents raised, lessons learned. Creates a clean CMDB audit trail in seconds — not 30 minutes.',
      nowAssistFeature: 'GenAI Summarise',
    },

    // ── CI & Conflict Intelligence ────────────────────────────────────────
    {
      cap: 'CI Conflict Detection',
      platform: 'NOW Assist', effort: 'Medium', saving: 14000, trigger: 'always',
      why: 'Multiple changes targeting the same CI in the same maintenance window is one of the leading causes of change-related outages. Currently requires manual cross-referencing of the schedule.',
      detail: 'NOW Assist scans the change schedule and CMDB to identify conflicts: same CI targeted by two or more changes in overlapping windows. Flags potential conflicts during the Assess stage — before CAB, not after. Includes indirect conflicts via CI relationships (e.g., two changes on different CIs sharing a downstream dependency).',
      nowAssistFeature: 'CI Conflict Detection',
    },
    {
      cap: 'CMDB Impact Analysis',
      platform: 'NOW Assist', effort: 'Medium', saving: 12000, trigger: 'always',
      why: 'Manual CMDB traversal to identify all affected upstream and downstream CIs takes 38 minutes per change and is frequently incomplete — leading to unplanned service impacts.',
      detail: 'AI traverses the CMDB relationship graph to automatically identify all CIs affected by the change: direct CIs, dependent services, hosted applications, and business services. Surfaces the full blast radius before the change is approved. Feeds directly into risk scoring and CAB notes.',
      nowAssistFeature: 'CMDB Impact Analysis',
    },
    {
      cap: 'Change Collision Prevention',
      platform: 'NOW Assist', effort: 'Medium', saving: 8000, trigger: 'high_volume',
      why: 'In high-change environments, overlapping maintenance windows create cascading failures. Collision prevention requires looking across the entire change schedule — impossible to do manually.',
      detail: 'AI analyses the full change schedule to surface window collisions, blackout period violations, and dependency-chain conflicts. Recommends alternative maintenance windows based on historical usage patterns and existing freeze calendars.',
      nowAssistFeature: 'Change Scheduling AI',
    },
    {
      cap: 'Affected Business Service Mapping',
      platform: 'NOW Assist', effort: 'Low', saving: 6000, trigger: 'always',
      why: 'Change approvers and stakeholders need to understand which business services are at risk — not just which CIs are changing. This mapping is currently done manually and often missed.',
      detail: 'NOW Assist traverses the CMDB service map to identify all business services that depend on the affected CIs. Auto-populates the "Affected Services" field and generates a stakeholder notification list — ensuring the right people are informed before the change window.',
      nowAssistFeature: 'Service Impact Mapping',
    },

    // ── Risk & Compliance ─────────────────────────────────────────────────
    {
      cap: 'Change Risk Assessment',
      platform: 'NOW Assist', effort: 'Medium', saving: 10000, trigger: 'always',
      why: 'Manual CAB risk assessment is subjective, slow, and inconsistent across different reviewers. AI scoring is objective, repeatable, and based on actual historical outcomes.',
      detail: 'ML model trained on historical change outcomes scores risk 0-10 using CI criticality, change type, affected services, time of day, and past failure rate for similar changes. 94% accuracy. Auto-approves risk ≤3, fast-tracks risk 4-6 to expedited CAB, requires full CAB for risk ≥7.',
      nowAssistFeature: 'AI Risk Assessment',
    },
    {
      cap: 'Historical Failure Pattern Detection',
      platform: 'NOW Assist', effort: 'Medium', saving: 8000, trigger: 'always',
      why: 'The same type of change on the same CI class fails repeatedly, but without AI analysis these patterns are invisible to the approving team.',
      detail: 'ML model identifies CI + change type combinations with elevated historical failure rates. Flags the change with "This type of change has failed 3× on similar CIs in the past 6 months" — prompting reviewers to require additional testing or a longer rollback window.',
      nowAssistFeature: 'Failure Pattern AI',
    },
    {
      cap: 'Regulatory Compliance Check',
      platform: 'NOW Assist', effort: 'Medium', saving: 6000, trigger: 'always',
      why: 'Changes touching regulated CIs (payment systems, PII data stores, healthcare records) require additional documentation and approvals. These are frequently missed in manual review.',
      detail: 'AI cross-references affected CIs against compliance classification tags (SOX, HIPAA, PCI-DSS, GDPR). Automatically adds required approval gates, compliance documentation prompts, and audit trail entries when regulated CIs are in scope.',
      nowAssistFeature: 'Compliance Check AI',
    },
    {
      cap: 'Change Freeze & Blackout Detection',
      platform: 'NOW Assist', effort: 'Low', saving: 5000, trigger: 'always',
      why: 'Changes scheduled during freeze windows (year-end, product launches, holidays) are a common but avoidable cause of policy violations and emergency rollbacks.',
      detail: 'NOW Assist checks the proposed change window against the organisation change freeze calendar and flags violations at submission time — not at CAB review. Suggests the nearest available window outside the freeze period.',
      nowAssistFeature: 'Freeze Calendar AI',
    },

    // ── CAB Intelligence ──────────────────────────────────────────────────
    {
      cap: 'Standard Change Auto-Classification',
      platform: 'NOW Assist', effort: 'Low', saving: 9000, trigger: 'always',
      why: '40-60% of changes submitted as Normal could qualify as Standard — pre-approved, low-risk, well-documented. Identifying these eliminates unnecessary CAB overhead.',
      detail: 'AI compares new change submissions against the standard change catalogue and historical approved patterns. Automatically reclassifies qualifying changes as Standard — bypassing the CAB queue entirely. Typically saves 3-5 days per change that qualifies.',
      nowAssistFeature: 'Standard Change AI',
    },
    {
      cap: 'Emergency Change Streamlining',
      platform: 'NOW Assist', effort: 'Low', saving: 6000, trigger: 'rework_rate_above_10',
      why: 'Emergency changes have no structured fast-path — they follow the same process as normal changes or bypass all controls, both suboptimal. AI can create a controlled fast-path.',
      detail: 'NOW Assist identifies emergency changes via keyword/urgency signals, automatically escalates to the ECAB approver pool, pre-drafts the emergency justification, and sets up a 2-hour approval SLA. Post-emergency, AI generates the mandatory review documentation automatically.',
      nowAssistFeature: 'Emergency Change AI',
    },

    // ── Post-Implementation ───────────────────────────────────────────────
    {
      cap: 'Post-Implementation Review Auto-Draft',
      platform: 'NOW Assist', effort: 'Low', saving: 3000, trigger: 'always',
      why: 'PIR completion rate is below 40% because authoring is manual and time-consuming. Incomplete PIRs break the feedback loop that would prevent repeat failures.',
      detail: 'GenAI Summarise compares planned vs actual implementation, correlates incidents raised during the change window, and drafts the PIR automatically. Reduces PIR authoring from 45 min to 5 min. Prompts the engineer to confirm or correct the AI-generated narrative before closing.',
      nowAssistFeature: 'PIR Auto-Draft',
    },
    {
      cap: 'Related Incident Correlation',
      platform: 'NOW Assist', effort: 'Low', saving: 4000, trigger: 'always',
      why: 'Incidents caused by changes are often not linked to the change record, breaking root cause analysis and making repeat failures likely.',
      detail: 'AI automatically correlates incidents opened within the change window against the affected CI list. Surfaces probable change-caused incidents, links them to the change record, and includes them in the PIR. Improves RCA quality and feeds back into future risk scoring.',
      nowAssistFeature: 'Incident Correlation AI',
    },
  ],
  sn_hr_core_case: [
    {
      cap: 'HR Case Summarization',
      platform: 'NOW Assist', effort: 'Low', saving: 6000, trigger: 'always',
      why: 'HR agents spend significant time reading case history on handoffs. GenAI Summarise provides instant case summaries.',
      detail: 'NOW Assist summarises the HR case including employee request, actions taken, and current status — enabling any agent to pick up a case cold in seconds.',
      nowAssistFeature: 'GenAI Summarise',
    },
    {
      cap: 'HR Policy Q&A via Virtual Agent',
      platform: 'NOW Assist', effort: 'Medium', saving: 12000, trigger: 'high_volume',
      why: 'Large volume of HR cases are simple policy questions. Virtual Agent with GenAI answers these instantly from the HR knowledge base.',
      detail: 'Employee asks "How many days of parental leave do I get?" — Virtual Agent + GenAI searches HR policies and answers in natural language, no ticket created.',
      nowAssistFeature: 'Virtual Agent + GenAI',
    },
  ],
  sc_request: [
    {
      cap: 'Catalog Item Recommendation',
      platform: 'NOW Assist', effort: 'Low', saving: 5000, trigger: 'always',
      why: 'Users often request the wrong catalog item. GenAI recommends the right item based on natural language description.',
      detail: 'Employee types "I need a laptop for video editing" — NOW Assist recommends the correct catalog item, pre-fills form fields, and reduces misrouted requests 40%.',
      nowAssistFeature: 'Search + GenAI',
    },
  ],
  problem: [
    {
      cap: 'Root Cause Analysis Assist',
      platform: 'NOW Assist', effort: 'Medium', saving: 12000, trigger: 'always',
      why: 'Manual RCA takes 3.4 days on average. NOW Assist AI correlates related incidents, CI changes, and events to surface probable root causes.',
      detail: 'AI-assisted RCA analyses incident corpus + CMDB relationships + recent changes to identify probable root cause in <4h for 60% of problems. Human reviews and confirms.',
      nowAssistFeature: 'AI RCA Assist',
    },
    {
      cap: 'Known Error Article Auto-Draft',
      platform: 'NOW Assist', effort: 'Low', saving: 4000, trigger: 'always',
      why: 'Known Error database entries are rarely created because documentation is manual. GenAI drafts KEDB articles from problem records.',
      detail: 'Once root cause is identified, NOW Assist drafts the KEDB article including symptoms, root cause, and workaround — publishing to the knowledge base in one click.',
      nowAssistFeature: 'Knowledge Creation',
    },
  ],
};

// ── deriveAIGapsFromMining — combined bottleneck + GenAI catalogue ─────────
function deriveAIGapsFromMining(bottlenecks, variants, conformance, dfgEdges, table, recordCount) {
  const gaps = [];
  const seen = new Set();

  // ── Part 1: Bottleneck-triggered gaps ──────────────────────────────────
  bottlenecks.forEach((b, idx) => {
    const label = b.label.toLowerCase();
    for (const cap of AI_CAPABILITY_MAP) {
      if (cap.trigger.some(t => label.includes(t)) && !seen.has(cap.cap)) {
        seen.add(cap.cap);
        const severity = idx === 0 ? 'P0' : idx <= 2 ? 'P1' : 'P2';
        gaps.push({
          severity,
          source: 'bottleneck',
          node: b.label,
          type: cap.cap,
          platform: cap.platform,
          effort: cap.effort,
          bottleneckImpact: b.impactScore,
          estimatedMonthlySaving: Math.round(cap.saving * (1 + b.impactScore / 20)),
          detail: cap.detail + ` Bottleneck measured at ${b.avgHours ? b.avgHours + 'h avg wait' : 'high frequency'} from process mining.`,
        });
        break;
      }
    }
  });

  // ── Part 2: Rework loop gap ────────────────────────────────────────────
  const reworkVariants = variants.filter(v => v.type === 'rework_loop');
  const reworkPct = variants.reduce((s, v) => v.type === 'rework_loop' ? s + v.pct : s, 0);
  if (reworkVariants.length > 0 && !seen.has('Rework Loop Elimination')) {
    seen.add('Rework Loop Elimination');
    gaps.push({
      severity: 'P0',
      source: 'rework_loop',
      node: 'Re-work Loop',
      type: 'Rework Loop Elimination',
      platform: 'NOW Assist',
      effort: 'Medium',
      bottleneckImpact: 8,
      estimatedMonthlySaving: reworkVariants.reduce((s, v) => s + v.caseCount, 0) * 200,
      detail: `${reworkVariants.length} rework variant(s) detected affecting ${reworkVariants.reduce((s,v)=>s+v.caseCount,0)} cases. Process mining shows cases revisiting the same activities — root cause is inadequate first-pass resolution. GenAI contextual resolution + proactive escalation addresses this.`,
    });
  }

  // ── Part 3: Conformance deviation gap ──────────────────────────────────
  if (conformance.conformanceRate !== null && conformance.conformanceRate < 70) {
    gaps.push({
      severity: 'P1',
      source: 'conformance',
      node: 'Process Deviation',
      type: 'Conformance Improvement',
      platform: 'ServiceNow Flow Designer',
      effort: 'Medium',
      bottleneckImpact: 6,
      estimatedMonthlySaving: 3000,
      detail: `Only ${conformance.conformanceRate}% of cases follow the designed process path. ${conformance.deviations.slice(0,2).map(d=>d.activity).join(', ')} are frequently skipped. Automated guardrails and AI-guided process adherence reduce deviation.`,
    });
  }

  // ── Part 4: Process-level GenAI catalogue (the missing piece) ──────────
  const catalogue = PROCESS_GENAI_CATALOGUE[table] || [];
  catalogue.forEach(item => {
    if (seen.has(item.cap)) return; // already surfaced from bottleneck match

    // Evaluate trigger condition
    let shouldAdd = false;
    if (item.trigger === 'always') {
      shouldAdd = true;
    } else if (item.trigger === 'rework_rate_above_10' && reworkPct > 10) {
      shouldAdd = true;
    } else if (item.trigger === 'high_volume' && recordCount > 1000) {
      shouldAdd = true;
    }

    if (shouldAdd) {
      seen.add(item.cap);
      // Assign severity: P1 for high-saving items, P2 for others
      const severity = item.saving >= 10000 ? 'P0' : item.saving >= 6000 ? 'P1' : 'P2';
      gaps.push({
        severity,
        source: 'genai_catalogue',
        node: item.nowAssistFeature,
        type: item.cap,
        platform: item.platform,
        effort: item.effort,
        bottleneckImpact: null,
        estimatedMonthlySaving: item.saving,
        detail: item.detail,
        why: item.why,
        nowAssistFeature: item.nowAssistFeature,
      });
    }
  });

  // Sort: P0 first, then P1, then P2. Within tier: bottleneck gaps before catalogue gaps.
  const sevOrder = { P0: 0, P1: 1, P2: 2 };
  const srcOrder = { bottleneck: 0, rework_loop: 0, conformance: 1, genai_catalogue: 2 };
  gaps.sort((a, b) => {
    const sevDiff = sevOrder[a.severity] - sevOrder[b.severity];
    if (sevDiff !== 0) return sevDiff;
    return (srcOrder[a.source] || 0) - (srcOrder[b.source] || 0);
  });

  return gaps.slice(0, 10); // return up to 10 (was 6)
}



// ── KPIs built from real mining results ──────────────────────────────────

function buildMiningKPIs(eventLog, variants, bottlenecks, conformance, cycleStats, recordCount, gaps) {
  const reworkPct = variants.filter(v => v.type === 'rework_loop')
    .reduce((s, v) => s + v.pct, 0);
  const happyPct = variants.filter(v => v.type === 'happy_path')
    .reduce((s, v) => s + v.pct, 0);
  const topBottleneck = bottlenecks[0];
  const totalSaving = gaps.reduce((s, g) => s + (g.estimatedMonthlySaving || 0), 0);

  return [
    { l: 'Cases analysed',    v: recordCount.toLocaleString(), d: 'live from ServiceNow', c: '' },
    { l: 'Events in log',     v: eventLog.length.toLocaleString(), d: 'from sys_audit', c: '' },
    { l: 'Avg cycle time',    v: cycleStats.avgHours ? `${cycleStats.avgHours}h` : 'n/a',
                               d: `p50: ${cycleStats.p50Hours||'n/a'}h`, c: cycleStats.avgHours > 8 ? '#d97706' : '#0F6E56' },
    { l: 'Process variants',  v: String(variants.length), d: `${happyPct}% happy path`, c: '' },
    { l: 'Re-work rate',      v: reworkPct ? `${reworkPct}%` : '0%', d: reworkPct > 10 ? 'above threshold' : 'within range',
                               c: reworkPct > 10 ? '#dc2626' : '#0F6E56' },
    { l: 'Top bottleneck',    v: topBottleneck ? `${topBottleneck.avgHours}h` : 'n/a',
                               d: topBottleneck ? topBottleneck.label.slice(0,28) : 'none detected',
                               c: topBottleneck?.avgHours > 2 ? '#d97706' : '' },
    { l: 'Conformance',       v: conformance.conformanceRate !== null ? `${conformance.conformanceRate}%` : 'n/a',
                               d: 'vs. designed flow', c: (conformance.conformanceRate||100) < 70 ? '#d97706' : '#0F6E56' },
    { l: 'Est. saving / mo',  v: totalSaving ? `$${Math.round(totalSaving/1000)}K` : 'n/a', d: 'if AI gaps addressed', c: '#0F6E56' },
  ];
}

// ── Main Observe endpoint (replaces old one) ──────────────────────────────

app.post('/api/observe/connect', async (req, res) => {
  const { instanceUrl, username, password, processKey, table } = req.body;
  if (!instanceUrl || !username || !password || !table)
    return res.status(400).json({ error: 'instanceUrl, credentials, and table required' });

  try {
    console.log(`[Observe] Starting process mining for ${table} on ${instanceUrl}`);

    // 1. Record count
    const statsData = await snGet(instanceUrl, `/api/now/stats/${table}?sysparm_count=true`, username, password);
    const recordCount = parseInt(statsData.result?.stats?.count || '0');

    // 2. Pull recent cases (last 100 records, enough for meaningful mining)
    const fields = getTableFields(table);
    const recentData = await snGet(instanceUrl,
      `/api/now/table/${table}?sysparm_limit=100&sysparm_fields=${fields},sys_id&sysparm_query=ORDERBYDESCsys_created_on&sysparm_display_value=false`,
      username, password);
    const rawRecords = recentData.result || [];
    const records = rawRecords.map(r => sanitiseRecord(r, table));

    // Build caseId → record lookup
    const caseMap = {};
    rawRecords.forEach((r, i) => {
      const sysId = r.sys_id?.value || r.sys_id || '';
      if (sysId) caseMap[sysId] = records[i];
    });
    const caseIds = Object.keys(caseMap);

    console.log(`[Observe] ${caseIds.length} cases pulled, extracting event log from sys_audit...`);

    // 3. Extract real event log from sys_audit
    const eventLog = await extractEventLog(instanceUrl, username, password, table, caseIds);
    console.log(`[Observe] ${eventLog.length} events extracted`);

    // 4. Compute basic cycle stats from records
    const cycleStats = computeCycleStats(rawRecords, table);

    // 5. Get flow definition (for conformance checking)
    let flowNodes = [];
    try {
      const flowData = await snGet(instanceUrl,
        `/api/now/table/sys_hub_flow?sysparm_limit=5&sysparm_fields=name,sys_id&sysparm_query=active=true^table_name=${table}`,
        username, password);
      const flows = flowData.result || [];
      if (flows.length > 0) {
        const actData = await snGet(instanceUrl,
          `/api/now/table/sys_hub_action_instance?sysparm_limit=30&sysparm_fields=name,action_type,sys_id,order&sysparm_query=flow=${flows[0].sys_id}`,
          username, password);
        flowNodes = (actData.result || [])
          .map(a => ({ id: a.sys_id, name: a.name, type: a.action_type, classification: classifyNode(a.action_type, a.name), order: parseInt(a.order)||0 }))
          .sort((a, b) => a.order - b.order);
      }
    } catch(e) { console.warn('[Observe] Flow definition fetch failed:', e.message); }

    // 6. Build directly-follows graph and mine variants
    const { edges: dfgEdges, nodes: dfgNodes, caseVariants } = buildDFG(eventLog, caseMap);

    // 7. Mine process variants
    const variants = mineVariants(caseVariants, caseMap);

    // 8. Conformance checking
    const conformance = checkConformance(caseVariants, flowNodes);

    // 9. Detect bottlenecks from measured wait times
    const bottlenecks = detectBottlenecks(dfgEdges, dfgNodes);

    // 10. AI gap analysis from mining results
    const gapAnalysis = deriveAIGapsFromMining(bottlenecks, variants, conformance, dfgEdges, table, recordCount);

    // 11. KPIs from mining
    const kpis = buildMiningKPIs(eventLog, variants, bottlenecks, conformance, cycleStats, recordCount, gapAnalysis);

    console.log(`[Observe] Mining complete — ${variants.length} variants, ${bottlenecks.length} bottlenecks, ${gapAnalysis.length} gaps`);

    res.json({
      success: true,
      miningEngine: 'celonis_style_v1',
      instance: instanceUrl,
      table,
      processKey,
      recordCount,
      eventLogSize: eventLog.length,
      caseCount: caseIds.length,
      flowDefinition: { nodeCount: flowNodes.length, nodes: flowNodes },
      dfg: {
        edges: dfgEdges.slice(0, 30),
        nodes: dfgNodes.slice(0, 20),
      },
      variants,
      conformance,
      bottlenecks,
      gapAnalysis,
      cycleStats,
      kpis,
      recentCases: records.slice(0, 20),
    });

  } catch(err) {
    console.error('[Observe] Mining error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Poll endpoint (unchanged) ─────────────────────────────────────────────
app.post('/api/observe/poll', async (req, res) => {
  const { instanceUrl, username, password, table, since } = req.body;
  if (!instanceUrl || !username || !password || !table)
    return res.status(400).json({ error: 'Missing required fields' });

  try {
    const sinceQuery = since
      ? `^sys_created_on>javascript:gs.dateGenerate('${since.split('T')[0]}','${since.split('T')[1]?.slice(0,8)||'00:00:00'}')`
      : '';
    const fields = getTableFields(table);
    const data = await snGet(instanceUrl,
      `/api/now/table/${table}?sysparm_limit=10&sysparm_fields=${fields}&sysparm_query=ORDERBYDESCsys_created_on${sinceQuery}`,
      username, password);
    res.json({ success: true, newRecords: (data.result||[]).map(r => sanitiseRecord(r, table)), count: data.result?.length||0 });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DFG query endpoint (for process map rendering) ─────────────────────────
app.post('/api/observe/dfg', async (req, res) => {
  const { instanceUrl, username, password, table, limit=50 } = req.body;
  if (!instanceUrl || !username || !password || !table)
    return res.status(400).json({ error: 'Missing required fields' });

  try {
    const fields = getTableFields(table);
    const data = await snGet(instanceUrl,
      `/api/now/table/${table}?sysparm_limit=${limit}&sysparm_fields=${fields},sys_id&sysparm_query=ORDERBYDESCsys_created_on`,
      username, password);
    const rawRecords = data.result || [];
    const caseMap = {};
    rawRecords.forEach(r => {
      const id = r.sys_id?.value || r.sys_id;
      if (id) caseMap[id] = sanitiseRecord(r, table);
    });
    const eventLog = await extractEventLog(instanceUrl, username, password, table, Object.keys(caseMap));
    const { edges, nodes, caseVariants } = buildDFG(eventLog, caseMap);
    res.json({ success: true, edges: edges.slice(0,40), nodes: nodes.slice(0,20), eventCount: eventLog.length });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Observe table/field helpers ───────────────────────────────────────────

const TABLE_FIELDS = {
  incident:        'number,short_description,state,priority,category,assigned_to,opened_at,resolved_at,sys_created_on',
  change_request:  'number,short_description,state,priority,type,assigned_to,opened_at,closed_at,sys_created_on,risk',
  sn_hr_core_case: 'number,short_description,state,priority,hr_service,assigned_to,opened_at,closed_at,sys_created_on',
  sc_request:      'number,short_description,state,requested_for,opened_at,closed_at,sys_created_on,approval',
  problem:         'number,short_description,state,priority,assigned_to,opened_at,resolved_at,sys_created_on',
  sn_vnd_vendor:   'number,name,state,sys_created_on',
};

function getTableFields(table) {
  return TABLE_FIELDS[table] || 'number,short_description,state,sys_created_on,opened_at,closed_at';
}

function sanitiseRecord(r, table) {
  const opened = r.opened_at?.value || r.opened_at || r.sys_created_on?.value || '';
  const closed  = r.closed_at?.value || r.resolved_at?.value || '';
  const cycleMs = (opened && closed) ? new Date(closed).getTime() - new Date(opened).getTime() : null;
  return {
    number:     r.number?.value || r.number || '',
    title:      r.short_description?.value || r.short_description || r.name?.value || '',
    state:      r.state?.display_value || r.state || 'unknown',
    priority:   r.priority?.display_value || r.priority || '',
    openedAt:   opened,
    closedAt:   closed,
    cycleHours: cycleMs ? parseFloat((cycleMs/3600000).toFixed(1)) : null,
    createdAt:  r.sys_created_on?.value || r.sys_created_on || '',
  };
}

function computeCycleStats(records, table) {
  const times = records
    .map(r => {
      const opened = r.opened_at?.value || r.sys_created_on?.value;
      const closed  = r.closed_at?.value || r.resolved_at?.value;
      if (!opened || !closed) return null;
      const h = (new Date(closed).getTime() - new Date(opened).getTime()) / 3600000;
      return (h > 0 && h < 8760) ? h : null;
    })
    .filter(Boolean)
    .sort((a, b) => a - b);

  if (!times.length) return { avgHours:null, minHours:null, maxHours:null, p50Hours:null, count:0 };
  const avg = times.reduce((s,t)=>s+t,0) / times.length;
  return {
    avgHours: parseFloat(avg.toFixed(1)),
    minHours: parseFloat(times[0].toFixed(1)),
    maxHours: parseFloat(times[times.length-1].toFixed(1)),
    p50Hours: parseFloat(times[Math.floor(times.length*0.5)].toFixed(1)),
    count: times.length,
  };
}
