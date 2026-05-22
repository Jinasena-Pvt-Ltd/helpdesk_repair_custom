from odoo import api, fields, models


class StockReturnPicking(models.TransientModel):
    _inherit = 'stock.return.picking'

    x_studio_repair_rug = fields.Boolean(string='Repair RUG')
    x_studio_repair_normal_with_serial_no = fields.Boolean(string='Repair Normal With Serial No')
    x_studio_repair_normal_without_serial_no = fields.Boolean(string='Repair Normal Without Serial No')
    x_studio_suggested_location_id = fields.Many2one(
        'stock.location', string='Suggested Return Location', ondelete='set null')
    x_studio_suggested_location_id_1 = fields.Many2one(
        'stock.location', string='Suggested Return Location', ondelete='set null')

    @api.onchange('picking_id')
    def _onchange_picking_id_ticket_location(self):
        """After base onchange computes location_id from the picking, override it with
        the ticket's virtual repair location and populate both suggested location fields
        (used by the RUG Return validation and displayed in the wizard)."""
        ticket_id = self.env.context.get('default_ticket_id')
        if not ticket_id or not self.picking_id:
            return
        ticket = self.env['helpdesk.ticket'].browse(ticket_id)
        company_id = self.env.context.get('allowed_company_ids', [self.env.user.company_id.id])[0]
        if company_id == 1:
            virtual_loc = ticket.x_studio_virtual_location
        else:
            virtual_loc = ticket.x_studio_virtual_location_1
        if virtual_loc:
            self.location_id = virtual_loc
            self.x_studio_suggested_location_id = virtual_loc
            self.x_studio_suggested_location_id_1 = virtual_loc
