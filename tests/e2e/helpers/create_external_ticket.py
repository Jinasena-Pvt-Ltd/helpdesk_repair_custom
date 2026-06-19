"""
Create a "Repair - Under Warranty - External not RUG" Factory Repair ticket via ORM.
Args: <lot_id>
  lot_id: customer serial (stock.lot id) — ticket.x_studio_serial_no will be set to this,
           which triggers _sync_serial_fields() to populate product_id, lot_id, x_studio_pick_id,
           and set x_studio_sn_updated=True.

Returns JSON with ticketId and key flags.
"""
import os, sys, json
os.environ['ODOO_RC'] = '/etc/odoo/odoo.conf'
import odoo
from odoo.tools import config
config.parse_config(['-c', '/etc/odoo/odoo.conf'])

lot_id = int(sys.argv[1]) if len(sys.argv) > 1 else None
if not lot_id:
    print(json.dumps({'error': 'lot_id required as argv[1]'}))
    sys.exit(1)

with odoo.registry('odoo17').cursor() as cr:
    env = odoo.api.Environment(cr, odoo.SUPERUSER_ID, {})

    ext_type = env['helpdesk.ticket.type'].search([
        ('x_studio_rug', '=', True),
        ('x_studio_rug_confirmed', '=', False),
    ], limit=1)
    if not ext_type:
        print(json.dumps({'error': 'External ticket type not found. Run setup_external_master_data.py first.'}))
        sys.exit(1)

    lot = env['stock.lot'].browse(lot_id)
    if not lot.exists():
        print(json.dumps({'error': f'stock.lot id={lot_id} not found'}))
        sys.exit(1)

    partner = env['res.partner'].search([('name', 'ilike', 'Test Customer')], limit=1)
    if not partner:
        partner = env['res.partner'].search([], limit=1)

    team = env['helpdesk.team'].browse(1)
    if not team.exists():
        team = env['helpdesk.team'].search([], limit=1)

    user = env['res.users'].browse(2)
    reason = env['x_repair_reason'].search([], limit=1)
    wh_stock = env['stock.location'].browse(8)

    # create() first with base fields (no write hooks on create)
    ticket = env['helpdesk.ticket'].create({
        'team_id': team.id,
        'user_id': user.id,
        'partner_id': partner.id,
        'x_studio_job_location': 'Factory Repair',
        'x_studio_return_receipt_location': wh_stock.id,
        'x_studio_repair_reason': [(6, 0, [reason.id])] if reason else False,
    })

    # write() triggers _sync_ticket_type_flags (sets rug_repair=True, rug_confirmed=False)
    ticket.write({'ticket_type_id': ext_type.id})
    cr.commit()

    # write() x_studio_serial_no triggers _sync_serial_fields():
    #   sets product_id, lot_id, x_studio_pick_id (original outgoing picking), sn_updated=True
    ticket.write({'x_studio_serial_no': lot_id})
    cr.commit()

    ticket.invalidate_recordset()
    print(json.dumps({
        'ticketId': ticket.id,
        'ticketName': ticket.name,
        'rugRepair': ticket.x_studio_rug_repair,
        'rugConfirmed': ticket.x_studio_rug_confirmed,
        'normalRepairWithSerial': ticket.x_studio_normal_repair_with_serial_no,
        'normalRepairWithoutSerial': ticket.x_studio_normal_repair_without_serial_no,
        'snUpdated': ticket.x_studio_sn_updated,
        'jobLocation': ticket.x_studio_job_location,
        'productId': ticket.product_id.id if ticket.product_id else False,
        'productName': ticket.product_id.name if ticket.product_id else None,
        'lotId': ticket.x_studio_serial_no.id if ticket.x_studio_serial_no else False,
        'lotName': ticket.x_studio_serial_no.name if ticket.x_studio_serial_no else None,
        'pickId': ticket.x_studio_pick_id if ticket.x_studio_pick_id else False,
        'saleOrderId': ticket.sale_order_id.id if ticket.sale_order_id else False,
        'returnReceiptLocationId': ticket.x_studio_return_receipt_location.id if ticket.x_studio_return_receipt_location else False,
    }))
