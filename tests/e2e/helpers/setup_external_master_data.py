"""
Idempotent setup for "Repair - Under Warranty - External not RUG" factory test.

Creates / ensures:
  - Ticket type with x_studio_rug=True, x_studio_rug_confirmed=False
  - Product: Samsung TV 55in (id=4, serial tracking, list_price>=100, invoice_policy=order)
  - A customer stock.lot (serial) with a done outgoing delivery
  - User 2 virtual/source locations
  - Factory location

Returns JSON with all IDs needed by the test.
"""
import os, sys, json
os.environ['ODOO_RC'] = '/etc/odoo/odoo.conf'
import odoo
from odoo.tools import config
config.parse_config(['-c', '/etc/odoo/odoo.conf'])

with odoo.registry('odoo17').cursor() as cr:
    env = odoo.api.Environment(cr, odoo.SUPERUSER_ID, {})

    # 1. Ticket type: rug=True, rug_confirmed=False
    ext_type = env['helpdesk.ticket.type'].search([
        ('x_studio_rug', '=', True),
        ('x_studio_rug_confirmed', '=', False),
    ], limit=1)
    if not ext_type:
        ext_type = env['helpdesk.ticket.type'].create({
            'name': 'Repair - Under Warranty -  External not RUG',
            'x_studio_rug': True,
            'x_studio_rug_confirmed': False,
            'x_studio_with_serial_no': False,
            'x_studio_without_serial_no': False,
        })
        print(f'  Created ticket type id={ext_type.id}', file=sys.stderr)
    else:
        print(f'  Ticket type id={ext_type.id} already exists: "{ext_type.name}"', file=sys.stderr)

    # 2. Product (Samsung TV 55in, id=4)
    product = env['product.product'].browse(4)
    if not product.exists():
        print(json.dumps({'error': 'product.product id=4 not found'}))
        sys.exit(1)
    updates = {}
    if product.list_price < 100.0:
        updates['list_price'] = 250.0
    if product.invoice_policy != 'order':
        updates['invoice_policy'] = 'order'
    if updates:
        product.product_tmpl_id.write(updates)
        print(f'  Updated product: {updates}', file=sys.stderr)

    # 3. Partner
    partner = env['res.partner'].search([('name', 'ilike', 'Test Customer')], limit=1)
    if not partner:
        partner = env['res.partner'].search([('customer_rank', '>', 0)], limit=1)

    # 4. User 2 locations
    user = env['res.users'].browse(2)
    wh_stock = env['stock.location'].browse(8)
    cust_loc = env['stock.location'].browse(5)
    if not user.x_studio_virtual_location or user.x_studio_virtual_location.id != 8:
        user.write({'x_studio_virtual_location': wh_stock.id})
    if not user.x_studio_source_location or user.x_studio_source_location.id != 5:
        user.write({'x_studio_source_location': cust_loc.id})

    # 5. Factory location
    factory_loc = env['stock.location'].search([('x_studio_repair_factory_location', '=', True)], limit=1)
    if not factory_loc:
        wh = env['stock.warehouse'].search([], limit=1)
        factory_loc = env['stock.location'].create({
            'name': 'Factory',
            'usage': 'internal',
            'location_id': wh.lot_stock_id.location_id.id,
            'x_studio_repair_factory_location': True,
        })
        print(f'  Created factory location id={factory_loc.id}', file=sys.stderr)

    # 6. Ensure a done outgoing delivery to customer with a serial for product 4
    customer_loc = env['stock.location'].search([('usage', '=', 'customer')], limit=1)

    existing_ml = env['stock.move.line'].search([
        ('product_id', '=', 4),
        ('picking_code', '=', 'outgoing'),
        ('location_dest_id', '=', customer_loc.id),
        ('state', '=', 'done'),
        ('lot_id', '!=', False),
    ], limit=1)

    if existing_ml:
        lot = existing_ml.lot_id
        orig_pick = existing_ml.picking_id
        print(f'  Found existing lot id={lot.id} "{lot.name}" from picking {orig_pick.name}', file=sys.stderr)

        # Ensure the lot has inventory at the customer location (needed for receipt to work).
        # If it's currently in WH/Stock (returned by a previous test), deliver it back to customer.
        quant_at_customer = env['stock.quant'].search([
            ('lot_id', '=', lot.id), ('location_id', '=', customer_loc.id), ('quantity', '>', 0)
        ], limit=1)
        quant_in_stock = env['stock.quant'].search([
            ('lot_id', '=', lot.id), ('location_id.usage', '=', 'internal'), ('quantity', '>', 0)
        ], limit=1)
        if not quant_at_customer and quant_in_stock:
            print(f'  Lot is at {quant_in_stock.location_id.name}, creating delivery to customer to restore state', file=sys.stderr)
            delivery_type = env['stock.picking.type'].search([
                ('code', '=', 'outgoing'), ('company_id', '=', 1)
            ], limit=1)
            restore_pick = env['stock.picking'].create({
                'picking_type_id': delivery_type.id,
                'location_id': quant_in_stock.location_id.id,
                'location_dest_id': customer_loc.id,
                'company_id': 1,
            })
            restore_move = env['stock.move'].create({
                'picking_id': restore_pick.id,
                'name': 'Restore to customer',
                'product_id': product.id,
                'location_id': quant_in_stock.location_id.id,
                'location_dest_id': customer_loc.id,
                'product_uom_qty': 1.0,
                'product_uom': product.uom_id.id,
                'state': 'assigned',
                'company_id': 1,
            })
            env['stock.move.line'].create({
                'move_id': restore_move.id,
                'picking_id': restore_pick.id,
                'picking_type_id': delivery_type.id,
                'product_id': product.id,
                'product_uom_id': product.uom_id.id,
                'location_id': quant_in_stock.location_id.id,
                'location_dest_id': customer_loc.id,
                'lot_id': lot.id,
                'quantity': 1.0,
                'picked': True,
                'company_id': 1,
            })
            restore_pick._action_done()
            cr.commit()
            print(f'  Delivered lot back to customer via {restore_pick.name}', file=sys.stderr)
        else:
            print(f'  Lot already at customer location (qty={quant_at_customer.quantity if quant_at_customer else 0})', file=sys.stderr)
    else:
        pricelist = env['product.pricelist'].search([], limit=1)
        so = env['sale.order'].create({
            'partner_id': partner.id,
            'pricelist_id': pricelist.id if pricelist else False,
        })
        env['sale.order.line'].create({
            'order_id': so.id,
            'product_id': product.id,
            'product_uom_qty': 1.0,
            'product_uom': product.uom_id.id,
            'price_unit': product.lst_price,
        })
        so.action_confirm()
        cr.commit()

        lot = env['stock.lot'].create({
            'name': 'CUST-TV-EXT-001',
            'product_id': product.id,
            'company_id': 1,
        })

        delivery = so.picking_ids.filtered(
            lambda p: p.picking_type_code == 'outgoing' and p.state not in ('done', 'cancel')
        )
        if not delivery:
            print(json.dumps({'error': 'No outgoing delivery created for SO'}))
            sys.exit(1)
        delivery = delivery[0]

        for ml in delivery.move_line_ids:
            ml.write({'lot_id': lot.id, 'quantity': 1.0, 'picked': True})
        if not delivery.move_line_ids:
            move = delivery.move_ids[0]
            env['stock.move.line'].create({
                'move_id': move.id,
                'picking_id': delivery.id,
                'picking_type_id': delivery.picking_type_id.id,
                'product_id': product.id,
                'product_uom_id': product.uom_id.id,
                'location_id': delivery.location_id.id,
                'location_dest_id': delivery.location_dest_id.id,
                'lot_id': lot.id,
                'quantity': 1.0,
                'picked': True,
                'company_id': 1,
            })
        delivery._action_done()
        cr.commit()
        orig_pick = delivery
        print(f'  Created lot id={lot.id} via SO {so.name} delivery {orig_pick.name}', file=sys.stderr)

    cr.commit()
    print(json.dumps({
        'extTicketTypeId': ext_type.id,
        'extTicketTypeName': ext_type.name,
        'productId': product.id,
        'productName': product.name,
        'productListPrice': product.lst_price,
        'lotId': lot.id,
        'lotName': lot.name,
        'origPickId': orig_pick.id,
        'origPickName': orig_pick.name,
        'userVirtualLocationId': user.x_studio_virtual_location.id,
        'userSourceLocationId': user.x_studio_source_location.id,
        'factoryLocationId': factory_loc.id,
        'partnerId': partner.id,
        'partnerName': partner.name,
    }))
