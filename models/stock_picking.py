import datetime
from odoo import api, fields, models
from odoo.exceptions import UserError


class StockPicking(models.Model):
    _inherit = 'stock.picking'

    x_studio_created_from_help_ticket = fields.Many2one(
        'helpdesk.ticket', string='Created from Help Ticket',
        ondelete='set null', copy=False)
    x_studio_helpdesk_ticket_id = fields.Many2one(
        'helpdesk.ticket', string='Helpdesk Ticket Id', ondelete='set null')
    x_studio_factory_repair = fields.Boolean(string='Factory Repair')
    x_studio_rug_repair = fields.Boolean(
        related='x_studio_helpdesk_ticket_id.x_studio_rug_repair',
        string='RUG Repair', store=False)

    # ── Validate gate fields (used by button_validate visibility attrs) ──────
    x_studio_need_approval = fields.Boolean(string='Need Approval')
    x_studio_task_status = fields.Boolean(string='Task Status')
    x_studio_sales_order = fields.Many2one('sale.order', string='Sales Order', ondelete='set null')
    x_studio_cancelled = fields.Boolean(string='Cancelled')
    x_studio_transfer_rejected = fields.Boolean(string='Transfer Rejected')
    x_studio_quotation_type_2 = fields.Selection([
        ('Sales', 'Sales'),
        ('Project', 'Project'),
        ('Repair', 'Repair'),
    ], string='Quotation Type')
    x_studio_pr_type = fields.Selection([
        ('Local', 'Local'),
        ('Import', 'Import'),
    ], string='PR Type')
    x_studio_update_consignment = fields.Boolean(string='Update Consignment')
    x_studio_budget_created = fields.Boolean(string='Budget Created')
    x_studio_is_dispatch = fields.Boolean(string='Is Dispatch')

    # ── Dispatch button gate fields (computed, for picking form visibility) ─
    x_studio_location_is_customer = fields.Boolean(
        compute='_compute_x_studio_location_is_customer', store=False)
    x_studio_so_fully_paid = fields.Boolean(
        compute='_compute_x_studio_picking_dispatch_gate', store=False,
        string='SO Fully Paid')
    x_studio_dispatch_done = fields.Boolean(
        compute='_compute_x_studio_picking_dispatch_gate', store=False,
        string='Dispatch Done')

    @api.depends('location_id', 'location_id.usage')
    def _compute_x_studio_location_is_customer(self):
        for p in self:
            p.x_studio_location_is_customer = (p.location_id.usage == 'customer')

    @api.depends(
        'x_studio_helpdesk_ticket_id',
        'x_studio_helpdesk_ticket_id.fsm_task_ids',
        'x_studio_helpdesk_ticket_id.fsm_task_ids.x_studio_so_fully_paid',
        'x_studio_helpdesk_ticket_id.fsm_task_ids.x_studio_dispatch_done',
    )
    def _compute_x_studio_picking_dispatch_gate(self):
        for picking in self:
            ticket = picking.x_studio_helpdesk_ticket_id
            tasks = ticket.fsm_task_ids if ticket else self.env['project.task']
            picking.x_studio_so_fully_paid = any(t.x_studio_so_fully_paid for t in tasks)
            picking.x_studio_dispatch_done = any(t.x_studio_dispatch_done for t in tasks)

    x_studio_valid_transfer_lines = fields.Boolean(
        string='Valid Transfer Lines',
        compute='_compute_x_studio_valid_transfer_lines', store=False)
    x_studio_repair_payment_made = fields.Boolean(
        string='Repair Payment Made',
        compute='_compute_x_studio_repair_payment_made', store=False)

    def _compute_x_studio_valid_transfer_lines(self):
        for rec in self:
            valid_lines = False
            for _line in rec.move_line_ids_without_package:
                valid_lines = True
            for _line in rec.move_ids_without_package:
                valid_lines = True
            rec.x_studio_valid_transfer_lines = valid_lines

    def _compute_x_studio_repair_payment_made(self):
        for rec in self:
            valid = False
            if rec.sale_id:
                if rec.sale_id.x_studio_order_payment_method == 'Credit':
                    valid = True
                elif rec.sale_id.x_studio_rug_approved:
                    valid = True
                else:
                    payment = self.env['account.payment'].search([
                        ('x_studio_sales_order', '=', rec.sale_id.id),
                        ('state', '=', 'posted'),
                    ])
                    if payment:
                        valid = True
                    else:
                        for inv in rec.sale_id.invoice_ids:
                            if inv.payment_state in ('in_payment', 'partial', 'paid'):
                                valid = True
            rec.x_studio_repair_payment_made = valid

    def button_validate(self):
        pending = self.filtered(lambda p: p.state not in ('done', 'cancel'))

        # 50% down payment gate for repair deliveries (non-RUG only)
        for picking in pending:
            if not picking.sale_id:
                continue
            so = picking.sale_id
            tasks = self.env['project.task'].search([('sale_order_id', '=', so.id)])
            ticket = next(
                (t.helpdesk_ticket_id for t in tasks if t.helpdesk_ticket_id), None)
            if not ticket or ticket.x_studio_rug_repair:
                continue
            invoices = so.invoice_ids.filtered(
                lambda i: i.state == 'posted' and i.move_type == 'out_invoice')
            total_paid = sum(i.amount_total - i.amount_residual for i in invoices)
            required = so.amount_total * 0.5
            if total_paid < required:
                raise UserError(
                    "Cannot validate delivery: at least 50%% down payment is required.\n"
                    "Paid: %.2f  |  Required: %.2f" % (total_paid, required)
                )
        result = super().button_validate()
        for picking in pending:
            if picking.state != 'done' or not picking.sale_id:
                continue
            so = picking.sale_id
            tasks = self.env['project.task'].search([('sale_order_id', '=', so.id)])
            for task in tasks:
                ticket = task.helpdesk_ticket_id
                if not ticket:
                    continue
                # Any done outgoing delivery on this SO → Repair Started
                if not ticket.x_studio_repair_started_stage_updated:
                    done_out = self.env['stock.picking'].search([
                        ('sale_id', '=', so.id),
                        ('state', '=', 'done'),
                        ('picking_type_code', '=', 'outgoing'),
                    ], limit=1)
                    if done_out:
                        stage_id = ticket._get_stage_by_name('Repair Started')
                        if stage_id:
                            ticket.write({
                                'stage_id': stage_id,
                                'x_studio_stage_date': datetime.datetime.now(),
                                'x_studio_repair_started_stage_updated': True,
                            })
                            task.x_studio_valid_delivered_so = True
                # ALL outgoing deliveries on this SO done → Repair Completed
                if not ticket.x_studio_repair_complete_stage_updated:
                    outgoing = so.picking_ids.filtered(
                        lambda p: p.picking_type_code == 'outgoing')
                    if outgoing and all(p.state == 'done' for p in outgoing):
                        stage_id = ticket._get_stage_by_name('Repair Completed')
                        if stage_id:
                            ticket.write({
                                'stage_id': stage_id,
                                'x_studio_stage_date': datetime.datetime.now(),
                                'x_studio_repair_complete_stage_updated': True,
                            })
                            task.x_studio_valid_delivered_so2 = True

        # Dispatch transfer validated → Handed Over to Customer
        for picking in pending:
            if picking.state != 'done' or not picking.x_studio_is_dispatch:
                continue
            ticket = picking.x_studio_helpdesk_ticket_id
            if not ticket:
                continue
            stage_id = ticket._get_stage_by_name('Handed Over to Customer')
            if stage_id:
                ticket.write({
                    'stage_id': stage_id,
                    'x_studio_stage_date': datetime.datetime.now(),
                })
        return result

    def action_dispatch_return(self):
        """Open the return wizard preloaded for this picking (the first customer return).
        The wizard creates the second return (virtual → customer). On create_returns()
        the new picking is flagged x_studio_is_dispatch=True so that validating it
        advances the ticket to 'Handed Over to Customer'."""
        self.ensure_one()
        ticket = self.x_studio_helpdesk_ticket_id
        if not ticket:
            raise UserError("This picking is not linked to a helpdesk ticket.")
        return {
            'name': 'Return Transfer',
            'type': 'ir.actions.act_window',
            'res_model': 'stock.return.picking',
            'view_mode': 'form',
            'target': 'new',
            'context': {
                'active_id': self.id,
                'active_ids': [self.id],
                'active_model': 'stock.picking',
                'default_picking_id': self.id,
                'default_ticket_id': ticket.id,
                'default_x_studio_is_dispatch': True,
            },
        }
