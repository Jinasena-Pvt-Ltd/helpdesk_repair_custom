"""
Idempotent setup for "Repair - Not Under Warranty (With Serial No)" factory test.

Creates / ensures:
  - Ticket type with x_studio_with_serial_no=True
  - Product: Samsung TV 55in (id=4, tracking=serial, list_price>=100, invoice_policy=order)
  - A customer stock.lot (serial) for that product
  - A done outgoing sale delivery for that serial (so Update Serial SA can find it)
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

    # 1. Ticket type
    ws_type = env['helpdesk.ticket.type'].search([
        ('x_studio_rug', '=', False),
        ('x_studio_with_serial_no', '=', True),
        ('x_studio_without_serial_no', '=', False),
    ], limit=1)
    if not ws_type:
        ws_type = env['helpdesk.ticket.type'].create({
            'name': 'Repair - Not Under Warranty (With Serial No)',
            'x_studio_rug': False,
            'x_studio_rug_confirmed': False,
            'x_studio_with_serial_no': True,
            'x_studio_without_serial_no': False,
        })
        print(f'  Created ticket type id={ws_type.id}', file=sys.stderr)
    else:
        print(f'  Ticket type id={ws_type.id} already exists', file=sys.stderr)

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
    wh_stock = env['stock.location'].browse(8)   # WH/Stock
    cust_loc = env['stock.location'].browse(5)   # Partners/Customers
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

    # 6. Create a customer serial (stock.lot) if none exists with a proper delivery
    #    The Update Serial SA needs: stock.move.line where product=4, lot=our lot,
    #    picking_code='outgoing', location_dest_id=customer_loc.id
    #    AND picking.origin matches a sale.order name.

    customer_loc = env['stock.location'].search([('usage', '=', 'customer')], limit=1)

    # Check if we already have a suitable lot+delivery
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
        print(f'  Using existing lot id={lot.id} "{lot.name}" from picking {orig_pick.name}', file=sys.stderr)
    else:
        # Create a sale order
        pricelist = env['product.pricelist'].search([('currency_id.name', '=', 'USD')], limit=1)
        if not pricelist:
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

        # Create stock.lot for this delivery
        lot = env['stock.lot'].create({
            'name': 'CUST-TV-WS-001',
            'product_id': product.id,
            'company_id': 1,
        })

        # Find the SO delivery
        delivery = so.picking_ids.filtered(lambda p: p.picking_type_code == 'outgoing' and p.state not in ('done', 'cancel'))
        if not delivery:
            print(json.dumps({'error': 'No outgoing delivery created for SO'}))
            sys.exit(1)
        delivery = delivery[0]

        # Assign lot and validate
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
        print(f'  Created lot id={lot.id} "{lot.name}" via SO {so.name} delivery {orig_pick.name}', file=sys.stderr)

    cr.commit()
    print(json.dumps({
        'wsTicketTypeId': ws_type.id,
        'wsTicketTypeName': ws_type.name,
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
