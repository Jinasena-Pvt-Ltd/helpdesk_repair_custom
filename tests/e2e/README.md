# E2E Playwright Tests — helpdesk_repair_custom

Playwright-based end-to-end smoke tests for the RUG repair flows.

## Prerequisites

- Node.js 18+
- Odoo 17 running at `http://localhost:8169` (container: `odoo17`)
- Playwright installed: `cd tests/e2e && npm install`

## Test files

| File | Flow | Status |
|---|---|---|
| `rug_flow_factory_test.js` | Factory Repair full flow (STEP A–I) | In Progress (green A–D2) |
| `rug_flow_phase2_test.js` | Centre Repair Phase 2 | 24/27 passing |
| `rug_flow_test.js` | Phase 1 ticket creation smoke | Passing |

## Run

```bash
# 1. Copy helpers into the container
docker cp helpers/setup_factory_master_data.py odoo17:/tmp/
docker cp helpers/create_rug_delivery.py odoo17:/tmp/
docker cp helpers/create_rug_factory_ticket.py odoo17:/tmp/
docker cp helpers/create_rug_receipt.py odoo17:/tmp/
docker cp helpers/create_fsm_task.py odoo17:/tmp/

# 2. Seed master data (idempotent)
docker exec odoo17 python3 /tmp/setup_factory_master_data.py

# 3. Run test
cd tests/e2e
timeout 540 node rug_flow_factory_test.js
```

## Helper scripts (helpers/)

These Python scripts run inside the `odoo17` container via `docker exec` and perform ORM operations that are unreliable or impossible via headless Playwright:

| Script | Purpose |
|---|---|
| `setup_factory_master_data.py` | Idempotent master data seed (ticket type, accounts, user locations) |
| `create_rug_delivery.py` | Create + validate outgoing delivery for a new serial number |
| `create_rug_factory_ticket.py` | Create helpdesk ticket via ORM (create→write pattern for sync hooks) |
| `create_rug_receipt.py` | Replicate SA1009: create + validate return receipt picking |
| `create_fsm_task.py` | Create FSM task via `helpdesk.create.fsm.task` wizard ORM |
