"""Replicate SA1009 (RR - RUG Return from Helpdesk) via ORM.
Args: <ticket_id> <picking_id>
Creates and validates the incoming receipt picking, returns JSON.
"""
import os, sys, json, odoo
from odoo.tools import config
os.environ['ODOO_RC'] = '/etc/odoo/odoo.conf'
config.parse_config(['-c', '/etc/odoo/odoo.conf'])

ticket_id = int(sys.argv[1])
source_picking_id = int(sys.argv[2])

with odoo.registry('odoo17').cursor() as cr:
    env = odoo.api.Environment(cr, odoo.SUPERUSER_ID, {})
    ticket = env['helpdesk.ticket'].browse(ticket_id)
    source_pick = env['stock.picking'].browse(source_picking_id)
    company = env['res.company'].browse(1)

    # Replicating SA1009 checks (already verified these are set)
    if not ticket.x_studio_virtual_location or not ticket.x_studio_source_location:
        print(json.dumps({'error': 'Virtual/source locations not set on ticket'}))
        sys.exit(1)

    source_loc = env['stock.location'].search([('usage', '=', 'customer')], limit=1)
    opt_type = env['stock.picking.type'].search([
        ('default_location_dest_id', '=', ticket.x_studio_return_receipt_location.id),
        ('code', '=', 'incoming'), ('name', '=', 'Returns'), ('company_id', '=', company.id)
    ], limit=1)
    if not opt_type:
        print(json.dumps({'error': 'Returns picking type not found'}))
        sys.exit(1)

    # Create receipt picking (SA1009 flow)
    receipt = env['stock.picking'].create({
        'x_studio_helpdesk_ticket_id': ticket.id,
        'picking_type_id': opt_type.id,
        'location_id': source_loc.id,
        'location_dest_id': opt_type.default_location_dest_id.id,
        'origin': 'Return of ' + source_pick.name,
        'partner_id': ticket.partner_id.id,
        'company_id': company.id,
    })
    pro_group = env['procurement.group'].search([('sale_id', '=', ticket.sale_order_id.id)], limit=1)
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
        'group_id': pro_group.id if pro_group else False,
        'company_id': company.id,
    })
    ml = env['stock.move.line'].create({
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

    # Validate the receipt picking
    receipt._action_done()
    cr.commit()

    # Check ticket state after validation
    ticket.invalidate_recordset()
    print(json.dumps({
        'receiptPickingId': receipt.id,
        'receiptPickingName': receipt.name,
        'receiptState': receipt.state,
        'ticketValidReturn': ticket.x_studio_valid_return,
        'ticketValidConfirmReturn': ticket.x_studio_valid_confirm_return,
    }))
