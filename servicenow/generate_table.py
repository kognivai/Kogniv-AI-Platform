#!/usr/bin/env python3
"""
Generates a ServiceNow Zurich Update Set XML for the u_meeting_room_booking custom table.

Usage:
    python3 generate_table.py > meeting_room_booking_table.xml

Then in ServiceNow:
    System Update Sets > Retrieved Update Sets > Import XML
    Select the generated file, click Upload, then Preview and Commit.
"""

import uuid
from datetime import datetime

def uid():
    return uuid.uuid4().hex

NOW = datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')

# ── Fixed sys_ids ──────────────────────────────────────────────────────────────
RUS = uid()   # remote_update_set
TABLE = uid() # table record
NUM = uid()   # number counter

F = {
    'room_name':        uid(),
    'location':         uid(),
    'start_datetime':   uid(),
    'end_datetime':     uid(),
    'duration_minutes': uid(),
    'attendees':        uid(),
    'purpose':          uid(),
    'equipment_needed': uid(),
    'status':           uid(),
    'rejection_reason': uid(),
    'approved_by':      uid(),
}

C = {
    'new':              uid(),
    'pending_approval': uid(),
    'confirmed':        uid(),
    'rejected':         uid(),
    'cancelled':        uid(),
}

UX = {k: uid() for k in
      ['table', 'num'] + list(F.keys()) + list(C.keys())}


# ── XML wrapper for each record payload ───────────────────────────────────────
def update_xml(table, sys_id, ux_id, payload):
    return f"""  <sys_update_xml action="INSERT_OR_UPDATE">
    <action>INSERT_OR_UPDATE</action>
    <application display_value="Global">global</application>
    <category>customization</category>
    <name>{table}_{sys_id}</name>
    <payload><![CDATA[<?xml version="1.0" encoding="UTF-8"?><record_update table="{table}">{payload}</record_update>]]></payload>
    <remote_update_set display_value="Meeting Room Booking">{RUS}</remote_update_set>
    <sys_created_by>admin</sys_created_by>
    <sys_created_on>{NOW}</sys_created_on>
    <sys_id>{ux_id}</sys_id>
    <table>{table}</table>
    <type>Record</type>
  </sys_update_xml>"""


# ── Table definition ───────────────────────────────────────────────────────────
TABLE_PAYLOAD = f"""<sys_db_object action="INSERT_OR_UPDATE">
    <create_access_controls>false</create_access_controls>
    <create_module/>
    <create_role/>
    <description>Meeting room booking requests with conflict checking and manager approval</description>
    <extendable>false</extendable>
    <label>Meeting Room Booking</label>
    <name>u_meeting_room_booking</name>
    <super_class/>
    <sys_class_name>sys_db_object</sys_class_name>
    <sys_id>{TABLE}</sys_id>
    <sys_name>u_meeting_room_booking</sys_name>
    <sys_scope display_value="Global">global</sys_scope>
  </sys_db_object>"""


# ── Number counter (auto-number: MRB0000001) ───────────────────────────────────
NUM_PAYLOAD = f"""<sys_number action="INSERT_OR_UPDATE">
    <maximum_digits>7</maximum_digits>
    <number>1</number>
    <prefix>MRB</prefix>
    <sys_id>{NUM}</sys_id>
    <table>u_meeting_room_booking</table>
  </sys_number>"""


# ── Field (sys_dictionary) builder ─────────────────────────────────────────────
def field_payload(sys_id, column_name, label, internal_type,
                  max_length='', reference='', mandatory='false',
                  read_only='false', default_value=''):
    ml  = f'<max_length>{max_length}</max_length>' if max_length else '<max_length/>'
    ref = (f'<reference display_value="{reference}">{reference}</reference>'
           if reference else '<reference/>')
    dv  = f'<default_value>{default_value}</default_value>'
    is_choice = '1' if internal_type == 'choice' else '0'
    return f"""<sys_dictionary action="INSERT_OR_UPDATE">
    <active>true</active>
    <array>false</array>
    <calculation/>
    <choice>{is_choice}</choice>
    <column_label>{label}</column_label>
    {dv}
    <element>{column_name}</element>
    <internal_type display_value="{internal_type}">{internal_type}</internal_type>
    <mandatory>{mandatory}</mandatory>
    {ml}
    <name>u_meeting_room_booking</name>
    {ref}
    <read_only>{read_only}</read_only>
    <sys_id>{sys_id}</sys_id>
    <sys_name>u_meeting_room_booking.{column_name}</sys_name>
    <sys_scope display_value="Global">global</sys_scope>
    <table_reference>false</table_reference>
    <use_dynamic_default>false</use_dynamic_default>
  </sys_dictionary>"""


