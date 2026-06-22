from odoo import models


class StockLot(models.Model):
    _inherit = 'stock.lot'

    def _compute_last_delivery_partner_id(self):
        # Core bug: sorted(key='date_done') raises TypeError when some pickings have
        # date_done=False (bool) vs datetime.datetime. Filter to done pickings first.
        serial_products = self.filtered(lambda l: l.product_id.tracking == 'serial')
        delivery_ids_by_lot = serial_products._find_delivery_ids_by_lot_iterative()
        (self - serial_products).last_delivery_partner_id = False
        for lot in serial_products:
            pickings = self.env['stock.picking'].browse(
                delivery_ids_by_lot.get(lot.id, [])
            ).filtered(lambda p: p.date_done)
            if pickings:
                lot.last_delivery_partner_id = pickings.sorted(
                    key='date_done', reverse=True
                )[0].partner_id
            else:
                lot.last_delivery_partner_id = False
