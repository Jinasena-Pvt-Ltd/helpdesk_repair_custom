from odoo import fields, models


class AccountPayment(models.Model):
    _inherit = 'account.payment'

    x_studio_sales_order = fields.Many2one('sale.order', string='Sales Order')


class AccountPaymentRegister(models.TransientModel):
    _inherit = 'account.payment.register'

    def action_create_payments(self):
        invoices = self.line_ids.move_id.filtered(
            lambda m: m.move_type in ('out_invoice', 'out_refund')
        )
        result = super().action_create_payments()
        for invoice in invoices:
            orders = invoice.invoice_line_ids.sale_line_ids.mapped('order_id')
            for order in orders:
                for task, ticket in order._ticket_for_order(order):
                    order._advance_ticket_stage(
                        ticket, task,
                        'Advance Received',
                        'x_studio_invoice_stage_updated',
                        task_flag='x_studio_valid_invoiced_so',
                    )
        return result
