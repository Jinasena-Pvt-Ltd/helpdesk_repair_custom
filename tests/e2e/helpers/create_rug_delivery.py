"""
Create a fresh serial + validated delivery for one RUG test run.
Outputs JSON: {"serialName": "...", "pickingId": N, "lotId": N}
"""
import sys, json
import odoo
from odoo import SUPERUSER_ID
from odoo.api import Environment

with odoo.registry('odoo17').cursor() as cr:
    env = Environment(cr, SUPERUSER_ID, {})

    base_lot = env['stock.lot'].search([('name','=','SN-RUG-TEST-001')], limit=1)
    if not base_lot:
        sys.exit('SN-RUG-TEST-001 not found')
    product = base_lot.product_id

    customer = env['res.partner'].search([('name','=','Test Customer RUG')], limit=1)
    if not customer:
        sys.exit('Test Customer RUG not found')

    existing = env['stock.lot'].search([('name','like','SN-RUG-AUTO-')])
    n = len(existing) + 1
    serial_name = f'SN-RUG-AUTO-{n:03d}'
    lot = env['stock.lot'].create({'name': serial_name, 'product_id': product.id, 'company_id': 1})

    # Put qty=1 in WH/Stock via inventory adjustment so quants are correctly tracked
    # throughout the full flow (delivery → receipt → dispatch).
    wh_stock = env['stock.location'].browse(8)  # WH/Stock id=8
    quant = env['stock.quant'].search([
        ('product_id', '=', product.id), ('lot_id', '=', lot.id), ('location_id', '=', wh_stock.id)
    ], limit=1)
    if quant:
        quant.inventory_quantity = 1
        quant.action_apply_inventory()
    else:
        env['stock.quant'].create({
            'product_id': product.id, 'lot_id': lot.id,
            'location_id': wh_stock.id, 'inventory_quantity': 1,
        }).action_apply_inventory()

    so = env['sale.order'].create({
        'partner_id': customer.id,
        'order_line': [(0, 0, {'product_id': product.id, 'product_uom_qty': 1})],
    })
    so.action_confirm()

    pick = so.picking_ids.filtered(lambda p: p.picking_type_code == 'outgoing')[:1]
    if not pick:
        sys.exit('No delivery picking found')

    move = pick.move_ids[:1]
    ml = env['stock.move.line'].create({
        'picking_id': pick.id,
        'move_id': move.id,
        'product_id': product.id,
        'lot_id': lot.id,
        'quantity': 1,
        'picked': True,          # ← required in Odoo 17 for _action_done to process this line
        'location_id': pick.location_id.id,
        'location_dest_id': pick.location_dest_id.id,
    })

    pick._action_done()

    if pick.state != 'done':
        sys.exit(f'Pick {pick.id} not done after _action_done (state={pick.state})')

    cr.commit()
    print(json.dumps({'serialName': serial_name, 'pickingId': pick.id, 'lotId': lot.id}))
