import datetime
from odoo import models


class CreateFsmTask(models.TransientModel):
    _inherit = 'helpdesk.create.fsm.task'

    def action_generate_task(self):
        task = super().action_generate_task()
        ticket = self.helpdesk_ticket_id
        stage_id = ticket._get_stage_by_name('Diagnosis')
        if stage_id:
            ticket.write({
                'stage_id': stage_id,
                'x_studio_stage_date': datetime.datetime.now(),
            })
        return task
