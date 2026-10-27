// S9.5-T2 — local Docker rehearsal of the owner SQL (forward + ROLLBACK
// templates), rendered by generate-t2-sql.mjs with a synthetic fixture snapshot.
//
// LOCAL ONLY: every statement goes through `docker exec <local db container>
// psql` — no URL, no key, no remote path exists in this script.
// Plain Node ESM (house rule: never tsx).
//
//   node scripts/s9-5/t2-local-rehearsal.mjs
//
// Cases: tampered snapshot aborts with zero writes · happy path · re-run is an
// 'already applied' no-op · mixed state aborts · rollback refused while a
// saturday_monthly event exists · rollback · rollback re-run no-op.
// Fixture rows are [SYNTH]/test.invalid only and are removed at start and end.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { TEMPLATES, renderSql } from './generate-t2-sql.mjs'

const CONTAINER = 'supabase_db_project37-rewrite'
const NOTE = 'S9.5: moved to 2nd Saturday from Nov 2026'
const TRIGGER_FWD = 's9_5_t2_retire_friday_series'
const TRIGGER_RB = 's9_5_t2_retire_friday_series_rollback'

const id = (n) => `95950000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ADMIN = id(1)
const PERSON = id(2)
const FRIDAY = id(10)
const OTHER = id(20)
const SATURDAY = id(30)
const PRE_NOV = id(100)
const FRIDAY_DATES = [
  '2026-11-13', '2026-12-11', '2027-01-08', '2027-02-12', '2027-03-12', '2027-04-09',
  '2027-05-14', '2027-06-11', '2027-07-09', '2027-08-13', '2027-09-10', '2027-10-08',
]
const NOV_IDS = FRIDAY_DATES.map((_, i) => id(101 + i))
const OTHER_IDS = [id(201), id(202), id(203)]
const ALL_FIXTURE_EVENTS = [FRIDAY, OTHER, SATURDAY]

function psql(sql) {
  const r = spawnSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres',
    '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' })
  if (r.error) throw r.error
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }
}

function q(sql) {
  const r = psql(sql)
  if (r.code !== 0) throw new Error(`query failed: ${r.err}\n${sql}`)
  return r.out
}

let failures = 0
function check(label, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
  if (!cond) failures++
}

const list = (ids) => ids.map((x) => `'${x}'`).join(',')

function cleanup() {
  q(`
    DELETE FROM audit_log WHERE details_json->>'trigger' IN ('${TRIGGER_FWD}', '${TRIGGER_RB}')
      AND entity_id IN (${list([FRIDAY, ...NOV_IDS])});
    DELETE FROM events WHERE id IN (${list(ALL_FIXTURE_EVENTS)});
    DELETE FROM people WHERE id = '${PERSON}';
    DELETE FROM app_users WHERE id = '${ADMIN}';
  `)
}

function seed() {
  const novRows = FRIDAY_DATES.map((d, i) =>
    `('${NOV_IDS[i]}', '${FRIDAY}', TIMESTAMPTZ '${d} 18:00:00+07', 'S95 Rehearsal Friday', 'scheduled')`).join(',\n      ')
  q(`
    INSERT INTO app_users (id, email, full_name, role, active)
      VALUES ('${ADMIN}', 's95-rehearsal@test.invalid', '[SYNTH] S95 rehearsal admin', 'admin', true);
    INSERT INTO people (id, phone_e164, full_name, nickname)
      VALUES ('${PERSON}', '+629990095951', '[SYNTH] S95 rehearsal person', 'synth');
    INSERT INTO events (id, name, event_type, start_date, start_time, duration_min, recurrence_rule, active, created_by)
      VALUES ('${FRIDAY}', 'S95 Rehearsal Friday', 'friday_monthly', '2026-07-10', '18:00', 120, 'FREQ=MONTHLY;BYDAY=2FR', true, '${ADMIN}'),
             ('${OTHER}',  'S95 Rehearsal Sunday', 'sunday_monthly', '2026-07-05', '15:00', 120, 'FREQ=MONTHLY;BYDAY=1SU', true, '${ADMIN}');
    INSERT INTO event_instances (id, event_id, scheduled_at, event_name_snapshot, status) VALUES
      ('${PRE_NOV}', '${FRIDAY}', TIMESTAMPTZ '2026-10-09 18:00:00+07', 'S95 Rehearsal Friday', 'completed'),
      ${novRows},
      ('${OTHER_IDS[0]}', '${OTHER}', TIMESTAMPTZ '2026-10-04 15:00:00+07', 'S95 Rehearsal Sunday', 'completed'),
      ('${OTHER_IDS[1]}', '${OTHER}', TIMESTAMPTZ '2026-11-01 15:00:00+07', 'S95 Rehearsal Sunday', 'scheduled'),
      ('${OTHER_IDS[2]}', '${OTHER}', TIMESTAMPTZ '2026-12-06 15:00:00+07', 'S95 Rehearsal Sunday', 'cancelled');
    INSERT INTO event_rsvp_links (event_instance_id, created_by) VALUES ('${NOV_IDS[0]}', '${ADMIN}');
    INSERT INTO attendance (event_instance_id, person_id, checked_in_by) VALUES ('${NOV_IDS[0]}', '${PERSON}', '${ADMIN}');
  `)
}

/** Fixture snapshot: first instance carries 1 link + 1 attendance; half the
 *  rows pin wib_date, half leave it null (date SET only) — both paths exercised. */
function snapshot() {
  return {
    event: {
      id: FRIDAY, name: 'S95 Rehearsal Friday', event_type: 'friday_monthly',
      recurrence_rule: 'FREQ=MONTHLY;BYDAY=2FR', active: true,
    },
    expected_dates: FRIDAY_DATES,
    instances: NOV_IDS.map((x, i) => ({
      id: x,
      wib_date: i % 2 === 0 ? FRIDAY_DATES[i] : null,
      links: i === 0 ? 1 : 0, rsvps: 0, invitations: 0, attendance: i === 0 ? 1 : 0, child_attendance: 0,
    })),
  }
}

function state() {
  const [active, sched, cancelledNoted, preNov, otherVec, auditFwd, auditRb, auditNullActor] = q(`
    SELECT (SELECT active FROM events WHERE id = '${FRIDAY}'),
           (SELECT count(*) FROM event_instances WHERE id IN (${list(NOV_IDS)}) AND status = 'scheduled' AND notes IS NULL),
           (SELECT count(*) FROM event_instances WHERE id IN (${list(NOV_IDS)}) AND status = 'cancelled' AND notes = '${NOTE}'),
           (SELECT status FROM event_instances WHERE id = '${PRE_NOV}'),
           (SELECT string_agg(status::text, ',' ORDER BY id) FROM event_instances WHERE event_id = '${OTHER}'),
           (SELECT count(*) FROM audit_log WHERE details_json->>'trigger' = '${TRIGGER_FWD}' AND entity_id IN (${list([FRIDAY, ...NOV_IDS])})),
           (SELECT count(*) FROM audit_log WHERE details_json->>'trigger' = '${TRIGGER_RB}' AND entity_id IN (${list([FRIDAY, ...NOV_IDS])})),
           (SELECT count(*) FROM audit_log WHERE details_json->>'trigger' IN ('${TRIGGER_FWD}', '${TRIGGER_RB}')
              AND entity_id IN (${list([FRIDAY, ...NOV_IDS])}) AND actor_user_id IS NULL);
  `).split('|')
  return {
    active: active === 't', sched: Number(sched), cancelledNoted: Number(cancelledNoted), preNov, otherVec,
    auditFwd: Number(auditFwd), auditRb: Number(auditRb), auditNullActor: Number(auditNullActor),
  }
}

const OTHER_VEC = 'completed,scheduled,cancelled'
const fwdTemplate = readFileSync(TEMPLATES.forward, 'utf8')
const rbTemplate = readFileSync(TEMPLATES.rollback, 'utf8')
const fwd = (snap) => renderSql(fwdTemplate, 'local', snap)
const rb = (snap) => renderSql(rbTemplate, 'local', snap)

const preexistingSat = Number(q(`SELECT count(*) FROM events WHERE event_type::text = 'saturday_monthly' AND id <> '${SATURDAY}'`))
if (preexistingSat > 0) {
  console.error(`ABORT: ${preexistingSat} non-fixture saturday_monthly event(s) in the local DB — rollback cases would be refused`)
  process.exit(2)
}

cleanup()
seed()
try {
  let s = state()
  check('seed: friday active, 12 scheduled, pre-Nov completed, other vector', s.active && s.sched === 12 && s.preNov === 'completed' && s.otherVec === OTHER_VEC)

  // 1. Tampered snapshot — one child count changed → abort, zero writes
  const tampered = snapshot()
  tampered.instances[0].attendance = 0
  let r = psql(fwd(tampered))
  s = state()
  check('tampered: psql exit != 0', r.code !== 0, `exit=${r.code}`)
  check('tampered: error names the instance', /differ from snapshot/.test(r.err) && r.err.includes(NOV_IDS[0]), r.err.split('\n').find((l) => l.includes('ERROR')) ?? '')
  check('tampered: zero writes', s.active && s.sched === 12 && s.cancelledNoted === 0 && s.auditFwd === 0)

  // 2. Happy path
  r = psql(fwd(snapshot()))
  s = state()
  check('apply: psql exit 0', r.code === 0, r.err.split('\n').find((l) => l.includes('NOTICE')) ?? r.err)
  check('apply: event inactive', !s.active)
  check('apply: 12 cancelled with note, 0 scheduled', s.cancelledNoted === 12 && s.sched === 0)
  check('apply: pre-Nov instance untouched', s.preNov === 'completed')
  check('apply: other event vector unchanged', s.otherVec === OTHER_VEC, s.otherVec)
  check('apply: 13 audit rows (12 cancel + 1 update), all NULL actor', s.auditFwd === 13 && s.auditNullActor === 13, `fwd=${s.auditFwd} nullActor=${s.auditNullActor}`)
  check('apply: link + attendance kept', q(`SELECT (SELECT count(*) FROM event_rsvp_links WHERE event_instance_id='${NOV_IDS[0]}') || ',' || (SELECT count(*) FROM attendance WHERE event_instance_id='${NOV_IDS[0]}')`) === '1,1')

  // 3. Re-run → 'already applied', no writes
  r = psql(fwd(snapshot()))
  s = state()
  check('re-run: exit 0 + NOTICE already applied', r.code === 0 && /already applied/.test(r.err), r.err.split('\n').find((l) => l.includes('NOTICE')) ?? '')
  check('re-run: no new audit rows', s.auditFwd === 13)

  // 4. Rollback refused while a saturday_monthly event exists
  q(`INSERT INTO events (id, name, event_type, start_date, start_time, duration_min, recurrence_rule, active, created_by)
       VALUES ('${SATURDAY}', 'S95 Rehearsal Saturday', 'saturday_monthly', '2026-11-14', '15:00', 180, 'FREQ=MONTHLY;BYDAY=2SA', true, '${ADMIN}')`)
  r = psql(rb(snapshot()))
  s = state()
  check('rollback w/ Saturday series: refused', r.code !== 0 && /rollback refused/.test(r.err), r.err.split('\n').find((l) => l.includes('ERROR')) ?? '')
  check('rollback w/ Saturday series: zero writes', !s.active && s.cancelledNoted === 12 && s.auditRb === 0)
  q(`DELETE FROM events WHERE id = '${SATURDAY}'`)

  // 5. Rollback
  r = psql(rb(snapshot()))
  s = state()
  check('rollback: psql exit 0', r.code === 0, r.err.split('\n').find((l) => l.includes('NOTICE')) ?? r.err)
  check('rollback: event active, 12 scheduled notes NULL', s.active && s.sched === 12 && s.cancelledNoted === 0)
  check('rollback: pre-Nov + other vector unchanged', s.preNov === 'completed' && s.otherVec === OTHER_VEC)
  check('rollback: 13 audit rows, NULL actor', s.auditRb === 13 && s.auditNullActor === 26, `rb=${s.auditRb} nullActor=${s.auditNullActor}`)

  // 6. Rollback re-run → no-op
  r = psql(rb(snapshot()))
  s = state()
  check('rollback re-run: NOTICE already rolled back, no writes', r.code === 0 && /already rolled back/.test(r.err) && s.auditRb === 13)

  // 7. Mixed state → forward aborts, zero writes
  q(`UPDATE event_instances SET status = 'cancelled', notes = '${NOTE}' WHERE id = '${NOV_IDS[5]}'`)
  r = psql(fwd(snapshot()))
  s = state()
  check('mixed state: forward aborts', r.code !== 0 && /mixed state/.test(r.err), r.err.split('\n').find((l) => l.includes('ERROR')) ?? '')
  check('mixed state: zero writes', s.active && s.sched === 11 && s.cancelledNoted === 1 && s.auditFwd === 13)
} finally {
  cleanup()
  const residue = q(`SELECT (SELECT count(*) FROM events WHERE id IN (${list(ALL_FIXTURE_EVENTS)}))
                    + (SELECT count(*) FROM event_instances WHERE id IN (${list([PRE_NOV, ...NOV_IDS, ...OTHER_IDS])}))
                    + (SELECT count(*) FROM people WHERE id = '${PERSON}')
                    + (SELECT count(*) FROM app_users WHERE id = '${ADMIN}')
                    + (SELECT count(*) FROM audit_log WHERE entity_id IN (${list([FRIDAY, ...NOV_IDS])}))`)
  check('cleanup: zero residue', residue === '0', `rows=${residue}`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
