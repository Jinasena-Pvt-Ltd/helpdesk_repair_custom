"""
Validate the dispatch picking (x_studio_is_dispatch=True) for a given ticket id.
Bypasses stock reservation by creating a move line with picked=True and calling _action_done.
Outputs JSON: {"pickingId": N, "state": "done"}
"""
import sys, json
import odoo
from odoo import SUPERUSER_ID
from odoo.api import Environment

ticket_id = int(sys.argv[1]) if len(sys.argv) > 1 else None
if not ticket_id:
    sys.exit('Usage: validate_dispatch_picking.py <ticket_id>')

with odoo.registry('odoo17').cursor() as cr:
    env = Environment(cr, SUPERUSER_ID, {})

    pick = env['stock.picking'].search([
        ('x_studio_helpdesk_ticket_id', '=', ticket_id),
        ('x_studio_is_dispatch', '=', True),
        ('state', 'not in', ['done', 'cancel']),
    ], limit=1)
    if not pick:
        sys.exit(f'No pending dispatch picking for ticket {ticket_id}')

    if not pick.move_ids:
        sys.exit(f'Dispatch picking {pick.id} has no moves')

    move = pick.move_ids[0]
    lot = None
    # Find the serial from the ticket
    ticket = env['helpdesk.ticket'].browse(ticket_id)
    if ticket.lot_id:
        lot = ticket.lot_id
    elif ticket.x_studio_serial_no:
        lot = ticket.x_studio_serial_no

    # If the serial is already at the destination, use it as both source and dest
    # (avoids "serial already assigned" when SO delivery already moved it there)
    actual_src = move.location_id
    if lot:
        quant = env['stock.quant'].search([
            ('lot_id', '=', lot.id),
            ('quantity', '>', 0),
        ], limit=1)
        if quant and quant.location_id.id == move.location_dest_id.id:
            actual_src = move.location_dest_id

    env['stock.move.line'].create({
        'picking_id': pick.id,
        'move_id': move.id,
        'product_id': move.product_id.id,
        'lot_id': lot.id if lot else False,
        'quantity': 1,
        'picked': True,
        'location_id': actual_src.id,
        'location_dest_id': move.location_dest_id.id,
    })

    pick._action_done()

    if pick.state != 'done':
        sys.exit(f'Dispatch picking {pick.id} still not done (state={pick.state})')

    cr.commit()
    print(json.dumps({'pickingId': pick.id, 'state': pick.state}))
