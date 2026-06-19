"""
Create the FSM Sale Order and add a SO line for a non-warranty repair ticket.
Args: <task_id> <product_id>

In O17 industry_fsm_sale, adding a serial-tracked product via the product catalog
opens the fsm.stock.tracking wizard (which can't be handled in headless Playwright).
This script bypasses the catalog by:
  1. Ensuring the task's SO exists (creates it if not)
  2. Adding a SO line directly via ORM

For non-warranty repairs, the SO line should be at the product's list_price
(no RUG cost-swap applies since x_studio_rug_confirmed=False).

Returns JSON: {soId, soName, soState, lineId, priceUnit, listPrice, rugConfirmed}
"""
import os, sys, json
os.environ['ODOO_RC'] = '/etc/odoo/odoo.conf'
import odoo
from odoo.tools import config
config.parse_config(['-c', '/etc/odoo/odoo.conf'])

task_id = int(sys.argv[1])
product_id = int(sys.argv[2])

with odoo.registry('odoo17').cursor() as cr:
    env = odoo.api.Environment(cr, odoo.SUPERUSER_ID, {})

    task = env['project.task'].browse(task_id)
    if not task.exists():
        print(json.dumps({'error': f'Task {task_id} not found'}))
        sys.exit(1)

    product = env['product.product'].browse(product_id)
    if not product.exists():
        print(json.dumps({'error': f'Product {product_id} not found'}))
        sys.exit(1)

    # Ensure SO exists (creates draft SO if not already linked)
    if not task.sale_order_id:
        task._fsm_ensure_sale_order()
        cr.commit()
        print(f'  Created SO: {task.sale_order_id.name}', file=sys.stderr)
    else:
        print(f'  SO already exists: {task.sale_order_id.name}', file=sys.stderr)

    so = task.sale_order_id
    if not so:
        print(json.dumps({'error': 'Failed to create/find SO for task'}))
        sys.exit(1)

    print(f'  SO state={so.state}, locked={so.locked}, is_repair={so.x_studio_is_repair_order}', file=sys.stderr)

    # If SO is locked (confirmed + locked by our action_confirm), unlock it first
    if so.locked:
        so.action_unlock()
        print(f'  Unlocked SO', file=sys.stderr)

    # Ensure SO is in draft/sent so we can add lines
    if so.state not in ('draft', 'sent', 'sale'):
        print(json.dumps({'error': f'SO in unexpected state: {so.state}'}))
        sys.exit(1)

    # Add SO line at list price (non-warranty: no cost-swap)
    price_unit = product.lst_price
    line = env['sale.order.line'].create({
        'order_id': so.id,
        'product_id': product.id,
        'product_uom_qty': 1.0,
        'product_uom': product.uom_id.id,
        'price_unit': price_unit,
        'task_id': task.id,
    })
    cr.commit()
    print(f'  Added SO line: {product.name} at {price_unit}', file=sys.stderr)

    # Verify: no RUG price-swap should have occurred
    line.invalidate_recordset()
    so.invalidate_recordset()

    print(json.dumps({
        'soId': so.id,
        'soName': so.name,
        'soState': so.state,
        'soLocked': so.locked,
        'lineId': line.id,
        'priceUnit': line.price_unit,
        'listPrice': product.lst_price,
        'rugConfirmed': so.x_studio_rug_confirmed,
        'isRepairOrder': so.x_studio_is_repair_order,
    }))
