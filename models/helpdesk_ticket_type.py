from odoo import fields, models


class HelpdeskTicketType(models.Model):
    _inherit = 'helpdesk.ticket.type'

    x_studio_rug = fields.Boolean(string='RUG')
    x_studio_rug_confirmed = fields.Boolean(string='RUG Confirmed')
    x_studio_with_serial_no = fields.Boolean(string='With Serial No')
    x_studio_without_serial_no = fields.Boolean(string='Without Serial No')
    x_studio_company_id = fields.Many2one('res.company', string='Company')
