from odoo import fields, models


class SaleOrderLine(models.Model):
    _inherit = 'sale.order.line'

    x_studio_rug_confirmed = fields.Boolean(
        related='order_id.x_studio_rug_confirmed', store=True,
        string='RUG Confirmed')
    x_studio_price_unit_original = fields.Float(
        string='Original Price Unit', digits='Product Price')
