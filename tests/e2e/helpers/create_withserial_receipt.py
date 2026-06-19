"""
Create and validate the receipt picking for a "With Serial No" non-warranty ticket.
Args: <ticket_id> <orig_pick_id>
  ticket_id:    the helpdesk ticket id
  orig_pick_id: the original outgoing delivery (ticket.x_studio_pick_id)

Replicates the stock.return.picking wizard flow that the "Receipt" button opens.
The lot comes from ticket.x_studio_serial_no (the customer's pre-existing serial).

Returns JSON with receiptPickingId, receiptPickingName, receiptState,
ticketValidReturn, ticketValidConfirmReturn.
"""
import os, sys, json
os.environ['ODOO_RC'] = '/etc/odoo/odoo.conf'
import odoo
from odoo.tools import config
config.parse_config(['-c', '/etc/odoo/odoo.conf'])

ticket_id = int(sys.argv[1])
orig_pick_id = int(sys.argv[2])

with odoo.registry('odoo17').cursor() as cr:
    env = odoo.api.Environment(cr, odoo.SUPERUSER_ID, {})
    ticket = env['helpdesk.ticket'].browse(ticket_id)
    orig_pick = env['stock.picking'].browse(orig_pick_id)
    company = env['res.company'].browse(1)

    if not ticket.exists():
        print(json.dumps({'error': f'Ticket {ticket_id} not found'}))
        sys.exit(1)
    if not ticket.x_studio_serial_no:
        print(json.dumps({'error': 'ticket.x_studio_serial_no not set — set serial at ticket creation'}))
        sys.exit(1)
    if not ticket.x_studio_sn_updated:
        print(json.dumps({'error': 'ticket.x_studio_sn_updated=False — write x_studio_serial_no to ticket first'}))
        sys.exit(1)

    source_loc = env['stock.location'].search([('usage', '=', 'customer')], limit=1)

    opt_type = env['stock.picking.type'].search([
        ('default_location_dest_id', '=', ticket.x_studio_return_receipt_location.id),
        ('code', '=', 'incoming'),
        ('company_id', '=', company.id),
    ], limit=1)
    if not opt_type:
        opt_type = env['stock.picking.type'].search([
            ('code', '=', 'incoming'),
            ('company_id', '=', company.id),
        ], limit=1)
    if not opt_type:
        print(json.dumps({'error': 'No incoming picking type found'}))
        sys.exit(1)

    print(f'  Picking type: id={opt_type.id} "{opt_type.name}"', file=sys.stderr)

    receipt = env['stock.picking'].create({
        'x_studio_helpdesk_ticket_id': ticket.id,
        'picking_type_id': opt_type.id,
        'location_id': source_loc.id,
        'location_dest_id': opt_type.default_location_dest_id.id,
        'origin': 'Return of ' + (orig_pick.name if orig_pick.exists() else 'original delivery'),
        'partner_id': ticket.partner_id.id,
        'company_id': company.id,
    })

    move = env['stock.move'].create({
        'picking_id': receipt.id,
        'name': 'New Move:' + ticket.product_id.name,
        'reference': receipt.name,
        'picking_type_id': receipt.picking_type_id.id,
        'product_id': ticket.product_id.id,
        'location_id': receipt.location_id.id,
        'location_dest_id': receipt.location_dest_id.id,
        'product_uom_qty': 1.0,
        'product_uom': ticket.product_id.uom_id.id,
        'state': 'assigned',
        'company_id': company.id,
    })

    env['stock.move.line'].create({
        'move_id': move.id,
        'picking_id': receipt.id,
        'picking_type_id': receipt.picking_type_id.id,
        'product_id': ticket.product_id.id,
        'product_uom_id': ticket.product_id.uom_id.id,
        'location_id': receipt.location_id.id,
        'location_dest_id': receipt.location_dest_id.id,
        'lot_id': ticket.x_studio_serial_no.id,
        'quantity': 1.0,
        'picked': True,
        'company_id': company.id,
    })

    ticket.write({'picking_ids': [(4, receipt.id)]})
    receipt._action_done()
    cr.commit()

    ticket.invalidate_recordset()
    print(json.dumps({
        'receiptPickingId': receipt.id,
        'receiptPickingName': receipt.name,
        'receiptState': receipt.state,
        'ticketValidReturn': ticket.x_studio_valid_return,
        'ticketValidConfirmReturn': ticket.x_studio_valid_confirm_return,
        'serialName': ticket.x_studio_serial_no.name if ticket.x_studio_serial_no else None,
    }))