# ── Choice (sys_choice) builder ────────────────────────────────────────────────
def choice_payload(sys_id, value, label, sequence):
    return f"""<sys_choice action="INSERT_OR_UPDATE">
    <dependent_value/>
    <element>u_status</element>
    <hint/>
    <inactive>false</inactive>
    <label>{label}</label>
    <language>en</language>
    <name>u_meeting_room_booking</name>
    <sequence>{sequence * 100}</sequence>
    <sys_id>{sys_id}</sys_id>
    <sys_scope display_value="Global">global</sys_scope>
    <value>{value}</value>
  </sys_choice>"""


# ── Field definitions ──────────────────────────────────────────────────────────
FIELDS = [
    # (key,               col_name,             label,                   type,             maxlen, ref,      mand,    ro,      default)
    ('room_name',        'u_room_name',        'Room Name',             'string',          100,    '',       'true',  'false', ''),
    ('location',         'u_location',         'Location / Floor',      'string',          100,    '',       'false', 'false', ''),
    ('start_datetime',   'u_start_datetime',   'Start Date & Time',     'glide_date_time', '',     '',       'true',  'false', ''),
    ('end_datetime',     'u_end_datetime',     'End Date & Time',       'glide_date_time', '',     '',       'true',  'false', ''),
    ('duration_minutes', 'u_duration_minutes', 'Duration (minutes)',    'integer',         '',     '',       'false', 'true',  ''),
    ('attendees',        'u_attendees',        'Number of Attendees',   'integer',         '',     '',       'false', 'false', ''),
    ('purpose',          'u_purpose',          'Meeting Purpose',       'string',          200,    '',       'true',  'false', ''),
    ('equipment_needed', 'u_equipment_needed', 'Equipment Needed',      'string',          500,    '',       'false', 'false', ''),
    ('status',           'u_status',           'Status',                'choice',          40,     '',       'false', 'false', 'new'),
    ('rejection_reason', 'u_rejection_reason', 'Rejection Reason',      'string',          500,    '',       'false', 'false', ''),
    ('approved_by',      'u_approved_by',      'Approved By',           'reference',       '',     'sys_user','false','true',  ''),
]

CHOICES = [
    ('new',              'New',              0),
    ('pending_approval', 'Pending Approval', 1),
    ('confirmed',        'Confirmed',        2),
    ('rejected',         'Rejected',         3),
    ('cancelled',        'Cancelled',        4),
]


# ── Assemble all update_xml records ───────────────────────────────────────────
records = []

records.append(update_xml('sys_db_object', TABLE, UX['table'], TABLE_PAYLOAD))
records.append(update_xml('sys_number',    NUM,   UX['num'],   NUM_PAYLOAD))

for key, col, label, itype, maxlen, ref, mand, ro, dv in FIELDS:
    payload = field_payload(F[key], col, label, itype,
                            str(maxlen) if maxlen else '', ref, mand, ro, dv)
    records.append(update_xml('sys_dictionary', F[key], UX[key], payload))

for key, label, seq in CHOICES:
    payload = choice_payload(C[key], key, label, seq)
    records.append(update_xml('sys_choice', C[key], UX[key], payload))


# ── Output final XML ───────────────────────────────────────────────────────────
print(f"""<?xml version="1.0" encoding="UTF-8"?><unload unload_date="{NOW}">
  <sys_remote_update_set action="INSERT_OR_UPDATE">
    <application display_value="Global">global</application>
    <name>Meeting Room Booking</name>
    <origin_sys_id>00000000000000000000000000000000</origin_sys_id>
    <release_date/>
    <remote_sys_id>{RUS}</remote_sys_id>
    <state>loaded</state>
    <summary>Custom table u_meeting_room_booking with fields and status choices for meeting room booking requests</summary>
    <sys_class_name>sys_remote_update_set</sys_class_name>
    <sys_id>{RUS}</sys_id>
    <sys_name>Meeting Room Booking</sys_name>
  </sys_remote_update_set>
{"".join(records)}
</unload>""")
