"""Create a RUG Factory Repair ticket via ORM and return JSON with ticketId."""
import os, sys, json
os.environ['ODOO_RC'] = '/etc/odoo/odoo.conf'
import odoo
from odoo.tools import config
config.parse_config(['-c', '/etc/odoo/odoo.conf'])

serial_name = sys.argv[1] if len(sys.argv) > 1 else None
picking_id = int(sys.argv[2]) if len(sys.argv) > 2 else None
if not serial_name:
    print(json.dumps({'error': 'serial_name required as argv[1]'}))
    sys.exit(1)

with odoo.registry('odoo17').cursor() as cr:
    env = odoo.api.Environment(cr, odoo.SUPERUSER_ID, {})

    # Resolve master data
    serial = env['stock.lot'].search([('name', '=', serial_name)], limit=1)
    if not serial:
        print(json.dumps({'error': f'Serial {serial_name!r} not found'}))
        sys.exit(1)

    ticket_type = env['helpdesk.ticket.type'].browse(4)
    if not ticket_type.exists():
        ticket_type = env['helpdesk.ticket.type'].search([('x_studio_rug', '=', True)], limit=1)

    partner = env['res.partner'].search([('name', 'ilike', 'Test Customer RUG')], limit=1)
    team = env['helpdesk.team'].browse(1)
    user = env['res.users'].browse(2)  # odoo/admin

    # Determine repair reason (first available)
    reason = env['x_repair_reason'].search([], limit=1)

    # Return receipt location (WH/Stock)
    wh_stock = env['stock.location'].browse(8)

    ticket_vals = {
        'team_id': team.id,
        'user_id': user.id,
        'partner_id': partner.id,
        'x_studio_job_location': 'Factory Repair',
        'x_studio_return_receipt_location': wh_stock.id,
        'x_studio_repair_reason': [(6, 0, [reason.id])] if reason else False,
    }
    if picking_id:
        ticket_vals['x_studio_picking_id'] = picking_id
    ticket = env['helpdesk.ticket'].create(ticket_vals)
    # write() triggers _sync_ticket_type_flags and _sync_serial_fields — create() does not
    ticket.write({
        'ticket_type_id': ticket_type.id,
        'x_studio_serial_no': serial.id,
    })
    cr.commit()

    print(json.dumps({
        'ticketId': ticket.id,
        'ticketName': ticket.name,
        'rugRepair': ticket.x_studio_rug_repair,
        'rugConfirmed': ticket.x_studio_rug_confirmed,
        'jobLocation': ticket.x_studio_job_location,
        'snUpdated': ticket.x_studio_sn_updated,
    }))
