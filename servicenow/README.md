# Meeting Room Booking — ServiceNow Zurich Artifacts

Two artifacts to deploy a complete meeting room booking workflow with conflict checking and manager approval.

---

## Step 1 — Import the Custom Table

1. In ServiceNow, go to **System Update Sets > Retrieved Update Sets**
2. Click **Import XML**
3. Upload `meeting_room_booking_table.xml`
4. Click **Preview Update Set** — resolve any warnings (usually none)
5. Click **Commit Update Set**

This creates the `u_meeting_room_booking` table with the following fields:

| Field | Column | Type | Notes |
|---|---|---|---|
| Room Name | u_room_name | String (100) | Mandatory |
| Location / Floor | u_location | String (100) | |
| Start Date & Time | u_start_datetime | Date/Time | Mandatory |
| End Date & Time | u_end_datetime | Date/Time | Mandatory |
| Duration (minutes) | u_duration_minutes | Integer | Read-only (calculated) |
| Number of Attendees | u_attendees | Integer | |
| Meeting Purpose | u_purpose | String (200) | Mandatory |
| Equipment Needed | u_equipment_needed | String (500) | |
| Status | u_status | Choice | New / Pending Approval / Confirmed / Rejected / Cancelled |
| Rejection Reason | u_rejection_reason | String (500) | |
| Approved By | u_approved_by | Reference (sys_user) | Read-only |

Auto-number: **MRB0000001**, **MRB0000002**, …

---

## Step 2 — Create the Flow Designer Flow

1. Go to **System Definition > Scripts - Background**
2. Paste the full contents of `create_flow.js`
3. Click **Run script**
4. Check the output — it prints the flow `sys_id` and any warnings

> The script creates the flow programmatically. If any action type is not found
> (printed as WARNING), open Flow Designer manually and wire that step.

5. Open **Flow Designer > My Flows > Meeting Room Booking – Approval Flow**
6. Review all steps, then click **Activate**

---

## Flow Logic

```
Record Created on u_meeting_room_booking
  │
  ├─ Look Up Records: find bookings with same room + overlapping time
  │
  ├─ IF conflict count > 0
  │     └─ TRUE  → Update Record: status = rejected, set rejection_reason
  │     └─ FALSE → Ask For Approval (manager of requester)
  │                  │
  │                  ├─ IF approval_state = approved
  │                  │     └─ TRUE  → Update Record: status = confirmed, set approved_by
  │                  │     └─ FALSE → Update Record: status = rejected, set rejection_reason
```

**Overlap condition** (all three must be true for a conflict):
- `u_room_name` = new booking's room
- existing `u_start_datetime` < new `u_end_datetime`
- existing `u_end_datetime` > new `u_start_datetime`
- existing `u_status` not in (cancelled, rejected)

---

## Regenerating the Table XML

The XML is generated from `generate_table.py`. To regenerate:

```bash
python3 generate_table.py > meeting_room_booking_table.xml
```

Note: each run produces new random `sys_id` values. Use the existing
`meeting_room_booking_table.xml` for consistent re-imports.
