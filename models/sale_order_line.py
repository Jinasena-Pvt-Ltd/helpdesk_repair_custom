from odoo import api, fields, models


class SaleOrderLine(models.Model):
    _inherit = 'sale.order.line'

    x_studio_rug_confirmed = fields.Boolean(
        related='order_id.x_studio_rug_confirmed', store=True,
        string='RUG Confirmed')
    x_studio_price_unit_original = fields.Float(
        string='Original Price Unit', digits='Product Price')

    @api.onchange('product_id')
    def _onchange_product_id_rug_price(self):
        # Runs after standard product_id_change (MRO order). If this is a new
        # line on a RUG-confirmed repair order, immediately show cost price so
        # the UI reflects what will be saved (cost swap already done on save in create()).
        if not self.product_id:
            return
        order = self.order_id
        if not (order.x_studio_rug_confirmed and order.x_studio_is_repair_order):
            return
        if self.x_studio_price_unit_original:
            return  # already swapped — don't overwrite
        self.x_studio_price_unit_original = self.price_unit
        self.price_unit = self.product_id.standard_price

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            order_id = vals.get('order_id')
            product_id = vals.get('product_id')
            if not order_id or not product_id or vals.get('x_studio_price_unit_original'):
                continue
            order = self.env['sale.order'].browse(order_id)
            if order.x_studio_rug_confirmed and order.x_studio_is_repair_order:
                product = self.env['product.product'].browse(product_id)
                vals['x_studio_price_unit_original'] = vals.get('price_unit', product.lst_price)
                vals['price_unit'] = product.standard_price
        return super().create(vals_list)
