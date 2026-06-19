"""
Create a "Not Under Warranty (Without Serial No)" Factory Repair ticket via ORM.
Args: <product_id>
Returns JSON with ticketId and key flags.

Note: No serial is set at ticket creation — the serial will be auto-generated later
by action_create_repair_serial (server action 1011).
"""
import os, sys, json
os.environ['ODOO_RC'] = '/etc/odoo/odoo.conf'
import odoo
from odoo.tools import config
config.parse_config(['-c', '/etc/odoo/odoo.conf'])

product_id = int(sys.argv[1]) if len(sys.argv) > 1 else None
if not product_id:
    print(json.dumps({'error': 'product_id required as argv[1]'}))
    sys.exit(1)

with odoo.registry('odoo17').cursor() as cr:
    env = odoo.api.Environment(cr, odoo.SUPERUSER_ID, {})

    # Locate the non-warranty without-serial ticket type
    nw_type = env['helpdesk.ticket.type'].search([
        ('x_studio_rug', '=', False),
        ('x_studio_without_serial_no', '=', True),
    ], limit=1)
    if not nw_type:
        print(json.dumps({'error': 'No non-warranty without-serial ticket type found. Run setup_nonwarranty_master_data.py first.'}))
        sys.exit(1)

    product = env['product.product'].browse(product_id)
    if not product.exists():
        print(json.dumps({'error': f'Product id={product_id} not found'}))
        sys.exit(1)

    partner = env['res.partner'].search([('name', 'ilike', 'Test Customer')], limit=1)
    if not partner:
        partner = env['res.partner'].search([], limit=1)

    team = env['helpdesk.team'].browse(1)
    if not team.exists():
        team = env['helpdesk.team'].search([], limit=1)

    user = env['res.users'].browse(2)  # odoo/admin
    reason = env['x_repair_reason'].search([], limit=1)
    wh_stock = env['stock.location'].browse(8)  # WH/Stock = return_receipt_location

    # create() base fields first (write() hooks don't fire on create)
    ticket = env['helpdesk.ticket'].create({
        'team_id': team.id,
        'user_id': user.id,
        'partner_id': partner.id,
        'x_studio_job_location': 'Factory Repair',
        'x_studio_return_receipt_location': wh_stock.id,
        'x_studio_repair_reason': [(6, 0, [reason.id])] if reason else False,
    })

    # write() triggers _sync_ticket_type_flags (copies type flags to ticket) and
    # _sync_serial_fields.  For without-serial types, _sync_serial_fields clears
    # sale_order_id — exactly what we want.
    ticket.write({
        'ticket_type_id': nw_type.id,
        'product_id': product.id,
    })
    cr.commit()

    # Read back key flags
    ticket.invalidate_recordset()
    print(json.dumps({
        'ticketId': ticket.id,
        'ticketName': ticket.name,
        'rugRepair': ticket.x_studio_rug_repair,
        'rugConfirmed': ticket.x_studio_rug_confirmed,
        'normalRepairWithoutSerial': ticket.x_studio_normal_repair_without_serial_no,
        'normalRepairWithSerial': ticket.x_studio_normal_repair_with_serial_no,
        'jobLocation': ticket.x_studio_job_location,
        'productId': ticket.product_id.id,
        'productName': ticket.product_id.name,
        'saleOrderId': ticket.sale_order_id.id if ticket.sale_order_id else False,
        'repairSerialCreated': ticket.x_studio_repair_serial_created,
        'returnReceiptLocationId': ticket.x_studio_return_receipt_location.id if ticket.x_studio_return_receipt_location else False,
    }))
