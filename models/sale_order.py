import datetime
from collections import defaultdict
from odoo import fields, models
from odoo.exceptions import UserError


class SaleOrder(models.Model):
    _inherit = 'sale.order'

    x_studio_order_payment_method = fields.Selection([
        ('Cash', 'Cash'),
        ('Credit', 'Credit'),
    ], string='Order Payment Type')
    x_studio_rug_approved = fields.Boolean(string='RUG Approved')
    x_studio_rug_rejected = fields.Boolean(string='RUG Rejected')
    x_studio_re_estimate_count = fields.Integer(string='Re-estimate Count')

    def _ticket_for_order(self, order):
        """Return (task, ticket) pairs linked to this order via FSM tasks."""
        tasks = self.env['project.task'].search([('sale_order_id', '=', order.id)])
        return [(t, t.helpdesk_ticket_id) for t in tasks if t.helpdesk_ticket_id]

    def _advance_ticket_stage(self, ticket, task, stage_name, flag, task_flag=None):
        """Move ticket to stage_name once, guarded by flag. Optionally set task_flag."""
        if ticket[flag]:
            return
        stage_id = ticket._get_stage_by_name(stage_name)
        if not stage_id:
            return
        ticket.write({
            'stage_id': stage_id,
            'x_studio_stage_date': datetime.datetime.now(),
            flag: True,
        })
        if task_flag:
            task[task_flag] = True

    def action_confirm(self):
        for order in self:
            order._check_resupply_warehouse_stock()
        return super().action_confirm()

    def _check_resupply_warehouse_stock(self):
        self.ensure_one()
        if self.state not in ('draft', 'sent'):
            return
        resupply_whs = self.warehouse_id.resupply_wh_ids
        if not resupply_whs:
            return
        locations = resupply_whs.mapped('lot_stock_id')
        needed = defaultdict(float)
        for line in self.order_line:
            if line.display_type or line.product_id.type != 'product':
                continue
            remaining = line.product_uom_qty - line.qty_delivered
            if remaining <= 0:
                continue
            qty_in_product_uom = line.product_uom._compute_quantity(
                remaining, line.product_id.uom_id)
            needed[line.product_id] += qty_in_product_uom
        if not needed:
            return
        products = self.env['product.product'].browse([p.id for p in needed])
        available = {p.id: 0.0 for p in products}
        for loc in locations:
            for p in products.with_context(location=loc.id):
                available[p.id] += p.free_qty
        shortages = []
        for product, required in needed.items():
            have = available.get(product.id, 0.0)
            if have + 1e-6 < required:
                shortages.append(
                    "- %s: need %s %s, available %s %s in %s" % (
                        product.display_name,
                        required, product.uom_id.name,
                        have, product.uom_id.name,
                        ', '.join(resupply_whs.mapped('name'))))
        if shortages:
            raise UserError(
                "Cannot confirm %s: insufficient stock in the resupply "
                "warehouse for the following products:\n%s\n\n"
                "Please replenish the resupply warehouse and try again."
                % (self.name, "\n".join(shortages)))

    def write(self, vals):
        old_states = {so.id: so.state for so in self} if 'state' in vals else {}
        result = super().write(vals)
        if 'state' not in vals:
            return result
        new_state = vals['state']
        for order in self:
            if old_states.get(order.id) == new_state:
                continue
            for task, ticket in self._ticket_for_order(order):
                if new_state == 'sent':
                    self._advance_ticket_stage(
                        ticket, task,
                        'Estimation Sent to Customer',
                        'x_studio_estimation_sent_stage_updated',
                        task_flag='x_studio_valid_confirm_so',
                    )
                elif new_state == 'sale':
                    self._advance_ticket_stage(
                        ticket, task,
                        'Estimation Approval Received',
                        'x_studio_estimation_approved_stage_updated',
                        task_flag='x_studio_valid_confirm2_so',
                    )
        return result

