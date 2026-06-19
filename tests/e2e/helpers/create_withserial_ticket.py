"""
Create a "Not Under Warranty (With Serial No)" Factory Repair ticket via ORM.
Args: <lot_id>
  lot_id: the stock.lot id of the customer's existing serial

The write() hook on x_studio_serial_no automatically calls _sync_serial_fields(),
which sets x_studio_sn_updated=True and x_studio_pick_id to the original delivery.

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

    lot = env['stock.lot'].browse(lot_id)
    if not lot.exists():
        print(json.dumps({'error': f'stock.lot id={lot_id} not found'}))
        sys.exit(1)

    ws_type = env['helpdesk.ticket.type'].search([
        ('x_studio_rug', '=', False),
        ('x_studio_with_serial_no', '=', True),
        ('x_studio_without_serial_no', '=', False),
    ], limit=1)
    if not ws_type:
        print(json.dumps({'error': 'With Serial No ticket type not found. Run setup_withserial_master_data.py first.'}))
        sys.exit(1)

    partner = env['res.partner'].search([('name', 'ilike', 'Test Customer')], limit=1)
    if not partner:
        partner = env['res.partner'].search([('customer_rank', '>', 0)], limit=1)

    team = env['helpdesk.team'].browse(1)
    if not team.exists():
        team = env['helpdesk.team'].search([], limit=1)

    user = env['res.users'].browse(2)
    reason = env['x_repair_reason'].search([], limit=1)
    wh_stock = env['stock.location'].browse(8)

    # create() base fields
    ticket = env['helpdesk.ticket'].create({
        'team_id': team.id,
        'user_id': user.id,
        'partner_id': partner.id,
        'x_studio_job_location': 'Factory Repair',
        'x_studio_return_receipt_location': wh_stock.id,
        'x_studio_repair_reason': [(6, 0, [reason.id])] if reason else False,
    })

    # write() triggers _sync_ticket_type_flags (copies type flags) and _sync_serial_fields
    # Setting x_studio_serial_no auto-sets product_id, lot_id, x_studio_pick_id, x_studio_sn_updated=True
    ticket.write({
        'ticket_type_id': ws_type.id,
        'x_studio_serial_no': lot.id,
    })
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
        'pickId': ticket.x_studio_pick_id,
        'lotId': ticket.x_studio_serial_no.id if ticket.x_studio_serial_no else None,
        'lotName': ticket.x_studio_serial_no.name if ticket.x_studio_serial_no else None,
        'productId': ticket.product_id.id if ticket.product_id else None,
        'productName': ticket.product_id.name if ticket.product_id else None,
        'saleOrderId': ticket.sale_order_id.id if ticket.sale_order_id else None,
        'jobLocation': ticket.x_studio_job_location,
        'returnReceiptLocationId': ticket.x_studio_return_receipt_location.id if ticket.x_studio_return_receipt_location else None,
    }))
