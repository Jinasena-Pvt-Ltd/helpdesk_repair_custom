from odoo import fields, models


class RepairReason(models.Model):
    _name = 'x_repair_reason'
    _description = 'Repair Reason'
    _rec_name = 'x_name'
    _order = 'x_studio_sequence, x_name'
    _active_name = 'x_active'

    x_name = fields.Char(string='Repair Reason', required=True)
    x_color = fields.Integer(string='Color')
    x_studio_sequence = fields.Integer(string='Sequence')
    x_active = fields.Boolean(string='Active', default=True)
    x_studio_company_id = fields.Many2one('res.company', string='Company')


class Conditions(models.Model):
    _name = 'x_conditions'
    _description = 'Conditions'
    _rec_name = 'x_name'
    _order = 'x_studio_sequence, x_name'
    _active_name = 'x_active'

    x_name = fields.Char(string='Condition', required=True)
    x_studio_description = fields.Char(string='Description')
    x_studio_sequence = fields.Integer(string='Sequence')
    x_active = fields.Boolean(string='Active', default=True)
    x_studio_company_id = fields.Many2one('res.company', string='Company')


class DiagnosisAreas(models.Model):
    _name = 'x_diagnosis_areas'
    _description = 'Diagnosis Areas'
    _rec_name = 'x_name'
    _order = 'x_studio_sequence, x_name'
    _active_name = 'x_active'

    x_name = fields.Char(string='Diagnosis Area', required=True)
    x_studio_description = fields.Char(string='Description')
    x_studio_sequence = fields.Integer(string='Sequence')
    x_active = fields.Boolean(string='Active', default=True)
    x_studio_company_id = fields.Many2one('res.company', string='Company')


class DiagnosisCodes(models.Model):
    _name = 'x_diagnosis_codes'
    _description = 'Diagnosis Codes'
    _rec_name = 'x_name'
    _order = 'x_studio_sequence, x_name'
    _active_name = 'x_active'

    x_name = fields.Char(string='Diagnosis Code', required=True)
    x_studio_description = fields.Char(string='Description')
    x_studio_sequence = fields.Integer(string='Sequence')
    x_studio_diagnosis_area_1 = fields.Many2one('x_diagnosis_areas', string='Diagnosis Area')
    x_active = fields.Boolean(string='Active', default=True)
    x_studio_company_id = fields.Many2one('res.company', string='Company')


class RepairStages(models.Model):
    _name = 'x_repair_stages'
    _description = 'Repair Stages'
    _rec_name = 'x_name'
    _order = 'x_studio_sequence, x_name'
    _active_name = 'x_active'

    x_name = fields.Char(string='Repair Stage', required=True)
    x_studio_description = fields.Char(string='Description')
    x_studio_sequence = fields.Integer(string='Sequence')
    x_active = fields.Boolean(string='Active', default=True)
    x_studio_company_id = fields.Many2one('res.company', string='Company')


class RepairSubReason(models.Model):
    _name = 'x_repair_sub_reason'
    _description = 'Repair Sub Reason'
    _rec_name = 'x_name'
    _order = 'x_studio_sequence, x_name'
    _active_name = 'x_active'

    x_name = fields.Char(string='Sub Reason Code', required=True)
    x_studio_sequence = fields.Integer(string='Sequence')
    x_studio_reason_code = fields.Many2one('x_repair_reason', string='Reason Code')
    x_active = fields.Boolean(string='Active', default=True)
    x_studio_company_id = fields.Many2one('res.company', string='Company')


class Resolutions(models.Model):
    _name = 'x_resolutions'
    _description = 'Resolutions'
    _rec_name = 'x_name'
    _order = 'x_studio_sequence, x_name'
    _active_name = 'x_active'

    x_name = fields.Char(string='Resolution', required=True)
    x_studio_description = fields.Char(string='Description')
    x_studio_sequence = fields.Integer(string='Sequence')
    x_active = fields.Boolean(string='Active', default=True)
    x_studio_company_id = fields.Many2one('res.company', string='Company')


class SymptomAreas(models.Model):
    _name = 'x_symptom_areas'
    _description = 'Symptom Areas'
    _rec_name = 'x_name'
    _order = 'x_studio_sequence, x_name'
    _active_name = 'x_active'

    x_name = fields.Char(string='Symptom Area', required=True)
    x_studio_description = fields.Char(string='Description')
    x_studio_sequence = fields.Integer(string='Sequence')
    x_active = fields.Boolean(string='Active', default=True)
    x_studio_company_id = fields.Many2one('res.company', string='Company')


class SymptomCodes(models.Model):
    _name = 'x_symptom_codes'
    _description = 'Symptom Codes'
    _rec_name = 'x_name'
    _order = 'x_studio_sequence, x_name'
    _active_name = 'x_active'

    x_name = fields.Char(string='Symptom Code', required=True)
    x_studio_description = fields.Char(string='Description')
    x_studio_sequence = fields.Integer(string='Sequence')
    x_studio_symptom_area = fields.Many2one('x_symptom_areas', string='Symptom Area')
    x_active = fields.Boolean(string='Active', default=True)
    x_studio_company_id = fields.Many2one('res.company', string='Company')


class TaskDiagnosis(models.Model):
    _name = 'x_task_diagnosis'
    _description = 'Task Diagnosis'
    _rec_name = 'x_name'
    _order = 'x_studio_sequence, id'
    _active_name = 'x_active'

    x_name = fields.Char(string='Name')
    x_active = fields.Boolean(string='Active', default=True)
    x_studio_sequence = fields.Integer(string='Sequence')
    x_studio_task_id = fields.Many2one('project.task', string='Task', ondelete='cascade')
    x_studio_condition = fields.Many2one('x_conditions', string='Condition')
    x_studio_description = fields.Char(string='Description')
    x_studio_diagnosis_area = fields.Many2one('x_diagnosis_areas', string='Diagnosis Area')
    x_studio_diagnosis_code = fields.Many2one('x_diagnosis_codes', string='Diagnosis Code')
    x_studio_reason = fields.Many2one('x_repair_reason', string='Reason')
    x_studio_sub_reason = fields.Many2one('x_repair_sub_reason', string='Sub Reason')
    x_studio_resolution = fields.Many2one('x_resolutions', string='Resolution')
    x_studio_repair_stage = fields.Many2one('x_repair_stages', string='Repair Stage')
    x_studio_symptom_area = fields.Many2one('x_symptom_areas', string='Symptom Area')
    x_studio_symptom_code = fields.Many2one('x_symptom_codes', string='Symptom Code')
