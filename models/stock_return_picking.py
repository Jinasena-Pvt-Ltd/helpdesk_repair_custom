from odoo import api, fields, models
from odoo.exceptions import UserError


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

    @api.depends('picking_id')
    def _compute_moves_locations(self):
        """Extend the base compute to sync suggested location fields with location_id
        so the wizard opens with both fields showing the same value."""
        super()._compute_moves_locations()
        for wizard in self:
            if not wizard.picking_id or wizard.x_studio_is_dispatch:
                continue
            user = self.env.user
            virtual_loc = user.x_studio_virtual_location or (
                wizard.ticket_id.x_studio_virtual_location
            )
            if virtual_loc:
                wizard.location_id = virtual_loc
                wizard.x_studio_suggested_location_id = virtual_loc
                wizard.x_studio_suggested_location_id_1 = virtual_loc
            else:
                wizard.x_studio_suggested_location_id = wizard.location_id
                wizard.x_studio_suggested_location_id_1 = wizard.location_id

    @api.onchange('x_studio_suggested_location_id', 'x_studio_suggested_location_id_1')
    def _onchange_suggested_location_sync(self):
        """Keep Return Location in sync with whichever Suggested Return Location field is active."""
        company_id = self.env.context.get(
            'allowed_company_ids', [self.env.user.company_id.id])[0]
        suggested = (
            self.x_studio_suggested_location_id
            if company_id == 1
            else self.x_studio_suggested_location_id_1
        )
        if suggested:
            self.location_id = suggested

    @api.onchange('location_id')
    def _onchange_location_id_validate_rug(self):
        """Raise if a RUG/serial return is being sent to the wrong location."""
        if not self.ticket_id:
            return
        if not (self.x_studio_repair_rug or self.x_studio_repair_normal_with_serial_no):
            return
        if self.x_studio_is_dispatch:
            return
        company_id = self.env.context.get(
            'allowed_company_ids', [self.env.user.company_id.id])[0]
        suggested = (
            self.x_studio_suggested_location_id
            if company_id == 1
            else self.x_studio_suggested_location_id_1
        )
        if suggested and self.location_id and self.location_id != suggested:
            raise UserError(
                'Return Location should be equal to Suggested Return Location.')

    @api.onchange('picking_id')
    def _onchange_picking_id_ticket_location(self):
        """For dispatch returns, override location_id to the ticket's return receipt location."""
        ticket_id = self.env.context.get('default_ticket_id')
        if not ticket_id or not self.picking_id or not self.x_studio_is_dispatch:
            return
        ticket = self.env['helpdesk.ticket'].browse(ticket_id)
        if ticket.x_studio_return_receipt_location:
            self.location_id = ticket.x_studio_return_receipt_location

    def _get_incoming_picking_type_for_location(self, location):
        """Return the 'incoming' picking type whose warehouse contains location."""
        wh = location.warehouse_id or self.env['stock.warehouse'].search(
            [('view_location_id', 'parent_of', location.id)], limit=1)
        if not wh:
            return None
        return self.env['stock.picking.type'].search(
            [('code', '=', 'incoming'), ('warehouse_id', '=', wh.id)], limit=1)

    def create_returns(self):
        result = super().create_returns()
        new_picking = self.env['stock.picking'].browse(result.get('res_id'))
        ticket = self.ticket_id
        if new_picking and ticket:
            new_picking.x_studio_created_from_help_ticket = ticket.id
            new_picking.x_studio_helpdesk_ticket_id = ticket.id
            if self.x_studio_is_dispatch:
                new_picking.x_studio_is_dispatch = True
                task = self.env['project.task'].search(
                    [('helpdesk_ticket_id', '=', ticket.id)], limit=1)
                if task:
                    task.x_studio_dispatch_done = True

        # Re-sequence the return picking using the receipts picking type for the
        # return location's warehouse (e.g. BR-EK/IN/00001 instead of WH/RETN/...).
        if new_picking and self.location_id and not self.x_studio_is_dispatch:
            pt = self._get_incoming_picking_type_for_location(self.location_id)
            if pt and pt.sequence_id:
                new_picking.name = pt.sequence_id.next_by_id()

        return result
