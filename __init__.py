from . import models


# Canonical repair pipeline stages: (xml_id_suffix, name, sequence, fold)
STAGE_DATA = [
    ('stage_new',                      'New',                          0,  False),
    ('stage_sent_to_factory',          'Sent to Factory',              1,  False),
    ('stage_received_at_factory',      'Received at Factory',          2,  False),
    ('stage_diagnosis',                'Diagnosis',                    3,  False),
    ('stage_estimation_sent',          'Estimation Sent to Customer',  4,  False),
    ('stage_estimation_approved',      'Estimation Approval Received', 5,  False),
    ('stage_advance_received',         'Advance Received',             6,  False),
    ('stage_repair_started',           'Repair Started',               7,  False),
    ('stage_repair_completed',         'Repair Completed',             8,  False),
    ('stage_sent_to_sales_centre',     'Sent to Sales Centre',         9,  False),
    ('stage_received_at_sales_centre', 'Received at Sales Centre',     10, True),
    ('stage_handed_over',              'Handed Over to Customer',      11, True),
    ('stage_cancelled',                'Cancelled',                    12, True),
]


def _ensure_stages(env):
    """Register existing stages with module XML IDs, creating any that are missing."""
    IrModelData = env['ir.model.data']
    Stage = env['helpdesk.stage']
    MODULE = 'helpdesk_repair_custom'

    for suffix, name, sequence, fold in STAGE_DATA:
        # Skip if this module already owns an XML ID for this stage
        existing_imd = IrModelData.search([
            ('module', '=', MODULE), ('name', '=', suffix), ('model', '=', 'helpdesk.stage'),
        ], limit=1)
        if existing_imd:
            continue

        # Find an existing stage by name (prefer one without an owner module)
        stage = Stage.search([('name', '=', name)], limit=1)
        if not stage:
            stage = Stage.create({'name': name, 'sequence': sequence, 'fold': fold})

        IrModelData.create({
            'module': MODULE,
            'model': 'helpdesk.stage',
            'res_id': stage.id,
            'name': suffix,
            'noupdate': True,
        })


def post_init_hook(cr, registry):
    from odoo import api, SUPERUSER_ID
    env = api.Environment(cr, SUPERUSER_ID, {})

    _ensure_stages(env)

    # Enable product repairs on all helpdesk teams so product_id is visible on tickets
    env['helpdesk.team'].search([]).write({'use_product_repairs': True})

    # External IDs owned by our module — never touch these
    our_xmlids = {
        'helpdesk_repair_custom.automation_repair_seq',
        'helpdesk_repair_custom.automation_auto_product_from_serial',
        'helpdesk_repair_custom.automation_populate_repair_location',
        'helpdesk_repair_custom.automation_clear_on_serial_change',
        'helpdesk_repair_custom.automation_validate_cancelled_delete',
        'helpdesk_repair_custom.automation_stage_company',
    }
    our_ids = set()
    for xmlid in our_xmlids:
        rec = env.ref(xmlid, raise_if_not_found=False)
        if rec:
            our_ids.add(rec.id)

    # Names of rules that our module replaces
    superseded_names = {
        'RR - Repair Seq.No',
        'RR - Auto Select Product for RUG Repairs',
        'RR - Auto Select Product for RUG Repairs-33',
        'RR - Auto Populate Repair Location',
        'RR - Validate Cancelled Tickets',
        'JIN - Company Id in Helpdesk Stage',
    }
    old_rules = env['base.automation'].search([
        ('action_server_id.name', 'in', list(superseded_names)),
        ('id', 'not in', list(our_ids)),
    ])
    if old_rules:
        old_rules.write({'active': False})

    # Remove old hardcoded letter actions that our module replaces with portable versions.
    # These were Studio-created server actions (no module external ID) that use hardcoded
    # stage IDs and template IDs. The module's own versions (added above) are portable.
    superseded_letter_names = {
        'Send Repair Customer Letter',
        'Send Final Notice',
        'Send Final Notice - Estimated',
        'Send Final Notice - Scrappage',
        'Send Reminding Letter',
    }
    our_letter_xmlids = {
        'helpdesk_repair_custom.action_send_repair_customer_letter',
        'helpdesk_repair_custom.action_send_final_notice',
        'helpdesk_repair_custom.action_send_final_notice_estimated',
        'helpdesk_repair_custom.action_send_final_notice_scrappage',
        'helpdesk_repair_custom.action_send_reminding_letter',
    }
    our_letter_ids = set()
    for xmlid in our_letter_xmlids:
        rec = env.ref(xmlid, raise_if_not_found=False)
        if rec:
            our_letter_ids.add(rec.id)

    old_letters = env['ir.actions.server'].search([
        ('name', 'in', list(superseded_letter_names)),
        ('id', 'not in', list(our_letter_ids)),
        ('binding_model_id', '!=', False),
    ])
    if old_letters:
        old_letters.unlink()
