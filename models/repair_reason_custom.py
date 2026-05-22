from odoo import fields, models


class RepairReasonCustom(models.Model):
    _name = 'x_repair_reason_custom'
    _description = 'Repair Reason'
    _rec_name = 'x_name'
    _order = 'x_studio_sequence, id'

    x_name = fields.Char(string='Name', required=True)
    x_active = fields.Boolean(string='Active', default=True)
    x_studio_sequence = fields.Integer(string='Sequence', default=10)
    x_color = fields.Integer(string='Color')
    x_studio_company_id = fields.Many2one('res.company', string='Company')
