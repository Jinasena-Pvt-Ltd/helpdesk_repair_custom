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

    x_studio_repair_image_01 = fields.Binary(string='Repair Image 01', attachment=True)
    x_studio_repair_image_02 = fields.Binary(string='Repair Image 02', attachment=True)
    x_studio_warranty_card = fields.Binary(string='Warranty Card', attachment=True)
    x_studio_related_information = fields.Binary(string='Related Information', attachment=True)
    x_studio_diagnosis_ids = fields.One2many(
        'x_task_diagnosis', 'x_studio_task_id', string='Diagnosis')
    x_studio_diagnosis_validated = fields.Boolean(
        string='Diagnosis Validated', copy=False, default=False)

    x_studio_so_fully_paid = fields.Boolean(
        string='SO Fully Paid', compute='_compute_x_studio_so_fully_paid', store=False)

    @api.depends('sale_order_id', 'sale_order_id.invoice_status')
    def _compute_x_studio_fully_invoiced_so(self):
        for rec in self:
            rec.x_studio_fully_invoiced_so = bool(
                rec.sale_order_id and rec.sale_order_id.invoice_status == 'invoiced'
            )

    @api.depends('sale_order_id', 'sale_order_id.invoice_ids.state', 'sale_order_id.invoice_ids.payment_state')
    def _compute_x_studio_so_fully_paid(self):
        for task in self:
            so = task.sale_order_id
            if not so:
                task.x_studio_so_fully_paid = False
                continue
            invoices = so.invoice_ids.filtered(
                lambda i: i.state == 'posted' and i.move_type == 'out_invoice')
            task.x_studio_so_fully_paid = bool(invoices) and all(
                i.payment_state == 'paid' for i in invoices)

    def action_validate_diagnosis(self):
        self.ensure_one()
        missing = []
        if not (self.x_studio_repair_image_01 or self.x_studio_repair_image_02):
            missing.append("- At least one Repair Image (slot 1 or slot 2)")
        if not self.x_studio_diagnosis_ids:
            missing.append("- At least one Repair Diagnosis line")
        if missing:
            raise UserError(
                "Please add the following before validating diagnosis:\n"
                + "\n".join(missing))
        self.x_studio_diagnosis_validated = True

    @api.depends(
        'fsm_done', 'is_fsm', 'timer_start',
        'display_enabled_conditions_count', 'display_satisfied_conditions_count',
        'sale_order_id', 'sale_order_id.picking_ids', 'sale_order_id.picking_ids.state',
    )
    def _compute_mark_as_done_buttons(self):
        super()._compute_mark_as_done_buttons()
        for task in self:
            if task.sale_order_id:
                so = task.sale_order_id
                outgoing = so.picking_ids.filtered(lambda p: p.picking_type_code == 'outgoing')
                if not outgoing or not all(p.state == 'done' for p in outgoing):
                    task.update({
                        'display_mark_as_done_primary': False,
                        'display_mark_as_done_secondary': False,
                    })

