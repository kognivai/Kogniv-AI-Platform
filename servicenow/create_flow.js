/**
 * ServiceNow Background Script — Meeting Room Booking Flow
 *
 * Run this in: System Definition > Scripts - Background
 *
 * Prerequisites:
 *   1. The u_meeting_room_booking table must already be imported via
 *      meeting_room_booking_table.xml (System Update Sets > Retrieved Update Sets).
 *
 * What this script creates:
 *   - A Flow Designer flow named "Meeting Room Booking – Approval Flow"
 *   - Trigger: Record Created on u_meeting_room_booking
 *   - Logic:
 *       1. Look up conflicting bookings (same room, overlapping time, not cancelled/rejected)
 *       2. If conflict found  → set status = rejected, populate rejection_reason
 *       3. If no conflict     → Ask For Approval (manager of the requester)
 *       4. If approved        → set status = confirmed, set approved_by
 *       5. If rejected        → set status = rejected, populate rejection_reason
 */

(function createMeetingRoomBookingFlow() {

    // ── Helpers ────────────────────────────────────────────────────────────────

    function abort(msg) {
        gs.print('ABORT: ' + msg);
        throw new Error(msg);
    }

    function findActionDefSysId(name) {
        var gr = new GlideRecord('sys_hub_action_type_definition');
        gr.addQuery('name', name);
        gr.setLimit(1);
        gr.query();
        if (gr.next()) return gr.sys_id.toString();
        return null;
    }

    function findTriggerDefSysId(name) {
        var gr = new GlideRecord('sys_hub_trigger_type');
        gr.addQuery('name', name);
        gr.setLimit(1);
        gr.query();
        if (gr.next()) return gr.sys_id.toString();
        return null;
    }

    // ── 1. Create the Flow record ──────────────────────────────────────────────

    var FLOW_NAME = 'Meeting Room Booking – Approval Flow';

    // Delete any previous attempt with the same name
    var old = new GlideRecord('sys_hub_flow');
    old.addQuery('name', FLOW_NAME);
    old.query();
    while (old.next()) {
        gs.print('Deleting previous flow: ' + old.sys_id);
        old.deleteRecord();
    }

    var flow = new GlideRecord('sys_hub_flow');
    flow.initialize();
    flow.setValue('name',        FLOW_NAME);
    flow.setValue('description', 'Handles meeting room booking: conflict check then manager approval.');
    flow.setValue('active',      true);
    flow.setValue('internal_name', 'meeting_room_booking_approval_flow');
    flow.setValue('run_as',      'initiator'); // run as the user who triggered it
    var flowId = flow.insert();
    if (!flowId) abort('Failed to create flow record');
    gs.print('Flow created: ' + flowId);

    // ── 2. Trigger: Record Created on u_meeting_room_booking ──────────────────

    var triggerDefId = findTriggerDefSysId('Record Created');
    if (!triggerDefId) abort('Trigger type "Record Created" not found — check sys_hub_trigger_type');

    var trigger = new GlideRecord('sys_hub_trigger_instance');
    trigger.initialize();
    trigger.setValue('flow',        flowId);
    trigger.setValue('trigger_type', triggerDefId);
    // Table input — stored as JSON inputs on the trigger
    trigger.setValue('inputs', JSON.stringify({ table: 'u_meeting_room_booking' }));
    trigger.setValue('order', 0);
    var triggerId = trigger.insert();
    if (!triggerId) abort('Failed to create trigger instance');
    gs.print('Trigger created: ' + triggerId);

    // ── 3. Locate built-in action type definitions ─────────────────────────────

    var ACT = {
        lookupRecords:     findActionDefSysId('Look Up Records'),
        updateRecord:      findActionDefSysId('Update Record'),
        askForApproval:    findActionDefSysId('Ask For Approval'),
        ifElse:            findActionDefSysId('If')
    };

    gs.print('Action type IDs: ' + JSON.stringify(ACT));

    // Warn about any missing but don't abort — user can wire them manually
    Object.keys(ACT).forEach(function(k) {
        if (!ACT[k]) gs.print('WARNING: action type not found for key: ' + k);
    });

    // ── 4. Action helper ───────────────────────────────────────────────────────

    var actionOrder = 100;

    function addAction(name, actionTypeId, inputs, outputs, metaOverrides) {
        var rec = new GlideRecord('sys_hub_action_instance');
        rec.initialize();
        rec.setValue('flow',        flowId);
        rec.setValue('name',        name);
        rec.setValue('action_type', actionTypeId || '');
        rec.setValue('inputs',      JSON.stringify(inputs  || {}));
        rec.setValue('outputs',     JSON.stringify(outputs || {}));
        rec.setValue('order',       actionOrder);
        if (metaOverrides) {
            Object.keys(metaOverrides).forEach(function(k) {
                rec.setValue(k, metaOverrides[k]);
            });
        }
        actionOrder += 100;
        var id = rec.insert();
        if (!id) gs.print('WARNING: could not insert action: ' + name);
        else gs.print('Action created [' + name + ']: ' + id);
        return id;
    }

    // ── 5. Step 1 — Look up conflicting bookings ───────────────────────────────
    // Same room, overlapping time window, status not in (cancelled, rejected)

    var lookupId = addAction(
        '1 – Check for Room Conflicts',
        ACT.lookupRecords,
        {
            table: 'u_meeting_room_booking',
            conditions: JSON.stringify([
                // same room
                { field: 'u_room_name', operator: 'is',           value: '{{trigger.current.u_room_name}}' },
                // overlap: existing start < new end  AND  existing end > new start
                { field: 'u_start_datetime', operator: 'less than',    value: '{{trigger.current.u_end_datetime}}' },
                { field: 'u_end_datetime',   operator: 'greater than', value: '{{trigger.current.u_start_datetime}}' },
                // exclude the record just created
                { field: 'sys_id', operator: 'is not', value: '{{trigger.current.sys_id}}' },
                // exclude already-cancelled or rejected
                { field: 'u_status', operator: 'is not', value: 'cancelled' },
                { field: 'u_status', operator: 'is not', value: 'rejected'  }
            ])
        },
        { conflicting_records: {} }
    );

    // ── 6. Step 2 — If conflict count > 0 ─────────────────────────────────────

    var ifConflictId = addAction(
        '2 – If Room Is Already Booked',
        ACT.ifElse,
        {
            conditions: JSON.stringify([{
                left:     '{{1 – Check for Room Conflicts.conflicting_records.count}}',
                operator: 'greater than',
                right:    '0'
            }])
        },
        {},
        { meta: JSON.stringify({ type: 'if' }) }
    );

    // ── 7. Step 3a — Reject (conflict) ────────────────────────────────────────

    var rejectConflictId = addAction(
        '3a – Reject Booking (Conflict)',
        ACT.updateRecord,
        {
            record: '{{trigger.current.sys_id}}',
            table:  'u_meeting_room_booking',
            fields: JSON.stringify([
                { field: 'u_status',           value: 'rejected' },
                { field: 'u_rejection_reason', value: 'Room is already booked for the requested time slot.' }
            ])
        },
        {},
        { parent: ifConflictId, branch: 'true' }
    );

    // ── 8. Step 4 — Ask For Approval (no-conflict branch) ─────────────────────

    var approvalId = addAction(
        '4 – Request Manager Approval',
        ACT.askForApproval,
        {
            record:   '{{trigger.current.sys_id}}',
            table:    'u_meeting_room_booking',
            approvers: JSON.stringify([{
                type:  'user',
                // manager of the person who created the record
                value: '{{trigger.current.sys_created_by.manager}}'
            }]),
            approval_field:  'u_status',
            approved_value:  'confirmed',
            rejected_value:  'rejected',
            due_date: ''
        },
        {
            approval_state: {},
            approver:       {}
        },
        { parent: ifConflictId, branch: 'false' }
    );

    // ── 9. Step 5a — If approved ───────────────────────────────────────────────

    var ifApprovedId = addAction(
        '5 – If Approved',
        ACT.ifElse,
        {
            conditions: JSON.stringify([{
                left:     '{{4 – Request Manager Approval.approval_state}}',
                operator: 'is',
                right:    'approved'
            }])
        },
        {},
        { parent: ifConflictId, branch: 'false', meta: JSON.stringify({ type: 'if' }) }
    );

    // ── 10. Step 6a — Confirm ──────────────────────────────────────────────────

    var confirmId = addAction(
        '6a – Confirm Booking',
        ACT.updateRecord,
        {
            record: '{{trigger.current.sys_id}}',
            table:  'u_meeting_room_booking',
            fields: JSON.stringify([
                { field: 'u_status',      value: 'confirmed' },
                { field: 'u_approved_by', value: '{{4 – Request Manager Approval.approver}}' }
            ])
        },
        {},
        { parent: ifApprovedId, branch: 'true' }
    );

    // ── 11. Step 6b — Reject (manager rejected) ────────────────────────────────

    var rejectApprovalId = addAction(
        '6b – Reject Booking (Manager)',
        ACT.updateRecord,
        {
            record: '{{trigger.current.sys_id}}',
            table:  'u_meeting_room_booking',
            fields: JSON.stringify([
                { field: 'u_status',           value: 'rejected' },
                { field: 'u_rejection_reason', value: 'Booking request was rejected by the manager.' }
            ])
        },
        {},
        { parent: ifApprovedId, branch: 'false' }
    );

    // ── Done ───────────────────────────────────────────────────────────────────

    gs.print('');
    gs.print('=== Meeting Room Booking flow created successfully ===');
    gs.print('Flow sys_id : ' + flowId);
    gs.print('');
    gs.print('Next steps:');
    gs.print('  1. Open Flow Designer > My Flows > "' + FLOW_NAME + '"');
    gs.print('  2. Review each step — rewire any "WARNING" actions manually.');
    gs.print('  3. Set the flow to Active and click Test or Activate.');

})();
