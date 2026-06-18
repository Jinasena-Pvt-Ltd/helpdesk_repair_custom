from odoo import fields, models


class RepairAccounts(models.Model):
    _name = 'x_repair_accounts'
    _description = 'Repair Accounts'
    _rec_name = 'x_name'
    _order = 'x_studio_sequence, x_name'
    _inherit = ['mail.thread', 'mail.activity.mixin']

    x_name = fields.Char(string='Name')
    x_active = fields.Boolean(string='Active', default=True)
    x_studio_sequence = fields.Integer(string='Sequence')
    x_studio_rug_account = fields.Many2one('account.account', string='RUG Account')
    x_studio_company_id = fields.Many2one(
        'res.company', string='Company',
        default=lambda self: self.env.company)
