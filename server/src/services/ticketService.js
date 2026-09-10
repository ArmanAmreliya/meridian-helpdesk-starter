import { query } from '../db/pool.js';
import { config } from '../config.js';

const PAGE_SIZE = 20;

const ALLOWED_SORT_COLUMNS = {
  created_at: 't.created_at',
  updated_at: 't.updated_at',
  priority: 't.priority',
  status: 't.status',
  id: 't.id',
  subject: 't.subject',
};
const ALLOWED_ORDERS = ['ASC', 'DESC'];

const SLA_TARGET_HOURS_SQL = `(CASE t.priority WHEN 'P1' THEN ${config.slaTargets.P1 || 4} WHEN 'P2' THEN ${config.slaTargets.P2 || 24} WHEN 'P3' THEN ${config.slaTargets.P3 || 72} ELSE 72 END)`;

const SLA_BREACHED_SQL = `(CASE WHEN resp.first_response_at IS NOT NULL THEN resp.first_response_at > DATE_ADD(t.created_at, INTERVAL ${SLA_TARGET_HOURS_SQL} HOUR) ELSE NOW() > DATE_ADD(t.created_at, INTERVAL ${SLA_TARGET_HOURS_SQL} HOUR) END)`;

const FIRST_RESPONSE_SUBQUERY = `LEFT JOIN (
  SELECT c.ticket_id, MIN(c.created_at) AS first_response_at
    FROM comments c
    JOIN users u ON u.id = c.author_id
   WHERE u.role IN ('agent', 'admin') AND c.is_internal = 0
   GROUP BY c.ticket_id
) resp ON resp.ticket_id = t.id`;

/**
 * Paginated ticket list for the current organisation.
 *
 * Supports free-text search on subject, filtering by status, priority, and SLA breach status,
 * and sorting by any column the UI exposes in its dropdown.
 */
export async function listTickets({ orgId, page = 1, search = '', status, priority, sortBy = 'created_at', order = 'desc', breached }) {
  const where = ['t.org_id = ?'];
  const params = [orgId];

  if (search) {
    where.push('t.subject LIKE ?');
    params.push(`%${search}%`);
  }
  if (status) {
    where.push('t.status = ?');
    params.push(status);
  }
  if (priority) {
    where.push('t.priority = ?');
    params.push(priority);
  }
  if (breached === 'true' || breached === '1' || breached === true) {
    where.push(`${SLA_BREACHED_SQL} = 1`);
  }

  const whereSql = where.join(' AND ');
  const pageNum = Math.max(1, Number(page) || 1);
  const offset = (pageNum - 1) * PAGE_SIZE;

  const sortCol = ALLOWED_SORT_COLUMNS[sortBy] || 't.created_at';
  const sortOrder = ALLOWED_ORDERS.includes(String(order).toUpperCase()) ? String(order).toUpperCase() : 'DESC';

  const rows = await query(
    `SELECT t.id, t.subject, t.status, t.priority, t.created_at, t.updated_at,
            t.assignee_id, u.name AS assignee_name, r.name AS requester_name,
            ${SLA_TARGET_HOURS_SQL} AS sla_target_hours,
            resp.first_response_at,
            (${SLA_BREACHED_SQL} = 1) AS is_breached
       FROM tickets t
       ${FIRST_RESPONSE_SUBQUERY}
       LEFT JOIN users u ON u.id = t.assignee_id
       JOIN users r ON r.id = t.requester_id
      WHERE ${whereSql}
      ORDER BY ${sortCol} ${sortOrder}
      LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, offset]
  );

  // Attach the comment count each row needs for the list badge, and normalize SLA fields.
  for (const row of rows) {
    const [{ c }] = await query('SELECT COUNT(*) AS c FROM comments WHERE ticket_id = ?', [row.id]);
    row.comment_count = c;
    row.is_breached = Boolean(row.is_breached);
    row.sla_target_hours = Number(row.sla_target_hours);
  }

  const [{ total }] = await query(
    `SELECT COUNT(*) AS total
       FROM tickets t
       ${FIRST_RESPONSE_SUBQUERY}
      WHERE ${whereSql}`,
    params
  );

  return { rows, total, page: pageNum, pageSize: PAGE_SIZE };
}

export async function getTicketById(id, orgId = null) {
  const where = ['t.id = ?'];
  const params = [id];
  if (orgId !== null && orgId !== undefined) {
    where.push('t.org_id = ?');
    params.push(orgId);
  }

  const rows = await query(
    `SELECT t.*, u.name AS assignee_name, r.name AS requester_name, r.email AS requester_email,
            ${SLA_TARGET_HOURS_SQL} AS sla_target_hours,
            resp.first_response_at,
            (${SLA_BREACHED_SQL} = 1) AS is_breached
       FROM tickets t
       ${FIRST_RESPONSE_SUBQUERY}
       LEFT JOIN users u ON u.id = t.assignee_id
       JOIN users r ON r.id = t.requester_id
      WHERE ${where.join(' AND ')}`,
    params
  );

  if (!rows[0]) return null;
  const row = rows[0];
  row.is_breached = Boolean(row.is_breached);
  row.sla_target_hours = Number(row.sla_target_hours);
  return row;
}

export async function listComments(ticketId) {
  return query(
    `SELECT c.id, c.body, c.is_internal, c.created_at, u.name AS author_name, u.role AS author_role
       FROM comments c
       JOIN users u ON u.id = c.author_id
      WHERE c.ticket_id = ?
      ORDER BY c.created_at ASC`,
    [ticketId]
  );
}

export async function createTicket({ orgId, subject, body, priority, requesterId }) {
  const result = await query(
    `INSERT INTO tickets (org_id, subject, body, priority, requester_id)
     VALUES (?, ?, ?, ?, ?)`,
    [orgId, subject, body, priority, requesterId]
  );
  return getTicketById(result.insertId, orgId);
}

export async function assignTicket(ticketId, assigneeId, orgId = null) {
  const ticket = await getTicketById(ticketId, orgId);
  if (!ticket) return null;

  if (ticket.assignee_id) {
    return { conflict: true, ticket };
  }

  // Look up the agent so the response carries a display name for the toast.
  const [agent] = await query('SELECT id, name FROM users WHERE id = ?', [assigneeId]);

  await query('UPDATE tickets SET assignee_id = ?, status = ? WHERE id = ?', [assigneeId, 'pending', ticketId]);
  return { conflict: false, assignedTo: agent, ticket: await getTicketById(ticketId, orgId) };
}

export async function deleteTicket(id, orgId = null) {
  if (orgId !== null && orgId !== undefined) {
    await query('DELETE FROM tickets WHERE id = ? AND org_id = ?', [id, orgId]);
  } else {
    await query('DELETE FROM tickets WHERE id = ?', [id]);
  }
}
