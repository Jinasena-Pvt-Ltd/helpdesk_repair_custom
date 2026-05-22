import datetime
from odoo import api, fields, models
from odoo.exceptions import UserError


class ProjectTask(models.Model):
    _inherit = 'project.task'

    x_studio_end_quick_repair = fields.Boolean(string='End Quick Repair')
    x_studio_fully_invoiced_so = fields.Boolean(string='Fully Invoiced SO',
        compute='_compute_x_studio_fully_invoiced_so', store=False)
    x_studio_valid_invoiced_so = fields.Boolean(string='Valid Invoiced SO')
    x_studio_valid_confirm_so = fields.Boolean(string='Valid Confirm SO')
    x_studio_valid_confirm2_so = fields.Boolean(string='Valid Confirm2 SO')
    x_studio_valid_delivered_so = fields.Boolean(string='Valid Delivered SO')
    x_studio_valid_delivered_so2 = fields.Boolean(string='Valid Delivered SO2')
    x_studio_material_availability = fields.Selection([
        ('Material Not Ready', 'Material Not Ready'),
        ('Material Ready', 'Material Ready'),
    ], string='Material Availability')
    x_studio_dispatch_done = fields.Boolean(string='Dispatch Done', store=True)

    @api.depends('sale_order_id', 'sale_order_id.invoice_status')
    def _compute_x_studio_fully_invoiced_so(self):
        for rec in self:
            rec.x_studio_fully_invoiced_so = bool(
                rec.sale_order_id and rec.sale_order_id.invoice_status == 'invoiced'
            )

    @api.depends(
        'fsm_done', 'is_fsm', 'timer_start',
        'display_enabled_conditions_count', 'display_satisfied_conditions_count',
        'sale_order_id', 'sale_order_id.invoice_status',
    )
    def _compute_mark_as_done_buttons(self):
        super()._compute_mark_as_done_buttons()
        for task in self:
            # Hide Mark as Done until the SO is 100% invoiced
            if task.sale_order_id and task.sale_order_id.invoice_status != 'invoiced':
                task.update({
                    'display_mark_as_done_primary': False,
                    'display_mark_as_done_secondary': False,
                })

    def action_dispatch(self):
        self.ensure_one()
        ticket = self.helpdesk_ticket_id
        if not ticket:
            raise UserError("No helpdesk ticket linked to this task.")
        if self.x_studio_dispatch_done:
            raise UserError("A dispatch transfer has already been created for this task.")

        virtual_loc_id = ticket.x_studio_virtual_location_id
        if not virtual_loc_id:
            raise UserError("No virtual repair location is set on the ticket.")

        customer_loc = self.env['stock.location'].search(
            [('usage', '=', 'customer')], limit=1)
        if not customer_loc:
            raise UserError("No customer location found in the system.")

        product = ticket.product_id
        if not product:
            raise UserError("No product is set on the ticket.")

        picking_type = self.env['stock.picking.type'].search(
            [('code', '=', 'outgoing')], limit=1)
        if not picking_type:
            raise UserError("No outgoing delivery type found.")

        move_vals = {
            'name': product.name,
            'product_id': product.id,
            'product_uom': product.uom_id.id,
            'product_uom_qty': 1.0,
            'location_id': virtual_loc_id,
            'location_dest_id': customer_loc.id,
        }
        picking = self.env['stock.picking'].create({
            'picking_type_id': picking_type.id,
            'location_id': virtual_loc_id,
            'location_dest_id': customer_loc.id,
            'x_studio_helpdesk_ticket_id': ticket.id,
            'x_studio_is_dispatch': True,
            'origin': ticket.name,
            'move_ids_without_package': [(0, 0, move_vals)],
        })

        # Pre-populate serial/lot on the move line if the product is tracked
        lot = ticket.lot_id
        if lot and product.tracking in ('serial', 'lot'):
            move = picking.move_ids_without_package[:1]
            self.env['stock.move.line'].create({
                'picking_id': picking.id,
                'move_id': move.id,
                'product_id': product.id,
                'product_uom_id': product.uom_id.id,
                'qty_done': 1.0,
                'lot_id': lot.id,
                'location_id': virtual_loc_id,
                'location_dest_id': customer_loc.id,
            })

        # Link to ticket's picking_ids so it shows in the ticket's transfer list
        ticket.picking_ids = [(4, picking.id)]

        # Mark dispatch as done to prevent duplicates
        self.x_studio_dispatch_done = True

        # Open the created dispatch transfer
        # Stage advances to "Handed Over to Customer" when this transfer is validated
        return {
            'type': 'ir.actions.act_window',
            'res_model': 'stock.picking',
            'res_id': picking.id,
            'view_mode': 'form',
            'target': 'current',
        }
