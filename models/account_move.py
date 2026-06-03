from odoo import api, fields, models
from odoo.exceptions import UserError


class AccountMove(models.Model):
    _inherit = 'account.move'

    x_studio_sale_id = fields.Many2one(
        'sale.order', string='Sale Order',
        compute='_compute_x_studio_sale_id', store=True, readonly=False)

    @api.depends('invoice_line_ids.sale_line_ids.order_id')
    def _compute_x_studio_sale_id(self):
        for move in self:
            if not move.x_studio_sale_id:
                move.x_studio_sale_id = move.invoice_line_ids.sale_line_ids.order_id[:1]
    x_studio_rug_confirmed = fields.Boolean(
        related='x_studio_sale_id.x_studio_rug_confirmed', store=True,
        string='RUG Confirmed')
    x_studio_rug_rejected = fields.Boolean(
        related='x_studio_sale_id.x_studio_rug_rejected', store=True,
        string='RUG Rejected')
    x_studio_rug_acc_updated = fields.Boolean(string='RUG Account Updated')

    def action_update_rug_account(self):
        self.ensure_one()
        if not self.x_studio_rug_confirmed:
            return
        company_id = self.env.context.get(
            'allowed_company_ids', [self.env.user.company_id.id])[0]
        company = self.env['res.company'].browse(company_id)

        rug_account_rec = self.env['x_repair_accounts'].search(
            [('x_studio_company_id', '=', company.id)], limit=1)
        if not rug_account_rec:
            rug_account_rec = self.env['x_repair_accounts'].search(
                [('x_studio_company_id', '=', False)], limit=1)
        if not rug_account_rec or not rug_account_rec.x_studio_rug_account:
            raise UserError('RUG Account must be Specified in Repair Accounts')

        lines = self.env['account.move.line'].search([
            ('move_id', '=', self.id),
            ('account_id.user_type_id.internal_group', '=', 'income'),
        ])
        if lines:
            was_posted = self.state == 'posted'
            if was_posted:
                self.button_draft()
            for line in lines:
                line.write({'account_id': rug_account_rec.x_studio_rug_account.id})
            if was_posted:
                self.action_post()
                self._compute_payment_state()

        self.write({'x_studio_rug_acc_updated': True})
