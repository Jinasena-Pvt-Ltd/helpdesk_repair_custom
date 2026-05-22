import datetime
from odoo import fields, models


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

