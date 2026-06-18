"""
One-time setup: ensure a stock.location with x_studio_repair_factory_location=True exists.
Required for action_send_to_factory (raises UserError if no factory location found).
Idempotent — safe to re-run.
Outputs JSON: {"factoryLocationId": N, "factoryLocationName": "..."}
"""
import json
import os
import sys

os.environ['ODOO_RC'] = '/etc/odoo/odoo.conf'
import odoo
from odoo.tools import config
config.parse_config(['-c', '/etc/odoo/odoo.conf'])
from odoo import SUPERUSER_ID
from odoo.api import Environment

with odoo.registry('odoo17').cursor() as cr:
    env = Environment(cr, SUPERUSER_ID, {})

    # Check if a factory location already exists
    factory_loc = env['stock.location'].search(
        [('x_studio_repair_factory_location', '=', True)], limit=1)

    if not factory_loc:
        # Create WH/Factory as a child of WH view location (id=7)
        wh_view = env['stock.location'].browse(7)
        if not wh_view.exists():
            # fallback: find any internal parent location
            wh_view = env['stock.location'].search(
                [('usage', '=', 'view'), ('name', 'like', 'WH')], limit=1)
        factory_loc = env['stock.location'].create({
            'name': 'Factory',
            'location_id': wh_view.id,
            'usage': 'internal',
            'x_studio_repair_factory_location': True,
        })
        cr.commit()
        print(f'  Created factory location: {factory_loc.id} "{factory_loc.complete_name}"',
              file=sys.stderr)
    else:
        print(f'  Factory location already exists: {factory_loc.id} "{factory_loc.complete_name}"',
              file=sys.stderr)

    # ── Set x_studio_virtual_location + x_studio_source_location on user 2 ──────
    # These are required by the RUG return wizard (SA1009) when clicking "Return":
    #   virtual_location = WH/Stock (id=8)  — where items physically land after return
    #   source_location  = Partners/Customers (id=5)  — outgoing picking source
    # Without these on the user, ticket.x_studio_virtual_location is empty, and the
    # RUG return server action raises "Virtual & Source Locations must be setup...".
    user2 = env['res.users'].browse(2)
    vl_needed = env['stock.location'].browse(8)   # WH/Stock
    sl_needed = env['stock.location'].browse(5)   # Partners/Customers
    changes = {}
    if not user2.x_studio_virtual_location:
        changes['x_studio_virtual_location'] = vl_needed.id
    if not user2.x_studio_source_location:
        changes['x_studio_source_location'] = sl_needed.id
    if changes:
        user2.write(changes)
        cr.commit()
        print(f'  Set user 2 locations: {changes}', file=sys.stderr)
    else:
        print(f'  User 2 locations already set', file=sys.stderr)

    # ── Fix ticket type id=4: ensure both x_studio_rug + x_studio_rug_confirmed = True ──
    # Without x_studio_rug_confirmed=True on the type, the "Change Repair Type to RUG"
    # server action never matches (requires both flags), and ticket._sync_ticket_type_flags
    # (onchange) leaves ticket.x_studio_rug_confirmed=False — so RUG buttons stay hidden.
    ticket_type = env['helpdesk.ticket.type'].browse(4)
    if not ticket_type.exists():
        ticket_type = env['helpdesk.ticket.type'].search(
            [('x_studio_rug', '=', True)], limit=1)
    if ticket_type.exists():
        if not ticket_type.x_studio_rug_confirmed:
            ticket_type.write({'x_studio_rug_confirmed': True})
            cr.commit()
            print(f'  Set x_studio_rug_confirmed=True on ticket type id={ticket_type.id}'
                  f' ("{ticket_type.name}")', file=sys.stderr)
        else:
            print(f'  Ticket type id={ticket_type.id} already has x_studio_rug_confirmed=True',
                  file=sys.stderr)
    else:
        print('  WARNING: No RUG ticket type found (x_studio_rug=True) — skipping',
              file=sys.stderr)

    # ── Ensure x_repair_accounts record exists with a valid income account ────────
    # action_update_rug_account raises UserError if no record is found.
    existing_rug_cfg = env['x_repair_accounts'].search([], limit=1)
    if existing_rug_cfg and existing_rug_cfg.x_studio_rug_account:
        print(f'  x_repair_accounts id={existing_rug_cfg.id} already has'
              f' RUG account "{existing_rug_cfg.x_studio_rug_account.name}"',
              file=sys.stderr)
        rug_account_id = existing_rug_cfg.x_studio_rug_account.id
    else:
        income_acc = env['account.account'].search([
            ('account_type', 'in', ('income', 'income_other')),
            ('deprecated', '=', False),
        ], limit=1)
        if not income_acc:
            print('  WARNING: No income account found — cannot create x_repair_accounts',
                  file=sys.stderr)
            rug_account_id = None
        else:
            company = env['res.company'].search([], limit=1)
            if existing_rug_cfg:
                existing_rug_cfg.write({'x_studio_rug_account': income_acc.id})
                rug_account_id = income_acc.id
                print(f'  Filled RUG account on existing x_repair_accounts id={existing_rug_cfg.id}:'
                      f' "{income_acc.name}"', file=sys.stderr)
            else:
                new_rec = env['x_repair_accounts'].create({
                    'x_studio_rug_account': income_acc.id,
                    'x_studio_company_id': company.id if company else False,
                })
                rug_account_id = income_acc.id
                print(f'  Created x_repair_accounts id={new_rec.id} with account'
                      f' "{income_acc.name}" (id={income_acc.id})', file=sys.stderr)
            cr.commit()

    print(json.dumps({
        'factoryLocationId': factory_loc.id,
        'factoryLocationName': factory_loc.complete_name,
        'userVirtualLocationId': user2.x_studio_virtual_location.id,
        'userSourceLocationId': user2.x_studio_source_location.id,
        'ticketTypeRugConfirmed': ticket_type.exists() and ticket_type.x_studio_rug_confirmed,
        'rugAccountId': rug_account_id if 'rug_account_id' in dir() else None,
    }))
