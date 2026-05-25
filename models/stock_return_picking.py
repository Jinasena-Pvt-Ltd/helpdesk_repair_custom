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
    x_studio_is_dispatch = fields.Boolean(string='Is Dispatch Return')

    @api.onchange('picking_id')
    def _onchange_picking_id_ticket_location(self):
        """After base onchange computes location_id from the picking, override it with
        the ticket's virtual repair location and populate both suggested location fields
        (used by the RUG Return validation and displayed in the wizard).
        For dispatch returns (second return going virtual → customer), set location_id
        to the customer location instead and skip the virtual-location override."""
        ticket_id = self.env.context.get('default_ticket_id')
        if not ticket_id or not self.picking_id:
            return

        # Dispatch second return: goods go back to the customer, not the repair location.
        if self.x_studio_is_dispatch:
            customer_loc = self.env['stock.location'].search(
                [('usage', '=', 'customer')], limit=1)
            if customer_loc:
                self.location_id = customer_loc
            return

        # Normal RUG/repair return: override to ticket's virtual repair location.
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

    def create_returns(self):
        result = super().create_returns()
        if not self.x_studio_is_dispatch:
            return result
        new_picking = self.env['stock.picking'].browse(result.get('res_id'))
        if new_picking:
            new_picking.x_studio_is_dispatch = True
            ticket = self.ticket_id
            if ticket:
                new_picking.x_studio_helpdesk_ticket_id = ticket.id
                task = self.env['project.task'].search(
                    [('helpdesk_ticket_id', '=', ticket.id)], limit=1)
                if task:
                    task.x_studio_dispatch_done = True
        return result
