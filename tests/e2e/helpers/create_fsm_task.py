import os, sys, json, odoo
from odoo.tools import config
os.environ['ODOO_RC'] = '/etc/odoo/odoo.conf'
config.parse_config(['-c', '/etc/odoo/odoo.conf'])

ticket_id = int(sys.argv[1])

with odoo.registry('odoo17').cursor() as cr:
    env = odoo.api.Environment(cr, odoo.SUPERUSER_ID, {})
    ticket = env['helpdesk.ticket'].browse(ticket_id)

    # Find FSM project (is_fsm=True)
    fsm_project = env['project.project'].search([('is_fsm', '=', True)], limit=1)
    if not fsm_project:
        print(json.dumps({'error': 'No FSM project found'}))
        sys.exit(1)

    # Create wizard and generate task (mirrors action_generate_and_view_task)
    wizard = env['helpdesk.create.fsm.task'].create({
        'helpdesk_ticket_id': ticket.id,
        'name': ticket.name,
        'project_id': fsm_project.id,
        'partner_id': ticket.partner_id.id,
    })
    task = wizard.action_generate_task()
    cr.commit()

    print(json.dumps({
        'taskId': task.id,
        'taskName': task.name,
        'projectId': task.project_id.id,
        'projectName': task.project_id.name,
        'partnerId': task.partner_id.id,
        'fsmTaskCount': ticket.fsm_task_count,
    }))
