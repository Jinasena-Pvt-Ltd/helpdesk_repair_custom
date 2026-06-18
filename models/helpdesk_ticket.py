import datetime
from odoo import api, fields, models
from odoo.exceptions import UserError


class HelpdeskTicket(models.Model):
    _inherit = 'helpdesk.ticket'

    # ── Sequence-assigned name (default 'New' so required check passes; on_create automation replaces it) ──
    name = fields.Char(string='Subject', default='New', required=True, index=True)

    # ── Repair type flags (copied from ticket type) ─────────────────────────
    x_studio_rug_repair = fields.Boolean(string='Repair Under Warranty', store=True)
    x_studio_rug_confirmed = fields.Boolean(string='RUG Confirmed', store=True)
    x_studio_normal_repair_with_serial_no = fields.Boolean(
        string='Normal Repair (With Serial No)', store=True)
    x_studio_normal_repair_without_serial_no = fields.Boolean(
        string='Normal Repair (Without Serial No)', store=True)

    # ── Job routing ─────────────────────────────────────────────────────────
    x_studio_job_location = fields.Selection([
        ('Centre Repair', 'Centre Repair'),
        ('Factory Repair', 'Factory Repair'),
    ], string='Job Location')
    x_studio_repair_location = fields.Many2one('stock.location', string='Repair Location')
    x_studio_return_receipt_location = fields.Many2one(
        'stock.location', string='Return Receipt Location')

    # ── Serials & product ────────────────────────────────────────────────────
    x_studio_serial_no = fields.Many2one('stock.lot', string='Serial Number')
    x_studio_serial_number = fields.Many2one(
        'stock.lot', string='Serial Number-11')
    x_studio_sn_updated = fields.Boolean(string='SN Updated')
    x_studio_tracking = fields.Selection([
        ('serial', 'By Unique Serial Number'),
        ('lot', 'By Lots'),
        ('none', 'No Tracking'),
    ], string='Tracking', compute='_compute_x_studio_tracking', store=False)
    x_studio_repair_serial_created = fields.Boolean(string='Repair Serial Created')

    # ── Stock picking references ─────────────────────────────────────────────
    x_studio_pick_id = fields.Integer(string='Pick Id')
    x_studio_picking_id = fields.Many2one('stock.picking', string='Picking Id')
    x_studio_source_location = fields.Many2one('stock.location', string='Source Location')
    x_studio_source_location_1 = fields.Many2one('stock.location', string='Source Location')
    x_studio_virtual_location = fields.Many2one('stock.location', string='Virtual Location')
    x_studio_virtual_location_1 = fields.Many2one('stock.location', string='Virtual Location')
    x_studio_virtual_location_id = fields.Integer(string='Virtual Location Id',
                                                   compute='_compute_virtual_location_id',
                                                   store=True)

    # ── RUG approval ────────────────────────────────────────────────────────
    x_studio_rug_approved = fields.Boolean(string='RUG Approved')
    x_studio_rug_request_sent = fields.Boolean(string='RUG Request Sent')
    x_studio_rug_approval_status = fields.Selection([
        ('Pending RUG Approval', 'Pending RUG Approval'),
        ('RUG Approved', 'RUG Approved'),
        ('RUG Rejected', 'RUG Rejected'),
    ], string='RUG Approval Status', compute='_compute_x_studio_rug_approval_status',
        store=False)

    # ── Factory routing flags ────────────────────────────────────────────────
    x_studio_send_to_factory = fields.Boolean(string='Send to Factory')
    x_studio_receive_at_factory = fields.Boolean(string='Receive at Factory')
    x_studio_send_to_centre = fields.Boolean(string='Send to Centre')
    x_studio_receive_at_centre = fields.Boolean(string='Receive at Centre')

    # ── Factory transfer audit ───────────────────────────────────────────────
    x_studio_s_shipped_date = fields.Datetime(string='Shipped Date (Centre)')
    x_studio_s_shipped_by = fields.Many2one('res.users', string='Shipped By (Centre)')
    x_studio_s_received_date = fields.Datetime(string='Received Date (Centre)')
    x_studio_s_received_by = fields.Many2one('res.users', string='Received By (Centre)')
    x_studio_f_shipped_date = fields.Datetime(string='Shipped Date (Factory)')
    x_studio_f_shipped_by = fields.Many2one('res.users', string='Shipped By (Factory)')
    x_studio_f_received_date = fields.Datetime(string='Received Date (Factory)')
    x_studio_f_received_by = fields.Many2one('res.users', string='Received By (Factory)')

    # ── Stage tracking ───────────────────────────────────────────────────────
    x_studio_stage_date = fields.Datetime(string='Stage Date')
    x_studio_stage_name = fields.Char(related='stage_id.name', string='Stage Name', store=True)

    # ── Stage updated flags ──────────────────────────────────────────────────
    x_studio_invoice_stage_updated = fields.Boolean(string='Invoice Stage Updated')
    x_studio_repair_complete_stage_updated = fields.Boolean(
        string='Repair Complete Stage Updated')
    x_studio_estimation_sent_stage_updated = fields.Boolean(
        string='Estimation Sent Stage Updated')
    x_studio_estimation_approved_stage_updated = fields.Boolean(
        string='Estimation Approved Stage Updated')
    x_studio_repair_started_stage_updated = fields.Boolean(
        string='Repair Started Stage Updated')

    # ── Cancel / reopen ──────────────────────────────────────────────────────
    x_studio_cancelled = fields.Boolean(string='Cancelled')
    x_studio_cancelled_2 = fields.Boolean(string='Cancelled-2')
    x_studio_cancelled_by = fields.Many2one('res.users', string='Cancelled By')
    x_studio_cancelled_date = fields.Datetime(string='Cancelled Date')
    x_studio_cancelled_stage_id = fields.Many2one('helpdesk.stage', string='Cancelled Stage Id')
    x_studio_cancel_reason = fields.Text(string='Cancel Reason')
    x_studio_cancel_status = fields.Selection([
        ('None', 'None'),
        ('Cancelled', 'Cancelled'),
    ], string='Cancel Status')
    x_studio_reopened = fields.Boolean(string='Reopened')
    x_studio_reopened_by = fields.Many2one('res.users', string='Reopened By')
    x_studio_reopened_date = fields.Datetime(string='Reopened Date')
    x_studio_reopen_status = fields.Selection([
        ('None', 'None'),
        ('Reopened', 'Reopened'),
    ], string='Reopen Status')

    # ── Repair reason ────────────────────────────────────────────────────────
    x_studio_repair_reason = fields.Many2many(
        'x_repair_reason_custom', string='Repair Reason')

    # ── SO / financial ───────────────────────────────────────────────────────
    x_studio_sale_order = fields.Many2one(
        'sale.order', string='Sales Order',
        compute='_compute_x_studio_sale_order', search='_search_x_studio_sale_order',
        store=False)
    x_studio_balance_due = fields.Float(string='Balance Due')
    x_studio_items = fields.Many2many('product.product', string='Items')
    x_studio_qty = fields.Char(string='Qty')
    x_studio_sales_price = fields.Char(string='Sales Price')
    x_studio_unit_price = fields.Char(string='Unit Price',
                                      compute='_compute_x_studio_unit_price', store=False)
    x_studio_materials_used = fields.Many2one('product.product', string='Materials Used')
    x_studio_quantity = fields.Float(string='Quantity', store=True)

    # ── Computed stage / status ──────────────────────────────────────────────
    x_studio_valid_return = fields.Boolean(
        string='Valid Return', compute='_compute_x_studio_valid_return', store=False)
    x_studio_valid_confirm_return = fields.Boolean(
        string='Valid Confirm Return',
        compute='_compute_x_studio_valid_confirm_return', store=False)
    x_studio_task_status = fields.Boolean(
        string='Task Status', compute='_compute_x_studio_task_status', store=False)
    x_studio_fsm_task_done = fields.Boolean(
        string='FSM Task Done', compute='_compute_x_studio_fsm_task_done', store=False)
    x_studio_fully_paid_so = fields.Boolean(
        string='Fully Paid SO', compute='_compute_x_studio_fully_paid_so', store=False)
    x_studio_handed_over = fields.Boolean(
        string='Handed Over', compute='_compute_x_studio_handed_over', store=False)
    x_studio_material_availability = fields.Selection([
        ('Material Not Ready', 'Material Not Ready'),
        ('Material Ready', 'Material Ready'),
    ], string='Material Availability',
        compute='_compute_x_studio_material_availability', store=False)
    x_studio_valid_invoiced_so = fields.Boolean(
        string='Valid Invoiced SO',
        compute='_compute_x_studio_valid_invoiced_so', store=False)
    x_studio_valid_confirmed_so = fields.Boolean(
        string='Valid Confirmed SO',
        compute='_compute_x_studio_valid_confirmed_so', store=False)
    x_studio_valid_confirmed2_so = fields.Boolean(
        string='Valid Confirmed2 SO',
        compute='_compute_x_studio_valid_confirmed2_so', store=False)
    x_studio_valid_delivered_so = fields.Boolean(
        string='Valid Delivered SO',
        compute='_compute_x_studio_valid_delivered_so', store=False)
    x_studio_re_estimate_count = fields.Integer(
        string='Re-estimate Count',
        compute='_compute_x_studio_re_estimate_count', store=False)
    x_studio_re_estimate_status = fields.Selection([
        ('None', 'None'),
        ('Re-estimated', 'Re-estimated'),
    ], string='Re-estimate Status',
        compute='_compute_x_studio_re_estimate_status', store=False)

    # ── User location validation ─────────────────────────────────────────────
    x_studio_user_location_validation = fields.Boolean(
        string='User Location Validation',
        compute='_compute_x_studio_user_location_validation', store=False)

    # ── Cancel stage gate (name-based, portable across installs) ─────────────
    x_studio_cancel_stage_ok = fields.Boolean(
        string='Cancel Stage OK',
        compute='_compute_x_studio_cancel_stage_ok', store=False)
    x_studio_cancel2_stage_ok = fields.Boolean(
        string='Cancel2 Stage OK',
        compute='_compute_x_studio_cancel2_stage_ok', store=False)

    # ── Misc ─────────────────────────────────────────────────────────────────
    x_studio_warranty_card = fields.Binary(string='Warranty Card')
    x_studio_related_information = fields.Binary(string='Related Information')
    x_studio_driver_name = fields.Char(string='Driver Name')
    x_studio_vehicle_details = fields.Char(string='Vehicle Details')
    x_studio_sales_price_field = fields.Char(string='Sales Price')
    x_studio_quick_repair_status = fields.Selection([
        ('None', 'None'),
        ('Quick Repair', 'Tested OK'),
    ], string='Tested OK', store=True)

    # ── Status log (stage transition audit) ──────────────────────────────────
    x_studio_created_by_1 = fields.Many2one('res.users', string='Created By 1')
    x_studio_created_on_1 = fields.Datetime(string='Created On 1')
    x_studio_created_by_2 = fields.Many2one('res.users', string='Created By 2')
    x_studio_created_on_2 = fields.Datetime(string='Created On 2')
    x_studio_created_by_3 = fields.Many2one('res.users', string='Created By 3')
    x_studio_created_on_3 = fields.Datetime(string='Created On 3')
    x_studio_created_by_4 = fields.Many2one('res.users', string='Created By 4')
    x_studio_created_on_4 = fields.Datetime(string='Created On 4')
    x_studio_created_by_5 = fields.Many2one('res.users', string='Created By 5')
    x_studio_created_on_5 = fields.Datetime(string='Created On 5')
    x_studio_created_by_6 = fields.Many2one('res.users', string='Created By 6')
    x_studio_created_on_6 = fields.Datetime(string='Created On 6')
    x_studio_created_by_7 = fields.Many2one('res.users', string='Created By 7')
    x_studio_created_on_7 = fields.Datetime(string='Created On 7')
    x_studio_created_by_8 = fields.Many2one('res.users', string='Created By 8')
    x_studio_created_on_8 = fields.Datetime(string='Created On 8')
    x_studio_created_by_9 = fields.Many2one('res.users', string='Created By 9')
    x_studio_created_on_9 = fields.Datetime(string='Created On 9')
    x_studio_created_by_10 = fields.Many2one('res.users', string='Created By 10')
    x_studio_created_on_10 = fields.Datetime(string='Created On 10')

    # ── Stat button: repair transfers ────────────────────────────────────────
    x_x_studio_created_from_help_ticket_stock_picking_count = fields.Integer(
        string='Repair Trans.',
        compute='_compute_repair_trans_count')

    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    # Helper
    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    def _get_stage_by_name(self, name):
        """Return the stage id for the given name that belongs to this ticket's team."""
        stage = self.env['helpdesk.stage'].search(
            [('name', '=', name), ('team_ids', 'in', self.team_id.id)], limit=1)
        if not stage:
            stage = self.env['helpdesk.stage'].search([('name', '=', name)], limit=1)
        return stage.id if stage else False

    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    # Computes
    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    def _compute_repair_trans_count(self):
        for record in self:
            record.x_x_studio_created_from_help_ticket_stock_picking_count = (
                self.env['stock.picking'].search_count(
                    [('x_studio_created_from_help_ticket', '=', record.id)])
            )

    @api.depends('product_id')
    def _compute_x_studio_tracking(self):
        for rec in self:
            rec.x_studio_tracking = rec.product_id.tracking if rec.product_id else False

    @api.depends('x_studio_virtual_location')
    def _compute_virtual_location_id(self):
        for rec in self:
            rec.x_studio_virtual_location_id = rec.x_studio_virtual_location.id or 0

    def _compute_x_studio_rug_approval_status(self):
        for rec in self:
            val = 'Pending RUG Approval'
            for invoices in rec.fsm_task_ids:
                so = self.env['sale.order'].search(
                    [('task_id', '=', invoices.id)], limit=1)
                if so:
                    if so.x_studio_rug_approved:
                        val = 'RUG Approved'
                    elif so.x_studio_rug_rejected:
                        val = 'RUG Rejected'
            rec.x_studio_rug_approval_status = val

    def _compute_x_studio_valid_return(self):
        for rec in self:
            valid = False
            for line in rec.picking_ids:
                # Only count return receipts (incoming from customer), not the original outgoing delivery
                if line.state != 'cancel' and line.location_id.usage == 'customer':
                    valid = True
            rec.x_studio_valid_return = valid

    def _compute_x_studio_valid_confirm_return(self):
        for rec in self:
            valid = False
            for line in rec.picking_ids:
                # Only count return receipts (incoming from customer), not the original outgoing delivery
                if line.state == 'done' and line.location_id.usage == 'customer':
                    valid = True
            rec.x_studio_valid_confirm_return = valid

    def _compute_x_studio_fsm_task_done(self):
        for rec in self:
            task_status = False
            for line in rec.fsm_task_ids:
                if line.fsm_done:
                    task_status = True
            rec.x_studio_fsm_task_done = task_status

    def _compute_x_studio_fully_paid_so(self):
        for rec in self:
            valid = False
            for invoices in rec.fsm_task_ids:
                if invoices.x_studio_fully_invoiced_so or invoices.x_studio_end_quick_repair:
                    valid = True
            rec.x_studio_fully_paid_so = valid

    def _compute_x_studio_material_availability(self):
        for rec in self:
            val = 'Material Not Ready'
            for invoices in rec.fsm_task_ids:
                val = invoices.x_studio_material_availability
            rec.x_studio_material_availability = val

    def _compute_x_studio_sale_order(self):
        for rec in self:
            so = False
            for invoices in rec.fsm_task_ids:
                if invoices.sale_order_id:
                    so = invoices.sale_order_id.id
            rec.x_studio_sale_order = so

    def _search_x_studio_sale_order(self, operator, value):
        tasks = self.env['project.task'].search([('sale_order_id', operator, value)])
        return [('fsm_task_ids', 'in', tasks.ids)]

    def _compute_x_studio_unit_price(self):
        for rec in self:
            rec.x_studio_unit_price = False

    def _compute_x_studio_re_estimate_count(self):
        for rec in self:
            val = 0
            for invoices in rec.fsm_task_ids:
                val = invoices.sale_order_id.x_studio_re_estimate_count
            rec.x_studio_re_estimate_count = val

    def _compute_x_studio_re_estimate_status(self):
        for rec in self:
            val = 'None'
            for invoices in rec.fsm_task_ids:
                if invoices.sale_order_id.x_studio_re_estimate_count > 0:
                    val = 'Re-estimated'
            rec.x_studio_re_estimate_status = val

    def _compute_x_studio_user_location_validation(self):
        for rec in self:
            valid = False
            if rec.x_studio_return_receipt_location:
                loc = self.env['stock.location'].search([
                    ('id', '=', rec.x_studio_return_receipt_location.id),
                    ('x_studio_users_stock_location', '=', self._uid),
                    ('active', '=', True),
                ], limit=1)
                valid = not bool(loc)
            rec.x_studio_user_location_validation = valid

    _CANCEL_STAGE_NAMES = frozenset({'New', 'Diagnosis', 'Sent to Factory', 'Received at Factory'})
    _CANCEL2_STAGE_NAMES = frozenset({'Estimation Sent to Customer'})

    def _compute_x_studio_cancel_stage_ok(self):
        for rec in self:
            rec.x_studio_cancel_stage_ok = rec.stage_id.name in self._CANCEL_STAGE_NAMES

    def _compute_x_studio_cancel2_stage_ok(self):
        for rec in self:
            rec.x_studio_cancel2_stage_ok = rec.stage_id.name in self._CANCEL2_STAGE_NAMES

    def _compute_x_studio_task_status(self):
        for rec in self:
            task_status = False
            for line in rec.fsm_task_ids:
                if line.fsm_done:
                    task_status = True
            if not task_status and rec.x_studio_sale_order:
                so = rec.x_studio_sale_order
                if so.state == 'cancel':
                    task_status = True
                else:
                    delivery1 = self.env['stock.picking'].search(
                        [('sale_id', '=', so.id)], limit=1)
                    if delivery1:
                        delivery = self.env['stock.picking'].search(
                            [('sale_id', '=', so.id),
                             ('state', 'not in', ['done', 'cancel'])], limit=1)
                        task_status = not bool(delivery)
            if task_status and not rec.x_studio_repair_complete_stage_updated:
                stage_id = rec._get_stage_by_name('Repair Completed')
                if stage_id:
                    rec['stage_id'] = stage_id
                    rec['x_studio_stage_date'] = datetime.datetime.now()
                    rec['x_studio_created_by_8'] = self._uid
                    rec['x_studio_created_on_8'] = datetime.datetime.now()
                    rec['x_studio_repair_complete_stage_updated'] = True
                    so = rec.x_studio_sale_order
                    if so:
                        so_items = self.env['sale.order.line'].search(
                            [('order_id', '=', so.id)])
                        if so_items:
                            tot_item_ids, qty, prices = [], [], []
                            for items in so_items:
                                if items.product_uom_qty > 0:
                                    tot_item_ids.append(items.product_id.id)
                                    qty.append(items.product_uom_qty)
                                    prices.append(items.price_unit)
                            rec['x_studio_items'] = [(6, 0, tot_item_ids)]
                            rec['x_studio_qty'] = str(qty)
                            rec['x_studio_sales_price'] = str(prices)
            rec.x_studio_task_status = task_status

    def _compute_x_studio_valid_invoiced_so(self):
        for rec in self:
            valid = False
            for invoices in rec.fsm_task_ids:
                if invoices.sale_order_id.x_studio_order_payment_method == 'Credit':
                    valid = False
                elif invoices.x_studio_valid_invoiced_so:
                    valid = True
            if valid and not rec.x_studio_repair_complete_stage_updated:
                if not rec.x_studio_invoice_stage_updated:
                    stage_id = rec._get_stage_by_name('Advance Received')
                    if stage_id:
                        rec['stage_id'] = stage_id
                        rec['x_studio_stage_date'] = datetime.datetime.now()
                        rec['x_studio_created_by_6'] = self._uid
                        rec['x_studio_created_on_6'] = datetime.datetime.now()
                        rec['x_studio_invoice_stage_updated'] = True
            rec.x_studio_valid_invoiced_so = valid

    def _compute_x_studio_valid_confirmed_so(self):
        for rec in self:
            valid = False
            for invoices in rec.fsm_task_ids:
                if invoices.x_studio_valid_confirm_so:
                    valid = True
            if valid and not rec.x_studio_estimation_sent_stage_updated:
                rec['x_studio_estimation_sent_stage_updated'] = True
                stage_id = rec._get_stage_by_name('Estimation Sent to Customer')
                if stage_id:
                    rec['stage_id'] = stage_id
                    rec['x_studio_stage_date'] = datetime.datetime.now()
                    rec['x_studio_created_by_4'] = self._uid
                    rec['x_studio_created_on_4'] = datetime.datetime.now()
            rec.x_studio_valid_confirmed_so = valid

    def _compute_x_studio_valid_confirmed2_so(self):
        for rec in self:
            valid = False
            for invoices in rec.fsm_task_ids:
                if invoices.x_studio_valid_confirm2_so:
                    valid = True
            if valid and not rec.x_studio_estimation_approved_stage_updated:
                rec['x_studio_estimation_approved_stage_updated'] = True
                stage_id = rec._get_stage_by_name('Estimation Approval Received')
                if stage_id:
                    rec['stage_id'] = stage_id
                    rec['x_studio_stage_date'] = datetime.datetime.now()
                    rec['x_studio_created_by_5'] = self._uid
                    rec['x_studio_created_on_5'] = datetime.datetime.now()
            rec.x_studio_valid_confirmed2_so = valid

    def _compute_x_studio_valid_delivered_so(self):
        for rec in self:
            valid = False
            valid2 = False
            for invoices in rec.fsm_task_ids:
                if invoices.x_studio_valid_delivered_so:
                    valid = True
                if invoices.x_studio_valid_delivered_so2:
                    valid2 = True
            if valid2 and not rec.x_studio_repair_complete_stage_updated:
                stage_id = rec._get_stage_by_name('Repair Completed')
                if stage_id:
                    rec['stage_id'] = stage_id
                    rec['x_studio_stage_date'] = datetime.datetime.now()
                    rec['x_studio_created_by_8'] = self._uid
                    rec['x_studio_created_on_8'] = datetime.datetime.now()
                    rec['x_studio_repair_complete_stage_updated'] = True
                    so = rec.x_studio_sale_order
                    if so:
                        so_items = self.env['sale.order.line'].search(
                            [('order_id', '=', so.id)])
                        if so_items:
                            tot_item_ids, qty, prices = [], [], []
                            for items in so_items:
                                if items.product_uom_qty > 0:
                                    tot_item_ids.append(items.product_id.id)
                                    qty.append(items.product_uom_qty)
                                    prices.append(items.price_unit)
                            rec['x_studio_items'] = [(6, 0, tot_item_ids)]
                            rec['x_studio_qty'] = str(qty)
                            rec['x_studio_sales_price'] = str(prices)
            elif valid and not rec.x_studio_repair_started_stage_updated:
                stage_id = rec._get_stage_by_name('Repair Started')
                if stage_id:
                    rec['stage_id'] = stage_id
                    rec['x_studio_stage_date'] = datetime.datetime.now()
                    rec['x_studio_created_by_7'] = self._uid
                    rec['x_studio_created_on_7'] = datetime.datetime.now()
                    rec['x_studio_repair_started_stage_updated'] = True
            rec.x_studio_valid_delivered_so = valid

    def _compute_x_studio_handed_over(self):
        for rec in self:
            c = sum(1 for line in rec.picking_ids if line.state == 'done')
            rec.x_studio_handed_over = c > 1

    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    # Serial number auto-population
    # ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    @api.onchange('user_id')
    def _onchange_user_id_locations(self):
        """Copy virtual/source locations from the assigned user to the ticket."""
        for rec in self:
            u = rec.user_id
            if u:
                rec.x_studio_virtual_location = u.x_studio_virtual_location
                rec.x_studio_source_location = u.x_studio_source_location
                rec.x_studio_virtual_location_1 = u.x_studio_virtual_location_1
                rec.x_studio_source_location_1 = u.x_studio_source_location_1

    def _sync_user_locations(self):
        """Write virtual/source locations from the current user_id onto the ticket."""
        u = self.user_id
        super(HelpdeskTicket, self).write({
            'x_studio_virtual_location': u.x_studio_virtual_location.id if u else False,
            'x_studio_source_location': u.x_studio_source_location.id if u else False,
            'x_studio_virtual_location_1': u.x_studio_virtual_location_1.id if u else False,
            'x_studio_source_location_1': u.x_studio_source_location_1.id if u else False,
        })

    @api.onchange('ticket_type_id')
    def _onchange_ticket_type_id(self):
        """Copy repair-type flags from the selected ticket type; clear prior serial/product selection."""
        for rec in self:
            tt = rec.ticket_type_id
            rec.x_studio_rug_repair = tt.x_studio_rug if tt else False
            rec.x_studio_rug_confirmed = tt.x_studio_rug_confirmed if tt else False
            rec.x_studio_normal_repair_with_serial_no = tt.x_studio_with_serial_no if tt else False
            rec.x_studio_normal_repair_without_serial_no = tt.x_studio_without_serial_no if tt else False
            rec.sale_order_id = False
            rec.x_studio_picking_id = False
            rec.x_studio_pick_id = 0
            rec.lot_id = False
            rec.x_studio_serial_no = False
            # For "Without Serial No" type, product is set manually — don't clear it
            if not (tt and tt.x_studio_without_serial_no):
                rec.product_id = False

    def _sync_ticket_type_flags(self, skip_clear=False):
        """Write repair-type flags from the current ticket_type_id; clear prior serial/product selection.

        skip_clear=True when serial is being set in the same write() call — avoids wiping
        a serial that was explicitly saved at the same time as the ticket type.
        """
        tt = self.ticket_type_id
        updates = {
            'x_studio_rug_repair': tt.x_studio_rug if tt else False,
            'x_studio_rug_confirmed': tt.x_studio_rug_confirmed if tt else False,
            'x_studio_normal_repair_with_serial_no': tt.x_studio_with_serial_no if tt else False,
            'x_studio_normal_repair_without_serial_no': tt.x_studio_without_serial_no if tt else False,
        }
        if not skip_clear:
            updates.update({
                'sale_order_id': False,
                'x_studio_picking_id': False,
                'x_studio_pick_id': 0,
                'lot_id': False,
                'x_studio_serial_no': False,
            })
            if not (tt and tt.x_studio_without_serial_no):
                updates['product_id'] = False
        super(HelpdeskTicket, self).write(updates)

    @api.onchange('x_studio_serial_no')
    def _onchange_serial_no(self):
        """Immediately set product/lot from serial for UI feedback before save."""
        for rec in self:
            if rec.x_studio_serial_no:
                sn = rec.x_studio_serial_no
                rec.product_id = sn.product_id
                rec.lot_id = sn
                cust_location = self.env['stock.location'].search(
                    [('usage', '=', 'customer')], limit=1)
                trans_line = self.env['stock.move.line'].search([
                    ('product_id', '=', sn.product_id.id),
                    ('lot_id', '=', sn.id),
                    ('picking_code', '=', 'outgoing'),
                    ('location_dest_id', '=', cust_location.id),
                ], limit=1)
                if trans_line:
                    company_id = self.env.context.get(
                        'allowed_company_ids', [self.env.user.company_id.id])[0]
                    so = self.env['sale.order'].search([
                        ('name', '=', trans_line.origin),
                        ('company_id', '=', company_id),
                    ], limit=1)
                    if so:
                        rec.sale_order_id = so
                        rec.x_studio_picking_id = trans_line.picking_id
                        rec.x_studio_pick_id = trans_line.picking_id.id
                if rec.x_studio_normal_repair_without_serial_no:
                    rec.sale_order_id = False
            else:
                if rec.x_studio_normal_repair_without_serial_no:
                    rec.sale_order_id = False
                    rec.x_studio_picking_id = False
                    rec.x_studio_pick_id = 0
                    rec.lot_id = False
                else:
                    rec.sale_order_id = False
                    rec.x_studio_picking_id = False
                    rec.x_studio_pick_id = 0
                    rec.product_id = False
                    rec.lot_id = False

    def _sync_serial_fields(self):
        """Mirror the Update Serial server action: populate product/lot/SO and set sn_updated."""
        updates = {}
        sn = self.x_studio_serial_no
        if sn:
            company_id = self.env.context.get(
                'allowed_company_ids', [self.env.user.company_id.id])[0]
            cust_location = self.env['stock.location'].search(
                [('usage', '=', 'customer')], limit=1)
            trans_line = self.env['stock.move.line'].search([
                ('product_id', '=', sn.product_id.id),
                ('lot_id', '=', sn.id),
                ('picking_code', '=', 'outgoing'),
                ('location_dest_id', '=', cust_location.id),
            ], limit=1)
            if trans_line:
                so = self.env['sale.order'].search([
                    ('name', '=', trans_line.origin),
                    ('company_id', '=', company_id),
                ], limit=1)
                if so:
                    updates['sale_order_id'] = so.id
                    updates['x_studio_picking_id'] = trans_line.picking_id.id
                    updates['x_studio_pick_id'] = trans_line.picking_id.id
            updates['product_id'] = sn.product_id.id
            updates['lot_id'] = sn.id
            if self.x_studio_normal_repair_without_serial_no:
                updates['sale_order_id'] = False
        else:
            if self.x_studio_normal_repair_without_serial_no:
                updates = {
                    'sale_order_id': False,
                    'x_studio_picking_id': False,
                    'x_studio_pick_id': 0,
                    'lot_id': False,
                }
            else:
                updates = {
                    'sale_order_id': False,
                    'x_studio_picking_id': False,
                    'x_studio_pick_id': 0,
                    'product_id': False,
                    'lot_id': False,
                }
        updates['x_studio_sn_updated'] = True
        # Call super to avoid re-entering our write override (x_studio_serial_no not in updates)
        super(HelpdeskTicket, self).write(updates)

    def write(self, vals):
        result = super().write(vals)
        if 'x_studio_serial_no' in vals:
            for rec in self:
                rec._sync_serial_fields()
        if 'ticket_type_id' in vals:
            serial_also_set = bool(vals.get('x_studio_serial_no'))
            for rec in self:
                rec._sync_ticket_type_flags(skip_clear=serial_also_set)
        if 'user_id' in vals:
            for rec in self:
                rec._sync_user_locations()
        return result

    def assign_ticket_to_self(self):
        self.ensure_one()
        self.user_id = self.env.user
        # Return a form reload action to avoid an OWL setLocalState crash.
        # When user_id changes: the button becomes invisible and two fields flip
        # to required simultaneously.  OWL tries to restore state on the now-
        # destroyed button DOM node, hitting `undefined.classList`.  Reopening
        # the form record forces a clean remount instead of an in-place patch.
        return {
            'type': 'ir.actions.act_window',
            'res_model': 'helpdesk.ticket',
            'res_id': self.id,
            'view_mode': 'form',
            'views': [(False, 'form')],
            'target': 'current',
        }
