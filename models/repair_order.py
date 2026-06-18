import datetime
from odoo import fields, models


class RepairOrder(models.Model):
    _inherit = 'repair.order'

    x_studio_confirm_draft_quotation = fields.Boolean(
        string='Confirm Draft Quotation', default=False)

    def action_repair_end(self):
        result = super().action_repair_end()
        # For RUG Centre-Repair tickets: advance to 'Repair Completed' when repair is done.
        # Normal/Factory repairs advance via stock.picking button_validate (FSM+SO path).
        for repair in self.filtered(lambda r: r.state == 'done' and r.ticket_id):
            ticket = repair.ticket_id
            if (ticket.x_studio_rug_repair
                    and not ticket.x_studio_repair_complete_stage_updated):
                stage_id = ticket._get_stage_by_name('Repair Completed')
                if stage_id:
                    ticket.write({
                        'stage_id': stage_id,
                        'x_studio_stage_date': datetime.datetime.now(),
                        'x_studio_repair_complete_stage_updated': True,
                    })
        return result
