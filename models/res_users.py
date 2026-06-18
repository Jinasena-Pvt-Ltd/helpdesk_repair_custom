from odoo import fields, models


class ResUsers(models.Model):
    _inherit = 'res.users'

    x_studio_source_location = fields.Many2one('stock.location', string='Source Location')
    x_studio_source_location_1 = fields.Many2one('stock.location', string='Source Location')
    x_studio_virtual_location = fields.Many2one('stock.location', string='Virtual Location')
    x_studio_virtual_location_1 = fields.Many2one('stock.location', string='Virtual Location')
    x_studio_company_id = fields.Many2one('res.company', string='Current Company')

    x_studio_stock_location_count = fields.Integer(
        string='Stock Locations', compute='_compute_x_studio_stock_location_count')
    x_studio_internal_location_count = fields.Integer(
        string='Internal Locations', compute='_compute_x_studio_internal_location_count')

    def _compute_x_studio_stock_location_count(self):
        for user in self:
            user.x_studio_stock_location_count = self.env['stock.location'].search_count(
                [('x_studio_users_stock_location', '=', user.id)])

    def _compute_x_studio_internal_location_count(self):
        for user in self:
            user.x_studio_internal_location_count = self.env['stock.location'].search_count(
                [('x_studio_users_internal_transfer', '=', user.id)])
