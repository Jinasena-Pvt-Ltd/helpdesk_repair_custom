from odoo import fields, models


class HelpdeskStage(models.Model):
    _inherit = 'helpdesk.stage'

    x_studio_company_id = fields.Many2one('res.company', string='Company')
