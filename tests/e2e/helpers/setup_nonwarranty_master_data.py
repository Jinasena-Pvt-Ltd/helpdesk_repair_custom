"""
One-time setup for the "Not Under Warranty (Without Serial No)" Factory Repair test.
Idempotent — safe to re-run.

Ensures:
  1. A non-warranty without-serial ticket type exists
  2. Samsung TV 55in (serial-tracked) has a sensible list price >= 100
  3. A repair service product exists (for SO line)
  4. User 2 has virtual/source locations set
  5. A factory location exists (x_studio_repair_factory_location=True)
  6. repair.serial.seq sequence exists
  7. A return-receipt location (WH/Stock id=8) has a matching outgoing picking type

Outputs JSON with all required IDs.
"""
import json, os, sys
os.environ['ODOO_RC'] = '/etc/odoo/odoo.conf'
import odoo
from odoo.tools import config
config.parse_config(['-c', '/etc/odoo/odoo.conf'])
from odoo import SUPERUSER_ID
from odoo.api import Environment

with odoo.registry('odoo17').cursor() as cr:
    env = Environment(cr, SUPERUSER_ID, {})

    # ── 1. Non-warranty without-serial ticket type ────────────────────────────
    nw_type = env['helpdesk.ticket.type'].search([
        ('x_studio_rug', '=', False),
        ('x_studio_without_serial_no', '=', True),
    ], limit=1)
    if not nw_type:
        nw_type = env['helpdesk.ticket.type'].create({
            'name': 'Repair - Not Under Warranty (Without Serial No)',
            'x_studio_rug': False,
            'x_studio_rug_confirmed': False,
            'x_studio_with_serial_no': False,
            'x_studio_without_serial_no': True,
        })
        cr.commit()
        print(f'  Created ticket type id={nw_type.id} "{nw_type.name}"', file=sys.stderr)
    else:
        print(f'  Ticket type exists: id={nw_type.id} "{nw_type.name}"', file=sys.stderr)

    # ── 2. Serial-tracked product — ensure list_price >= 100 ─────────────────
    # Samsung TV 55in (id=4) is the only serial-tracked product
    product = env['product.product'].browse(4)
    if not product.exists() or product.tracking != 'serial':
        product = env['product.product'].search(
            [('tracking', '=', 'serial'), ('type', 'in', ['consu', 'product'])], limit=1)
    if not product.exists():
        # Create a test serial-tracked product
        categ = env['product.category'].browse(1)
        product = env['product.product'].create({
            'name': 'NW Test Repair Product',
            'type': 'consu',
            'tracking': 'serial',
            'list_price': 250.0,
            'standard_price': 100.0,
            'invoice_policy': 'order',
            'categ_id': categ.id,
        })
        cr.commit()
        print(f'  Created serial-tracked product id={product.id} "{product.name}"', file=sys.stderr)
    else:
        tmpl_updates = {}
        if product.list_price < 100.0:
            tmpl_updates['list_price'] = 250.0
        if product.product_tmpl_id.invoice_policy != 'order':
            tmpl_updates['invoice_policy'] = 'order'  # Ordered Quantities — allows invoice before delivery
        if tmpl_updates:
            product.product_tmpl_id.write(tmpl_updates)
            cr.commit()
            print(f'  Updated product id={product.id} "{product.name}": {tmpl_updates}', file=sys.stderr)
        else:
            print(f'  Product: id={product.id} "{product.name}" list_price={product.list_price}', file=sys.stderr)

    # ── 3. Repair service product (for SO line from FSM task) ─────────────────
    svc_prod = env['product.product'].search([
        ('name', 'ilike', 'repair'),
        ('type', '=', 'service'),
    ], limit=1)
    if not svc_prod:
        svc_prod = env['product.product'].search([('type', '=', 'service')], limit=1)
    if not svc_prod:
        svc_prod = env['product.product'].create({
            'name': 'Repair Service',
            'type': 'service',
            'list_price': 50.0,
        })
        cr.commit()
        print(f'  Created service product id={svc_prod.id} "{svc_prod.name}"', file=sys.stderr)
    else:
        print(f'  Service product: id={svc_prod.id} "{svc_prod.name}"', file=sys.stderr)

    # ── 4. User 2 virtual/source locations ───────────────────────────────────
    user2 = env['res.users'].browse(2)
    vl_needed = env['stock.location'].browse(8)   # WH/Stock
    sl_needed = env['stock.location'].search([('usage', '=', 'customer')], limit=1)
    changes = {}
    if not user2.x_studio_virtual_location:
        changes['x_studio_virtual_location'] = vl_needed.id
    if not user2.x_studio_source_location:
        changes['x_studio_source_location'] = sl_needed.id if sl_needed else False
    if changes:
        user2.write(changes)
        cr.commit()
        print(f'  Set user 2 locations: {changes}', file=sys.stderr)
    else:
        print('  User 2 locations already set', file=sys.stderr)

    # ── 5. Factory location ───────────────────────────────────────────────────
    factory_loc = env['stock.location'].search(
        [('x_studio_repair_factory_location', '=', True)], limit=1)
    if not factory_loc:
        wh_view = env['stock.location'].browse(7)
        if not wh_view.exists():
            wh_view = env['stock.location'].search(
                [('usage', '=', 'view'), ('name', 'like', 'WH')], limit=1)
        factory_loc = env['stock.location'].create({
            'name': 'Factory',
            'location_id': wh_view.id,
            'usage': 'internal',
            'x_studio_repair_factory_location': True,
        })
        cr.commit()
        print(f'  Created factory location: id={factory_loc.id} "{factory_loc.complete_name}"', file=sys.stderr)
    else:
        print(f'  Factory location: id={factory_loc.id} "{factory_loc.complete_name}"', file=sys.stderr)

    # ── 6. repair.serial.seq sequence ────────────────────────────────────────
    seq = env['ir.sequence'].search([('code', '=', 'repair.serial.seq')], limit=1)
    if not seq:
        seq = env['ir.sequence'].create({
            'name': 'Repair Serial Number Sequence',
            'code': 'repair.serial.seq',
            'prefix': 'RS/',
            'padding': 5,
            'company_id': 1,
        })
        cr.commit()
        print(f'  Created repair.serial.seq id={seq.id}', file=sys.stderr)
    else:
        print(f'  repair.serial.seq exists: id={seq.id}', file=sys.stderr)

    # ── 7. Verify outgoing picking type from WH/Stock ─────────────────────────
    # action_create_repair_serial needs: picking.type where
    #   default_location_src_id = x_studio_return_receipt_location, code=outgoing
    # We use WH/Stock (id=8) as the return_receipt_location, so picking type id=2
    # (Delivery Orders, src=WH/Stock) should match.
    opt = env['stock.picking.type'].search([
        ('default_location_src_id', '=', 8),
        ('code', '=', 'outgoing'),
        ('company_id', '=', 1),
    ], limit=1)
    if opt:
        print(f'  Outgoing picking type from WH/Stock: id={opt.id} "{opt.name}"', file=sys.stderr)
    else:
        print('  WARNING: No outgoing picking type from WH/Stock — action_create_repair_serial will fail!', file=sys.stderr)

    # ── 8. Ensure test partner exists ─────────────────────────────────────────
    partner = env['res.partner'].search([('name', 'ilike', 'Test Customer')], limit=1)
    if not partner:
        partner = env['res.partner'].search([], limit=1)
    print(f'  Partner: id={partner.id} "{partner.name}"', file=sys.stderr)

    # Output JSON
    print(json.dumps({
        'nwTicketTypeId': nw_type.id,
        'nwTicketTypeName': nw_type.name,
        'productId': product.id,
        'productName': product.name,
        'productListPrice': product.list_price,
        'serviceProductId': svc_prod.id,
        'serviceProductName': svc_prod.name,
        'userVirtualLocationId': user2.x_studio_virtual_location.id if user2.x_studio_virtual_location else None,
        'userSourceLocationId': user2.x_studio_source_location.id if user2.x_studio_source_location else None,
        'factoryLocationId': factory_loc.id,
        'factoryLocationName': factory_loc.complete_name,
        'repairSerialSeqId': seq.id,
        'outgoingPickingTypeId': opt.id if opt else None,
        'partnerId': partner.id,
        'partnerName': partner.name,
    }))
